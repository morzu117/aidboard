import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { type Db, openDb } from '../src/daemon/db.js';
import { project } from '../src/daemon/events/projectors.js';
import { EventStore } from '../src/daemon/events/store.js';
import type { StoredEvent } from '../src/shared/events.js';

function setup() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'aid-ev-')), 'state.db'));
  return { db, store: new EventStore(db) };
}

function seed(db: Db) {
  db.prepare("INSERT INTO workspaces VALUES ('ws_1','a','/a','main','/w','t0')").run();
  db.prepare(
    "INSERT INTO topics VALUES ('tp_1','ws_1','s','T','feat','feat/s','main','/w/s','draft',NULL,'disabled','t0','t0')",
  ).run();
  db.prepare("INSERT INTO runs VALUES ('run_1','tp_1','standard','open','t0')").run();
  db.prepare(
    "INSERT INTO agents VALUES ('ag_1','run_1','shell','free','pty','starting','/w/s','[]',NULL,NULL,NULL,'t0','t0')",
  ).run();
}

test('un id déjà vu ne crée qu’une ligne et n’émet qu’une fois', () => {
  const { store, db } = setup();
  const seen: StoredEvent[] = [];
  store.on('event', (e) => seen.push(e));
  const e = {
    source: 'daemon',
    type: 'topic.state',
    data: { state: 'active' },
    id: '01JAB7Q3W8AAAAAAAAAAAAAAAA',
  } as const;
  const a = store.append(e);
  const b = store.append(e);
  expect(b.seq).toBe(a.seq);
  expect(db.prepare('SELECT count(*) c FROM events').get()).toEqual({ c: 1 });
  expect(seen).toHaveLength(1);
});

test('les seq croissent et les ids restent triables dans la même milliseconde', () => {
  const { store } = setup();
  const ts = '2026-10-15T10:00:00.000Z';
  const ids = Array.from({ length: 200 }, () =>
    store.append({ source: 'daemon', type: 'cost', data: {}, ts }),
  );
  for (let i = 1; i < ids.length; i++) {
    expect(ids[i]!.seq).toBeGreaterThan(ids[i - 1]!.seq);
    expect(ids[i]!.id > ids[i - 1]!.id).toBe(true);
  }
});

test('mutate qui lève : ni ligne neuve ni événement', () => {
  const { store, db } = setup();
  seed(db);
  expect(() =>
    store.append(
      { source: 'daemon', type: 'topic.state', topicId: 'tp_1', data: { state: 'active' } },
      (tx) => {
        tx.prepare("INSERT INTO workspaces VALUES ('ws_2','b','/b','main','/w','t')").run();
        throw new Error('boum');
      },
    ),
  ).toThrow('boum');
  expect(db.prepare('SELECT count(*) c FROM workspaces').get()).toEqual({ c: 1 });
  expect(db.prepare('SELECT count(*) c FROM events').get()).toEqual({ c: 0 });
  expect(db.prepare("SELECT state FROM topics WHERE id='tp_1'").get()).toEqual({ state: 'draft' });
});

test('les projections suivent les événements', () => {
  const { store, db } = setup();
  seed(db);
  store.append({
    source: 'daemon',
    type: 'topic.state',
    topicId: 'tp_1',
    data: { state: 'active', indexState: 'indexing' },
  });
  store.append({
    source: 'daemon',
    type: 'agent.spawned',
    agentId: 'ag_1',
    runId: 'run_1',
    data: { pid: 4242 },
  });
  store.append({
    source: 'daemon',
    type: 'agent.exited',
    agentId: 'ag_1',
    data: { exitCode: 3, reason: 'exit' },
  });
  expect(db.prepare("SELECT state, index_state FROM topics WHERE id='tp_1'").get()).toEqual({
    state: 'active',
    index_state: 'indexing',
  });
  expect(db.prepare("SELECT status, pid, exit_code FROM agents WHERE id='ag_1'").get()).toEqual({
    status: 'error',
    pid: 4242,
    exit_code: 3,
  });
});

