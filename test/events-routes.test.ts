import { afterEach, expect, test } from 'vitest';
import { issueRunToken } from '../src/daemon/security.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const post = (payload: unknown, headers = t.headers) =>
  t.d.app.inject({ method: 'POST', url: '/api/events', headers, payload: payload as never });

test('un événement valide est ingéré (202) et projeté', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  const r = await post({
    source: 'daemon',
    type: 'topic.state',
    topicId: 'tp_1',
    data: { state: 'review' },
  });
  expect(r.statusCode).toBe(202);
  expect(t.db.prepare("SELECT state FROM topics WHERE id='tp_1'").get()).toEqual({
    state: 'review',
  });
});

test('le même id posté deux fois ne crée qu’un événement', async () => {
  t = await startTestDaemon();
  const e = { id: '01JAB7Q3W8AAAAAAAAAAAAAAAA', source: 'daemon', type: 'cost', data: {} };
  expect((await post(e)).statusCode).toBe(202);
  expect((await post(e)).statusCode).toBe(202);
  expect(t.db.prepare('SELECT count(*) c FROM events').get()).toEqual({ c: 1 });
});

test.each([
  [{ source: 'daemon', type: 'inconnu', data: {} }],
  [{ source: 'nimporte', type: 'cost', data: {} }],
  [{ source: 'daemon', type: 'cost' }],
  [{ source: 'daemon', type: 'cost', data: {}, extra: 1 }],
])('payload invalide %j : 400', async (payload) => {
  t = await startTestDaemon();
  expect((await post(payload)).statusCode).toBe(400);
});

test('un agent ne peut ni valider, ni changer l’état du sujet, ni se faire passer pour le daemon', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  const h = { host: t.headers.host!, authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}` };
  for (const payload of [
    { source: 'hook:claude', type: 'approval.resolved', data: {} },
    { source: 'hook:claude', type: 'topic.state', data: { state: 'merged' } },
    { source: 'hook:claude', type: 'agent.exited', data: { exitCode: 0 } },
    { source: 'daemon', type: 'agent.status', data: {} },
  ]) {
    expect((await post(payload, h)).statusCode).toBe(403);
  }
  expect(t.db.prepare('SELECT count(*) c FROM events').get()).toEqual({ c: 0 });
});

test('un agent émet pour son run : topic et workspace sont imposés, pas crus', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  const h = { host: t.headers.host!, authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}` };
  const r = await post(
    {
      source: 'hook:claude',
      type: 'agent.status',
      topicId: 'tp_autre',
      agentId: 'ag_1',
      data: { status: 'needs_input' },
    },
    h,
  );
  expect(r.statusCode).toBe(202);
  const [e] = t.store.since(null);
  expect(e).toMatchObject({
    runId: 'run_1',
    topicId: 'tp_1',
    workspaceId: 'ws_1',
    agentId: 'ag_1',
  });
});

test('un agent ne peut pas désigner l’agent d’un autre run', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  t.db.prepare("INSERT INTO runs VALUES ('run_2','tp_1','standard','open','t0')").run();
  t.db
    .prepare(
      "INSERT INTO agents VALUES ('ag_2','run_2','shell','free','pty','starting','/w','[]',NULL,NULL,NULL,'t0','t0')",
    )
    .run();
  const h = { host: t.headers.host!, authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}` };
  expect(
    (await post({ source: 'hook:claude', type: 'agent.status', agentId: 'ag_2', data: {} }, h))
      .statusCode,
  ).toBe(403);
});

test('les types de la ruche (plan.updated, task.status) et la source relay sont ingérables par le daemon', async () => {
  t = await startTestDaemon();
  expect(
    (await post({ source: 'swairm', type: 'plan.updated', data: { tasks: [] } })).statusCode,
  ).toBe(202);
  expect(
    (await post({ source: 'swairm', type: 'task.status', data: { status: 'done' } })).statusCode,
  ).toBe(202);
  expect(
    (await post({ source: 'relay', type: 'approval.resolved', data: { decision: 'ok' } }))
      .statusCode,
  ).toBe(202);
});

test('un agent ne peut pas émettre plan.updated ni instructions.updated', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  const h = { host: t.headers.host!, authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}` };
  expect(
    (await post({ source: 'hook:claude', type: 'plan.updated', data: {} }, h)).statusCode,
  ).toBe(403);
  expect(
    (await post({ source: 'hook:claude', type: 'instructions.updated', data: {} }, h)).statusCode,
  ).toBe(403);
});
