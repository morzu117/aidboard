import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkspaceQueue } from '../src/daemon/actions/queue.js';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { finDeSource, runFaitsJob } from '../src/daemon/memory/faits.js';
import { MemoryJobs } from '../src/daemon/memory/jobs.js';
import { MemoryMirror } from '../src/daemon/memory/mirror.js';
import { MemoryService } from '../src/daemon/memory/service.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { MemoryWorker } from '../src/daemon/memory/worker.js';
import { issueRunToken } from '../src/daemon/security.js';
import { seedTopic, startTestDaemon, waitFor } from './helpers/daemon.js';

const source = 'exemple/dev-handoff/tache';
const prefix = 'exemple/fait/tache.';
const context = { author: 'run:run_1', topicId: 'tp_1', runId: 'run_1', agentId: 'ag_1' };
const create = { kind: 'create' } as const;
const fact = (slug: string) => ({ slug, title: `Titre ${slug}`, body: `Constat ${slug}.` });
const three = ['un', 'deux', 'trois'].map(fact);
const privateHost = 'machine.exemple.invalid';

let home: string;
let db: ReturnType<typeof openDb>;
let events: EventStore;
let store: MemoryStore;
let memory: MemoryService;
let jobs: MemoryJobs;

const chat = vi.fn<(system: string, message: string) => Promise<string>>();
const log = vi.fn<(line: string) => void>();
const run = (job: Parameters<typeof runFaitsJob>[0]) =>
  runFaitsJob(job, { memory, events, model: { chat }, hotesPrives: [privateHost], log });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aid-faits-'));
  db = openDb(join(home, 'state.db'));
  events = new EventStore(db);
  store = new MemoryStore(db);
  jobs = new MemoryJobs(db);
  const mirror = new MemoryMirror(join(home, 'memory'));
  vi.spyOn(mirror, 'scheduleCommit').mockImplementation(() => {});
  memory = new MemoryService({ store, mirror, events, queue: new WorkspaceQueue() });
  chat.mockReset();
  log.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

async function throughWorker() {
  const id = jobs.enqueueAfter('faits', source, new Date().toISOString())!;
  const worker = new MemoryWorker({
    jobs,
    store,
    log,
    backoffMs: [0],
    faits: async (job) => {
      await run(job);
    },
  });
  worker.start();
  try {
    return await waitFor(() => {
      const row = jobs.get(id);
      return row && (row.state === 'done' || row.state === 'failed') && row;
    });
  } finally {
    await worker.stop();
  }
}

const job = { id: 'job-test', kind: 'faits', slug: source, attempts: 1 } as const;

test('aucun fait est un résultat normal, en état done', async () => {
  await memory.put(source, 'Corps source.', create, context);
  chat.mockResolvedValue('{"faits":[]}');
  expect(await throughWorker()).toMatchObject({ state: 'done', attempts: 1 });
  expect(store.list(prefix)).toEqual([]);
});

test('la révision courante et le dernier contexte renseigné donnent trois faits', async () => {
  await memory.put(source, 'Ancien corps.', create, { ...context, agentId: 'ag_0' });
  await memory.put(source, 'Corps courant.', { kind: 'append' }, context);
  await memory.put(source, 'Ajout admin.', { kind: 'append' }, { author: 'admin' });
  chat.mockResolvedValue(JSON.stringify({ faits: three }));

  expect(await run(job)).toBe(3);
  expect(chat).toHaveBeenCalledWith(
    expect.stringContaining('faits nouveaux'),
    `${store.get(source)!.body}\n\nTitres des faits déjà écrits :\n[]`,
  );
  for (const { slug, title, body } of three) {
    const target = prefix + slug;
    expect(store.get(target)).toMatchObject({ body, author: 'maintenance', revision: 1 });
    expect(store.get(target)?.frontmatter).toEqual({
      statut: 'candidat',
      title,
      cycle: 'exemple/tache',
      liens: { issu_de: [source] },
    });
    expect(events.since(null).find((e) => e.data.slug === target)).toMatchObject({
      type: 'memory.page',
      topicId: context.topicId,
      runId: context.runId,
      agentId: context.agentId,
      data: { author: 'maintenance', op: 'put' },
    });
  }
});

test.each([
  [{ ...fact('un'), statut: 'candidat' }],
  [fact('avec.point')],
  [{ ...fact('un'), title: ' ' }],
  [{ ...fact('un'), body: 'ligne\r\n'.repeat(8) + 'suite' }],
  [...three, fact('quatre')],
])('une réponse invalide échoue puis est réessayée (%j)', async (...faits) => {
  await memory.put(source, 'Corps source.', create, context);
  chat.mockResolvedValueOnce(JSON.stringify({ faits })).mockResolvedValueOnce('{"faits":[]}');
  expect(await throughWorker()).toMatchObject({ state: 'done', attempts: 2 });
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining('tentative 1 : extraction de faits : forme JSON invalide'),
  );
  expect(chat).toHaveBeenCalledTimes(2);
  expect(store.list(prefix)).toEqual([]);
});

test('écarte les slugs pris, répétés et trop longs', async () => {
  await memory.put(source, 'Corps source.', create, context);
  store.put(prefix + 'un', '# Titre existant', create, 'maintenance');
  chat.mockResolvedValueOnce(JSON.stringify({ faits: [fact('un'), fact('deux'), fact('deux')] }));
  expect(await run(job)).toBe(1);
  expect(chat).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.stringContaining('["Titre existant"]'),
  );
  chat.mockResolvedValueOnce(JSON.stringify({ faits: [fact('a'.repeat(300)), fact('trois')] }));
  expect(await run(job)).toBe(1);
  expect(store.list(prefix)).toEqual(['deux', 'trois', 'un'].map((slug) => prefix + slug));
  expect(store.get(prefix + 'un')?.title).toBe('Titre existant');
});

