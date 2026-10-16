import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { type Db, openDb } from '../src/daemon/db.js';
import { MemoryJobs } from '../src/daemon/memory/jobs.js';
import {
  type ChatModel,
  MemoryProposals,
  scheduleMaintenance,
} from '../src/daemon/memory/maintain.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';

// Config mémoire complète : `startDaemon` fusionne `memory` au premier niveau (pas de fusion
// profonde), toute config de test doit donc donner embeddings/maintenance/git en entier.
const MEMORY_CFG = (maintenance: { enabled: boolean; window: string; model?: string }) => ({
  embeddings: { provider: 'off' as const, model: 'bge-m3', url: 'http://127.0.0.1:11434' },
  maintenance: {
    enabled: maintenance.enabled,
    window: maintenance.window,
    model: maintenance.model ?? 'qwen3:8b',
  },
  git: { push: false },
});

function fixedChatModel(content: string): ChatModel {
  return {
    async chat() {
      return content;
    },
  };
}

let t: TestDaemon;
let db: Db;
afterEach(async () => {
  await t?.d.stop();
  db?.close();
});

function freshDb(): { store: MemoryStore; jobs: MemoryJobs; proposals: MemoryProposals } {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'aid-maint-')), 'state.db'));
  return {
    store: new MemoryStore(db),
    jobs: new MemoryJobs(db),
    proposals: new MemoryProposals(db),
  };
}

const put = (slug: string, text: string) =>
  t.d.app.inject({
    method: 'PUT',
    url: `/api/memory/pages/${slug}`,
    headers: t.headers,
    payload: { text },
  });
const getPage = async (slug: string) =>
  (await t.d.app.inject({ url: `/api/memory/pages/${slug}`, headers: t.headers })).json();
const apply = (id: string) =>
  t.d.app.inject({ method: 'POST', url: `/api/memory/proposals/${id}/apply`, headers: t.headers });

// `waitFor` attend un prédicat synchrone (cf. 06.7) : on interroge la base directement.
const jobState = (slug: string) =>
  (
    t.db.prepare("SELECT state FROM memory_jobs WHERE kind = 'maintain' AND slug = ?").get(slug) as
      { state: string } | undefined
  )?.state;
const openProposals = () =>
  t.db.prepare("SELECT id, kind, slug FROM memory_proposals WHERE state = 'open'").all() as Array<{
    id: string;
    kind: string;
    slug: string;
  }>;

test('page sans tags : une proposition « tags » ouverte, la page ne change pas', async () => {
  t = await startTestDaemon(undefined, {
    config: { memory: MEMORY_CFG({ enabled: true, window: '00:00-23:59' }) },
    memory: { chatModel: fixedChatModel('{"tags":["chat","sommeil"]}'), maintenanceScheduleMs: 20 },
  });
  expect((await put('aid/plan/felin', 'Le chat dort sur le canapé.')).statusCode).toBe(201);
  await waitFor(() => jobState('aid/plan/felin') === 'done', 5000, 'job maintain terminé');

  const open = openProposals();
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ kind: 'tags', slug: 'aid/plan/felin' });

  const page = await getPage('aid/plan/felin');
  expect(page.revision).toBe(1);
  expect(page.frontmatter.tags).toBeUndefined();
});

test('apply : les tags sont écrits, la révision augmente', async () => {
  t = await startTestDaemon(undefined, {
    config: { memory: MEMORY_CFG({ enabled: true, window: '00:00-23:59' }) },
    memory: { chatModel: fixedChatModel('{"tags":["chat","sommeil"]}'), maintenanceScheduleMs: 20 },
  });
  await put('aid/plan/felin', 'Le chat dort sur le canapé.');
  await waitFor(() => jobState('aid/plan/felin') === 'done', 5000, 'job maintain terminé');
  const [proposal] = openProposals();

  const res = await apply(proposal!.id);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ state: 'applied' });

  const page = await getPage('aid/plan/felin');
  expect(page.revision).toBe(2);
  expect(page.frontmatter.tags).toEqual(['chat', 'sommeil']);
});

test('réponse JSON invalide : le job échoue, aucune proposition n’est créée', async () => {
  t = await startTestDaemon(undefined, {
    config: { memory: MEMORY_CFG({ enabled: true, window: '00:00-23:59' }) },
    memory: {
      chatModel: fixedChatModel('ceci n’est pas du JSON'),
      maintenanceScheduleMs: 20,
      backoffMs: [],
    },
  });
  await put('aid/plan/x', 'contenu quelconque');
  await waitFor(() => jobState('aid/plan/x') === 'failed', 5000, 'job maintain en échec');
  expect(openProposals()).toEqual([]);
});

test('hors fenêtre : aucun job créé', () => {
  const { store, jobs, proposals } = freshDb();
  store.put('aid/plan/x', 'contenu', { kind: 'create' }, 'test');
  const now = new Date('2026-01-01T12:00:00');
  const n = scheduleMaintenance(now, {
    store,
    jobs,
    proposals,
    enabled: true,
    window: '02:00-06:00',
  });
  expect(n).toBe(0);
  expect(db.prepare("SELECT count(*) AS c FROM memory_jobs WHERE kind = 'maintain'").get()).toEqual(
    { c: 0 },
  );
});

test('désactivé : aucun job créé même dans la fenêtre', () => {
  const { store, jobs, proposals } = freshDb();
  store.put('aid/plan/x', 'contenu', { kind: 'create' }, 'test');
  const now = new Date('2026-01-01T03:00:00');
  const n = scheduleMaintenance(now, {
    store,
    jobs,
    proposals,
    enabled: false,
    window: '02:00-06:00',
  });
  expect(n).toBe(0);
});

test('page éligible, dans la fenêtre : un job par page, plafonné à maxPerNight', () => {
  const { store, jobs, proposals } = freshDb();
  store.put('aid/plan/a', 'contenu a', { kind: 'create' }, 'test');
  store.put('aid/plan/b', 'contenu b', { kind: 'create' }, 'test');
  const now = new Date('2026-01-01T03:00:00');
  const n = scheduleMaintenance(now, {
    store,
    jobs,
    proposals,
    enabled: true,
    window: '02:00-06:00',
    maxPerNight: 1,
  });
  expect(n).toBe(1);
  expect(db.prepare("SELECT count(*) AS c FROM memory_jobs WHERE kind = 'maintain'").get()).toEqual(
    { c: 1 },
  );
});
