import { afterEach, expect, test } from 'vitest';
import { reconcile } from '../src/daemon/reconcile.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

test('les agents vivants passent en stopped, les actions en cours en failed', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  t.db
    .prepare(
      "INSERT INTO agents VALUES ('ag_done','run_1','shell','free','pty','done','/w','[]',NULL,0,NULL,'t0','t0')",
    )
    .run();
  t.store.append({
    source: 'action',
    type: 'action.started',
    workspaceId: 'ws_1',
    data: { actionId: 'ac_1', action: 'topic.create' },
  });
  reconcile(t.db, t.store);
  expect(t.db.prepare('SELECT id, status FROM agents ORDER BY id').all()).toEqual([
    { id: 'ag_1', status: 'stopped' },
    { id: 'ag_done', status: 'done' },
  ]);
  expect(t.db.prepare("SELECT state, exit_code FROM actions WHERE id='ac_1'").get()).toEqual({
    state: 'failed',
    exit_code: null,
  });
  const exited = t.store.since(null).filter((e) => e.type === 'agent.exited');
  expect(exited).toHaveLength(1);
  expect(exited[0]).toMatchObject({
    agentId: 'ag_1',
    topicId: 'tp_1',
    data: { reason: 'daemon_restart' },
  });
});

test('une seconde réconciliation ne produit rien', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  reconcile(t.db, t.store);
  const n = t.store.since(null).length;
  reconcile(t.db, t.store);
  expect(t.store.since(null)).toHaveLength(n);
});
