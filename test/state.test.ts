import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { StateSnapshot } from '../src/shared/state.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';

const FAKE_CODEGRAPH = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');

// Même fixture que test/mcp.test.ts : le faux binaire est spawné par le daemon en cours de
// process, la variable doit donc être posée avant `startTestDaemon`.
function fakeStatus(pendingChanges: { added?: number; modified?: number; removed?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'aid-state-fx-'));
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ initialized: true, pendingChanges }));
  process.env.FAKE_CODEGRAPH_FIXTURES = dir;
}

function seedActiveTopic(db: TestDaemon['db'], worktree: string, indexState = 'ready'): void {
  db.prepare(
    "INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at) VALUES ('ws_1','a',?,'main','/w','t0')",
  ).run(worktree);
  db.prepare(
    `INSERT INTO topics (id, workspace_id, slug, title, type, branch, base, worktree, state, phase, index_state, created_at, updated_at)
     VALUES ('tp_1','ws_1','s','T','feat','feat/s','main',?,'active',NULL,?,'t0','t0')`,
  ).run(worktree, indexState);
}

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
  delete process.env.FAKE_CODEGRAPH_FIXTURES;
});

test('GET /api/state rend l’instantané avec le dernier id d’événement', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  const e = t.store.append({ source: 'daemon', type: 'cost', topicId: 'tp_1', data: {} });
  const r = await t.d.app.inject({ url: '/api/state', headers: t.headers });
  expect(r.statusCode).toBe(200);
  const s = r.json<StateSnapshot>();
  expect(s.lastEventId).toBe(e.id);
  expect(s.workspaces.map((w) => w.name)).toEqual(['a']);
  expect(s.topics[0]).toMatchObject({
    id: 'tp_1',
    slug: 's',
    state: 'active',
    worktreeMissing: true,
  });
  expect(s.runs).toHaveLength(1);
  expect(s.agents[0]).toMatchObject({ id: 'ag_1', command: ['sh'], status: 'starting' });
});

test('les sujets archivés sont exclus, sauf avec ?all=1 ; leurs runs et agents suivent', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  t.store.append({
    source: 'daemon',
    type: 'topic.state',
    topicId: 'tp_1',
    data: { state: 'archived' },
  });
  const dflt = (
    await t.d.app.inject({ url: '/api/state', headers: t.headers })
  ).json<StateSnapshot>();
  expect(dflt.topics).toHaveLength(0);
  expect(dflt.runs).toHaveLength(0);
  expect(dflt.agents).toHaveLength(0);
  const all = (
    await t.d.app.inject({ url: '/api/state?all=1', headers: t.headers })
  ).json<StateSnapshot>();
  expect(all.topics).toHaveLength(1);
  expect(all.agents).toHaveLength(1);
});

test('base vide : instantané vide, lastEventId nul', async () => {
  t = await startTestDaemon();
  const s = (await t.d.app.inject({ url: '/api/state', headers: t.headers })).json<StateSnapshot>();
  expect(s).toEqual({
    lastEventId: null,
    workspaces: [],
    topics: [],
    runs: [],
    agents: [],
    actions: [],
  });
});

test('sujet à jour : index.engine = codegraph, stale false (DS7, relu en direct)', async () => {
  fakeStatus({});
  t = await startTestDaemon(undefined, { codegraphBin: FAKE_CODEGRAPH });
  const worktree = mkdtempSync(join(tmpdir(), 'aid-state-wt-'));
  seedActiveTopic(t.db, worktree);
  const s = (await t.d.app.inject({ url: '/api/state', headers: t.headers })).json<StateSnapshot>();
  expect(s.topics[0]?.index).toMatchObject({ engine: 'codegraph', stale: false });
});

test('faux binaire avec pendingChanges : index.stale = true', async () => {
  fakeStatus({ modified: 2 });
  t = await startTestDaemon(undefined, { codegraphBin: FAKE_CODEGRAPH });
  const worktree = mkdtempSync(join(tmpdir(), 'aid-state-wt-'));
  seedActiveTopic(t.db, worktree);
  const s = (await t.d.app.inject({ url: '/api/state', headers: t.headers })).json<StateSnapshot>();
  expect(s.topics[0]?.index).toMatchObject({ engine: 'codegraph', stale: true, pending: 2 });
});

test('moteur off : index null, indexState conservé à disabled', async () => {
  t = await startTestDaemon(undefined, { structuralEngine: 'off' });
  seedActiveTopic(t.db, mkdtempSync(join(tmpdir(), 'aid-state-wt-')), 'disabled');
  const s = (await t.d.app.inject({ url: '/api/state', headers: t.headers })).json<StateSnapshot>();
  expect(s.topics[0]?.index).toBeNull();
  expect(s.topics[0]?.indexState).toBe('disabled');
});
