import { afterEach, expect, test } from 'vitest';
import type { StoredEvent } from '../src/shared/events.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const post = (payload: unknown) =>
  t.d.app.inject({
    method: 'POST',
    url: '/api/events',
    headers: t.headers,
    payload: payload as never,
  });

const recent = (qs = '') =>
  t.d.app.inject({ method: 'GET', url: `/api/events/recent${qs}`, headers: t.headers });

test('ne renvoie que les types utiles, plus récents en tête', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  await post({ source: 'daemon', type: 'cost', data: {} });
  await post({ source: 'daemon', type: 'agent.status', data: {} });
  // lease_acquired n'est pas dans EVENT_TYPES : seule une insertion SQL directe peut le produire.
  t.db
    .prepare(
      "INSERT INTO events (id, v, ts, source, workspace_id, topic_id, run_id, agent_id, type, data) VALUES ('ev_lease', 1, '2026-10-27T00:00:00.000Z', 'daemon', NULL, NULL, NULL, NULL, 'lease_acquired', '{}')",
    )
    .run();
  await post({ source: 'daemon', type: 'topic.state', topicId: 'tp_1', data: { state: 'review' } });
  await post({ source: 'daemon', type: 'topic.phase', topicId: 'tp_1', data: { phase: 'dev' } });

  const r = await recent();
  expect(r.statusCode).toBe(200);
  const body = r.json() as { events: StoredEvent[] };
  expect(body.events.map((e) => e.type)).toEqual(['topic.phase', 'topic.state']);
});

test('limite bornée 1..50, défaut 20', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  for (let i = 0; i < 25; i++) {
    await post({
      source: 'daemon',
      type: 'topic.phase',
      topicId: 'tp_1',
      data: { phase: `p${i}` },
    });
  }
  expect((await recent()).statusCode).toBe(200);
  const defaut = (await recent()).json() as { events: StoredEvent[] };
  expect(defaut.events).toHaveLength(20);
  expect((defaut.events[0]!.data as { phase: string }).phase).toBe('p24');

  expect((await recent('?limit=0')).statusCode).toBe(400);
  expect((await recent('?limit=51')).statusCode).toBe(400);
  const cinq = (await recent('?limit=5')).json() as { events: StoredEvent[] };
  expect(cinq.events).toHaveLength(5);
});

test('contexte joint (branche, titre, projet) quand le sujet et le projet existent', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  await post({
    source: 'daemon',
    type: 'topic.state',
    topicId: 'tp_1',
    workspaceId: 'ws_1',
    data: { state: 'review' },
  });
  const body = (await recent()).json() as { events: StoredEvent[] };
  expect(body.events[0]!.context).toEqual({
    topicBranch: 'feat/s',
    topicTitle: 'T',
    workspaceName: 'a',
  });
});

test('sans cookie ni bearer : 401', async () => {
  t = await startTestDaemon();
  const r = await t.d.app.inject({
    method: 'GET',
    url: '/api/events/recent',
    headers: { host: t.headers.host! },
  });
  expect(r.statusCode).toBe(401);
});
