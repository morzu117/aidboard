import { afterEach, expect, test } from 'vitest';
import type { StateSnapshot } from '../src/shared/state.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
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