test.each([
  [{ exitCode: 0, reason: 'exit' }, 'done'],
  [{ exitCode: 1, reason: 'exit' }, 'error'],
  [{ exitCode: null, reason: 'user' }, 'stopped'],
  [{ exitCode: null, reason: 'daemon_restart' }, 'stopped'],
  [{ exitCode: null, reason: 'daemon_stop' }, 'stopped'],
])('agent.exited %j donne %s', (data, status) => {
  const { store, db } = setup();
  seed(db);
  store.append({ source: 'daemon', type: 'agent.exited', agentId: 'ag_1', data });
  expect(db.prepare("SELECT status FROM agents WHERE id='ag_1'").get()).toEqual({ status });
});

test('cycle de vie d’une action', () => {
  const { store, db } = setup();
  seed(db);
  store.append({
    source: 'action',
    type: 'action.started',
    workspaceId: 'ws_1',
    data: { actionId: 'ac_1', action: 'topic.create' },
  });
  expect(db.prepare("SELECT state, topic_id FROM actions WHERE id='ac_1'").get()).toEqual({
    state: 'running',
    topic_id: null,
  });
  store.append({
    source: 'action',
    type: 'action.finished',
    workspaceId: 'ws_1',
    topicId: 'tp_1',
    data: { actionId: 'ac_1', outcome: 'succeeded', exitCode: 0, result: { worktree: '/w/s' } },
  });
  expect(
    db.prepare("SELECT state, topic_id, exit_code, result FROM actions WHERE id='ac_1'").get(),
  ).toEqual({
    state: 'succeeded',
    topic_id: 'tp_1',
    exit_code: 0,
    result: '{"worktree":"/w/s"}',
  });
});

test('since : après un id, avec filtre, et id inconnu = tout', () => {
  const { store } = setup();
  const a = store.append({ source: 'daemon', type: 'cost', topicId: 'tp_1', data: {} });
  const b = store.append({ source: 'daemon', type: 'cost', topicId: 'tp_2', data: {} });
  const c = store.append({ source: 'daemon', type: 'cost', topicId: 'tp_1', data: {} });
  expect(store.since(a.id).map((e) => e.id)).toEqual([b.id, c.id]);
  expect(store.since(null, { topicId: 'tp_1' }).map((e) => e.id)).toEqual([a.id, c.id]);
  expect(store.since('inconnu')).toHaveLength(3);
});

test('reconstruction : rejouer le journal redonne les mêmes tables', () => {
  const { store, db } = setup();
  seed(db);
  const types = [
    'topic.state',
    'topic.phase',
    'agent.spawned',
    'agent.exited',
    'run.state',
    'cost',
  ] as const;
  for (let i = 0; i < 50; i++) {
    const type = types[i % types.length]!;
    const data: Record<string, unknown> = {
      'topic.state': {
        state: i % 4 === 0 ? 'review' : 'active',
        indexState: i % 3 === 0 ? 'ready' : undefined,
      },
      'topic.phase': { phase: i % 2 ? 'dev' : 'review' },
      'agent.spawned': { pid: 1000 + i },
      'agent.exited': { exitCode: i % 5, reason: i % 7 === 0 ? 'user' : 'exit' },
      'run.state': { state: `s${i}` },
      cost: { usd: i },
    }[type]!;
    store.append({
      source: 'daemon',
      type,
      topicId: 'tp_1',
      runId: 'run_1',
      agentId: 'ag_1',
      data,
    });
  }
  const dump = () => ({
    topics: db.prepare('SELECT * FROM topics').all(),
    agents: db.prepare('SELECT * FROM agents').all(),
    runs: db.prepare('SELECT * FROM runs').all(),
    actions: db.prepare('SELECT * FROM actions').all(),
  });
  const before = dump();
  db.exec(`
    UPDATE topics SET state='draft', phase=NULL, index_state='disabled', updated_at='t0';
    UPDATE agents SET status='starting', pid=NULL, exit_code=NULL, updated_at='t0';
    UPDATE runs SET state='open';
    DELETE FROM actions;`);
  for (const e of store.since(null)) project(db, e);
  expect(dump()).toEqual(before);
});