test('un conflit de création laisse écrire les autres faits', async () => {
  await memory.put(source, 'Corps source.', create, context);
  const put = memory.put.bind(memory);
  vi.spyOn(memory, 'put').mockImplementationOnce((slug, text, mode, ctx) => {
    store.put(slug, '# Écriture concurrente', create, 'maintenance');
    return put(slug, text, mode, ctx);
  });
  chat.mockResolvedValue(JSON.stringify({ faits: three }));
  expect(await run(job)).toBe(2);
  expect(store.get(prefix + 'un')?.title).toBe('Écriture concurrente');
  expect(store.list(prefix)).toHaveLength(3);
});

test('à neuf faits il reste une place, à dix le modèle ne reçoit aucun nouvel appel', async () => {
  await memory.put(source, 'Corps source.', create, context);
  for (let i = 0; i < 9; i++) store.put(prefix + i, 'Fait existant.', create, 'maintenance');
  chat.mockResolvedValue(JSON.stringify({ faits: three }));
  expect(await run(job)).toBe(1);
  expect(store.list(prefix)).toHaveLength(10);
  expect(await run(job)).toBe(0);
  expect(chat).toHaveBeenCalledTimes(1);
});

test('un hôte privé est refusé sans copie du texte ni nouvelle trace en base', async () => {
  await memory.put(source, `Hôte : ${privateHost}`, create, context);
  const snapshot = () => ({
    errors: db.prepare('SELECT error FROM memory_jobs WHERE error IS NOT NULL').all(),
    proposals: db.prepare('SELECT * FROM memory_proposals').all(),
    facts: db.prepare("SELECT * FROM memory_pages WHERE slug LIKE 'exemple/fait/%'").all(),
    events: events.since(null).slice(1),
  });
  const before = snapshot();
  expect(await throughWorker()).toMatchObject({ state: 'done', attempts: 1, error: null });
  expect(chat).not.toHaveBeenCalled();
  expect(log.mock.calls).toEqual([[`faits de ${source} non extraits : refus:hôte privé`]]);
  expect(snapshot()).toEqual(before);
});

test('une source supprimée ne produit aucun fait', async () => {
  await memory.put(source, 'Corps source.', create, context);
  await memory.remove(source, context);
  expect(await throughWorker()).toMatchObject({ state: 'done', attempts: 1 });
  expect(chat).not.toHaveBeenCalled();
  expect(store.list(prefix)).toEqual([]);
});

async function withCaptureDaemon(
  withModel: boolean,
  check: (daemon: Awaited<ReturnType<typeof startTestDaemon>>) => Promise<void>,
) {
  const t = await startTestDaemon(join(home, 'daemon'), {
    config: {
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: { ...DEFAULT_CONFIG.memory.embeddings, provider: 'off' },
        capture: { enabled: true, delayMinutes: 1, maxPerDay: 30 },
      },
    },
    memory: { pollMs: 10, chatModel: withModel ? { chat } : undefined },
  });
  try {
    seedTopic(t.db);
    t.db.prepare("UPDATE workspaces SET namespace = 'exemple' WHERE id = 'ws_1'").run();
    const response = await t.d.app.inject({
      method: 'PUT',
      url: `/api/memory/pages/${source}`,
      headers: { ...t.headers, authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}` },
      payload: { text: 'Corps du handoff.' },
    });
    expect(response.statusCode).toBe(201);
    await check(t);
  } finally {
    await t.d.stop();
  }
}

test('le PUT du run produit des faits par le daemon sans nouvelle capture', async () => {
  chat.mockResolvedValue(JSON.stringify({ faits: three }));
  await withCaptureDaemon(true, async (t) => {
    const rows = () =>
      t.db.prepare("SELECT slug, state, run_after FROM memory_jobs WHERE kind = 'faits'").all() as {
        slug: string;
        state: string;
        run_after: string;
      }[];
    const pending = rows();
    expect(pending).toEqual([expect.objectContaining({ slug: source, state: 'pending' })]);
    vi.setSystemTime(new Date(pending[0]!.run_after));
    await waitFor(() => rows()[0]?.state === 'done');
    expect(rows()).toEqual([expect.objectContaining({ slug: source, state: 'done' })]);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(new MemoryStore(t.db).list(prefix)).toHaveLength(3);
    const facts = t.store.since(null).filter((event) => String(event.data.slug).startsWith(prefix));
    expect(facts).toHaveLength(3);
    for (const event of facts) {
      expect(event).toMatchObject({
        type: 'memory.page',
        topicId: 'tp_1',
        runId: 'run_1',
        data: { author: 'maintenance' },
      });
    }
  });
});

test('la capture sans modèle journalise une fois et ne crée aucun job', async () => {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  await withCaptureDaemon(false, async ({ db: daemonDb }) => {
    expect(daemonDb.prepare("SELECT id FROM memory_jobs WHERE kind = 'faits'").all()).toEqual([]);
  });
  expect(
    stderr.mock.calls.filter(([line]) => line === "capture allumée sans modèle d'entretien"),
  ).toHaveLength(1);
});

test('une source longue est coupée à sa fin, sur une fin de ligne', () => {
  const lignes = Array.from({ length: 3000 }, (_, i) => `ligne ${i}`);
  const coupe = finDeSource(lignes.join('\n'), 1000);
  expect(coupe.length).toBeLessThanOrEqual(1000 + 4);
  expect(coupe.startsWith('[…]\n')).toBe(true);
  expect(coupe.endsWith('ligne 2999')).toBe(true);
  expect(coupe.split('\n')[1]).toMatch(/^ligne \d+$/);
  expect(finDeSource('court', 1000)).toBe('court');
});
