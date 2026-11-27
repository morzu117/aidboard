import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG, parseConfig } from '../src/daemon/config.js';
import { findMigrationsDir, migrate, openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { onMemoryEvent } from '../src/daemon/memory/capture.js';
import { MemoryJobs } from '../src/daemon/memory/jobs.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { MemoryWorker } from '../src/daemon/memory/worker.js';
import { issueRunToken } from '../src/daemon/security.js';
import { seedTopic, startTestDaemon, waitFor } from './helpers/daemon.js';

const slug = 'exemple/dev-handoff/tache';
const capture = { ...DEFAULT_CONFIG.memory.capture, enabled: true };
let home: string;
let db: ReturnType<typeof openDb>;
let jobs: MemoryJobs;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aid-capture-'));
  db = openDb(join(home, 'state.db'));
  jobs = new MemoryJobs(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const event = (data: Record<string, unknown> = {}) => ({
  v: 1 as const,
  id: 'event-test',
  ts: new Date().toISOString(),
  source: 'daemon' as const,
  type: 'memory.page' as const,
  data: { slug, author: 'run:run_1', op: 'put', ...data },
});

const rows = (database = db) =>
  database.prepare("SELECT * FROM memory_jobs WHERE kind = 'faits' ORDER BY id").all();

function trigger(data: Record<string, unknown> = {}, config = capture) {
  onMemoryEvent(event(data), { config, jobs, log: console.error });
}

test('un handoff de run est prêt cinq minutes après son écriture', () => {
  const now = new Date(2026, 0, 7, 12);
  vi.setSystemTime(now);
  trigger();
  const runAfter = new Date(now.getTime() + 300_000).toISOString();
  expect(rows()).toEqual([
    expect.objectContaining({ slug, state: 'pending', run_after: runAfter }),
  ]);
  expect(jobs.claim(new Date(now.getTime() + 299_999).toISOString(), false)).toBeUndefined();
  expect(jobs.claim(runAfter, false)).toMatchObject({ kind: 'faits', slug, attempts: 1 });
});

test('trois écritures rapprochées repoussent le même job au dernier délai', () => {
  const now = new Date(2026, 0, 7, 12).getTime();
  vi.setSystemTime(now);
  trigger();
  const [first] = rows();
  vi.setSystemTime(now + 1_000);
  trigger({ op: 'append' });
  vi.setSystemTime(now + 2_000);
  trigger({ op: 'append' });
  expect(rows()).toEqual([
    expect.objectContaining({
      id: (first as { id: string }).id,
      run_after: new Date(now + 302_000).toISOString(),
    }),
  ]);
});

test.each([
  { author: 'admin' },
  { author: 'maintenance' },
  { author: 'import' },
  { author: 'reindex' },
  { slug: 'exemple/plan/tache' },
  { slug: 'lesson/review/tache' },
  { slug: 'exemple/dev-handoff/tache/suite' },
  { op: 'rm' },
  { op: 'delete' },
  { op: 'inconnue' },
])('événement ignoré (%j)', (data) => {
  trigger(data);
  expect(rows()).toEqual([]);
});

test('capture éteinte ou autre type : aucun job', () => {
  trigger({}, { ...capture, enabled: false });
  onMemoryEvent({ ...event(), type: 'memory.decision' }, { jobs, config: capture, log: vi.fn() });
  expect(rows()).toEqual([]);
});

test('plafond depuis minuit local, avec report autorisé', () => {
  const noon = new Date(2026, 0, 7, 12).getTime();
  const config = { ...capture, maxPerDay: 2 };
  vi.setSystemTime(new Date(2026, 0, 6, 23, 59));
  trigger({ slug: 'exemple/review/hier' }, config);
  vi.setSystemTime(noon);
  trigger({}, config);
  trigger({ slug: 'exemple/review/deux' }, config);
  const before = rows();
  expect(before).toHaveLength(3);
  trigger({ slug: 'exemple/review/trois' }, config);
  expect(rows()).toEqual(before);
  vi.setSystemTime(noon + 1_000);
  trigger({ op: 'append' }, config);
  expect(rows()).toEqual([
    before[0],
    expect.objectContaining({ slug, run_after: new Date(noon + 301_000).toISOString() }),
    before[2],
  ]);
});

test('un job en cours laisse enfiler une nouvelle écriture', () => {
  const runAfter = new Date().toISOString();
  const first = jobs.enqueueAfter('faits', slug, runAfter);
  expect(first).toEqual(expect.any(String));
  expect(jobs.claim(runAfter)?.id).toBe(first);
  trigger();
  expect(rows()).toEqual([
    expect.objectContaining({ id: first, state: 'running' }),
    expect.objectContaining({ state: 'pending' }),
  ]);
});

test('une erreur de capture est journalisée sans interrompre append', () => {
  const store = new EventStore(db);
  const log = vi.fn();
  vi.spyOn(jobs, 'countCreatedSince').mockImplementation(() => {
    throw new Error('file indisponible');
  });
  store.on('event', (e) => onMemoryEvent(e, { config: capture, jobs, log }));
  expect(store.append(event()).id).toBe('event-test');
  expect(store.since(null)).toHaveLength(1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('file indisponible'));
});

test.each([true, false])(
  'le worker traite le job avec deps.faits présent = %s',
  async (present) => {
    const id = jobs.enqueueAfter('faits', slug, new Date().toISOString())!;
    const faits = vi.fn(async () => {});
    const worker = new MemoryWorker({
      jobs,
      store: new MemoryStore(db),
      log: vi.fn(),
      backoffMs: [],
      faits: present ? faits : undefined,
    });
    worker.start();
    try {
      const state = present ? 'done' : 'failed';
      await waitFor(() => jobs.get(id)?.state === state);
      if (present) {
        expect(faits).toHaveBeenCalledWith({ id, kind: 'faits', slug, attempts: 1 });
      } else {
        expect(jobs.get(id)?.error).toBe('extraction de faits non disponible');
      }
    } finally {
      await worker.stop();
    }
  },
);

test('le PUT authentifié par un token de run déclenche la capture du daemon', async () => {
  const t = await startTestDaemon(join(home, 'daemon'), {
    memory: { chatModel: { chat: async () => '{"faits":[]}' } },
    config: {
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: { ...DEFAULT_CONFIG.memory.embeddings, provider: 'off' },
        capture,
      },
    },
  });
  try {
    seedTopic(t.db);
    t.db.prepare("UPDATE workspaces SET namespace = 'exemple' WHERE id = 'ws_1'").run();
    const before = Date.now();
    const reply = await t.d.app.inject({
      method: 'PUT',
      url: `/api/memory/pages/${slug}`,
      headers: { ...t.headers, authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}` },
      payload: { text: '# Handoff' },
    });
    expect(reply.statusCode).toBe(201);
    expect(rows(t.db)).toEqual([expect.objectContaining({ slug, state: 'pending' })]);
    const [{ run_after }] = rows(t.db) as [{ run_after: string }];
    expect(Date.parse(run_after)).toBeGreaterThanOrEqual(before + 300_000);
    expect(Date.parse(run_after)).toBeLessThanOrEqual(Date.now() + 300_000);
  } finally {
    await t.d.stop();
  }
});

test('valeurs par défaut et surcharge de memory.capture', () => {
  expect(parseConfig('').memory.capture).toEqual({
    enabled: false,
    delayMinutes: 5,
    maxPerDay: 30,
  });
  expect(
    parseConfig('memory: { capture: { enabled: true, delayMinutes: 1, maxPerDay: 2 } }').memory
      .capture,
  ).toEqual({ enabled: true, delayMinutes: 1, maxPerDay: 2 });
});

test.each([
  ['inconnue: 3', 'clé inconnue dans config.yaml : memory.capture.inconnue'],
  ['delayMinutes: 1.5', 'memory.capture.delayMinutes doit être un entier'],
  ['maxPerDay: 0', 'memory.capture.maxPerDay doit être un entier'],
  ['enabled: "true"', 'memory.capture.enabled doit être true ou false'],
])('memory.capture refuse %s', (value, message) => {
  expect(() => parseConfig(`memory: { capture: { ${value} } }`)).toThrow(message);
});

test('039 conserve les jobs de 038, leur délai et leur index', () => {
  const migrations = findMigrationsDir();
  for (const file of readdirSync(migrations).filter((name) => Number(name.slice(0, 3)) <= 38)) {
    copyFileSync(join(migrations, file), join(home, file));
  }
  const previous = openDb(join(home, 'previous.db'), home);
  try {
    expect(previous.pragma('user_version', { simple: true })).toBe(38);
    previous.exec(`
      INSERT INTO memory_jobs VALUES
        ('j1', 'embed', 'exemple/plan/a', 'done', 1, NULL, 't1', 't2', NULL),
        ('j2', 'retro', 'tp_1', 'pending', 2, 'erreur', 't1', 't2', 't3');
    `);
    const jobsBefore = previous.prepare('SELECT * FROM memory_jobs ORDER BY id').all();
    const indexes = () => previous.pragma('index_list(memory_jobs)');
    const indexesBefore = indexes();
    migrate(previous, migrations);
    expect(previous.pragma('user_version', { simple: true })).toBe(40);
    expect(previous.prepare('SELECT * FROM memory_jobs ORDER BY id').all()).toEqual(jobsBefore);
    expect(indexes()).toEqual(indexesBefore);
  } finally {
    previous.close();
  }
});

test.each([
  { enabled: true, plafond: 4 },
  { enabled: false, plafond: 0 },
])('santé des faits avec capture enabled=$enabled', async ({ enabled, plafond }) => {
  const t = await startTestDaemon(join(home, 'daemon'), {
    memory: { chatModel: { chat: async () => '{"faits":[]}' } },
    config: {
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: { ...DEFAULT_CONFIG.memory.embeddings, provider: 'off' },
        capture: { ...capture, enabled, maxPerDay: 4 },
      },
    },
  });
  try {
    const store = t.d.memory.store;
    store.put(
      'exemple/fait/tache.un',
      '---\nstatut: candidat\n---\nUn',
      { kind: 'create' },
      'maintenance',
    );
    store.put('exemple/fait/tache.deux', 'Deux', { kind: 'create' }, 'admin');
    store.put(
      'autre/review/tache',
      '---\nstatut: candidat\n---\nTrois',
      { kind: 'create' },
      'admin',
    );

    vi.setSystemTime(new Date(2026, 0, 8, 12));
    const midnight = new Date(2026, 0, 8);
    const insert = t.db.prepare(
      "INSERT INTO memory_jobs (id, kind, slug, state, created_at, updated_at) VALUES (?, ?, ?, 'done', ?, ?)",
    );
    const yesterday = new Date(midnight.getTime() - 1).toISOString();
    const today = midnight.toISOString();
    insert.run('veille', 'faits', slug, yesterday, yesterday);
    insert.run('jour', 'faits', slug, today, today);
    insert.run('autre', 'embed', slug, today, today);

    const reply = await t.d.app.inject({
      method: 'GET',
      url: '/api/memory/health',
      headers: t.headers,
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().faits).toEqual({ candidats: 2, aujourdhui: 1, plafond });
  } finally {
    await t.d.stop();
  }
});
