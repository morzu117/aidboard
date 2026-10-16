import WebSocket from 'ws';
import { afterEach, expect, test } from 'vitest';
import type { StoredEvent } from '../src/shared/events.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

type Msg = { kind: string; event?: StoredEvent };
let t: TestDaemon;
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.close();
  sockets = [];
  await t?.d.stop();
});

function connect(query = ''): Promise<{ ws: WebSocket; got: Msg[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${t.d.port}/ws/events${query}`, {
    headers: {
      origin: `http://127.0.0.1:${t.d.port}`,
      cookie: `aid_session=${t.d.auth.adminToken}`,
    },
  });
  sockets.push(ws);
  const got: Msg[] = [];
  ws.on('message', (m) => got.push(JSON.parse(String(m))));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, got }));
    ws.on('error', reject);
  });
}

const emit = (i: number, topicId = 'tp_1') =>
  t.store.append({ source: 'daemon', type: 'cost', topicId, data: { i } });
const ids = (got: Msg[]) =>
  got.filter((m) => m.kind === 'event').map((m) => (m.event as StoredEvent).id);

test('rejeu depuis un id, puis direct, sans trou ni doublon', async () => {
  t = await startTestDaemon();
  const first = emit(0);
  for (let i = 1; i < 5; i++) emit(i);
  const { got } = await connect(`?since=${first.id}`);
  const live: string[] = [];
  for (let i = 5; i < 505; i++) {
    live.push(emit(i).id);
    if (i % 50 === 0) await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setTimeout(r, 300));
  const all = t.store.since(first.id).map((e) => e.id);
  expect(ids(got)).toEqual(all);
  expect(all).toHaveLength(504);
  expect(new Set(ids(got)).size).toBe(504);
  expect(live.every((id) => ids(got).includes(id))).toBe(true);
});

test('sans since, tout le journal est rejoué', async () => {
  t = await startTestDaemon();
  emit(0);
  emit(1);
  const { got } = await connect();
  await new Promise((r) => setTimeout(r, 100));
  expect(ids(got)).toHaveLength(2);
});

test('le filtre topicId vaut pour le rejeu et pour le direct', async () => {
  t = await startTestDaemon();
  const a1 = emit(0, 'tp_a');
  emit(1, 'tp_b');
  const { got } = await connect('?topicId=tp_a');
  const a2 = emit(2, 'tp_a');
  emit(3, 'tp_b');
  await new Promise((r) => setTimeout(r, 150));
  expect(ids(got)).toEqual([a1.id, a2.id]);
});

test('un message éphémère est relayé et jamais rejoué', async () => {
  t = await startTestDaemon();
  const { got } = await connect();
  t.store.emitEphemeral({
    kind: 'ephemeral',
    type: 'action.output',
    topicId: 'tp_1',
    line: 'salut',
  });
  await new Promise((r) => setTimeout(r, 100));
  expect(got.filter((m) => m.kind === 'ephemeral')).toHaveLength(1);
  const second = await connect();
  await new Promise((r) => setTimeout(r, 100));
  expect(second.got.filter((m) => m.kind === 'ephemeral')).toHaveLength(0);
});

test('une socket fermée se désabonne', async () => {
  t = await startTestDaemon();
  const { ws } = await connect();
  const before = t.store.listenerCount('event');
  ws.close();
  await new Promise((r) => setTimeout(r, 150));
  expect(t.store.listenerCount('event')).toBe(before - 1);
});
