import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AgentSocket } from '../../web/src/conversation/agentSocket.js';

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 1;
  closedByClient = false;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  close() {
    this.closedByClient = true;
  }
  text(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

vi.stubGlobal('WebSocket', Object.assign(FakeWs, { OPEN: 1 }));

function make() {
  const log: string[] = [];
  const sock = new AgentSocket(
    'ag_1',
    {
      onHello: (h) => log.push(`hello:${h.status}:${h.exited}`),
      onHistory: (items, truncated) => log.push(`history:${items.length}:${truncated}`),
      onEvent: (item) => log.push(`event:${item.seq}`),
      onExit: (e) => log.push(`exit:${e.exitCode}:${e.reason}`),
      onLink: (c) => log.push(`link:${c}`),
    },
    {
      socketFactory: (u) => new FakeWs(u) as unknown as WebSocket,
      origin: { protocol: 'http:', host: '127.0.0.1:4870' },
    },
  );
  return { sock, log, ws: () => FakeWs.all.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWs.all = [];
});
afterEach(() => vi.useRealTimers());

test('se connecte à /ws/agent/<agent> avec after=0 et dispatche hello, historique, événement et sortie', () => {
  const t = make();
  expect(t.ws().url).toBe('ws://127.0.0.1:4870/ws/agent/ag_1?after=0');
  t.ws().onopen?.();
  t.ws().text({ t: 'hello', status: 'working', exited: false });
  t.ws().text({
    t: 'history',
    items: [{ seq: 1, at: 't1', event: { type: 'session', sessionId: 's1' } }],
    truncated: false,
  });
  t.ws().text({
    t: 'event',
    seq: 2,
    at: 't2',
    event: { type: 'message', role: 'assistant', text: 'ok' },
  });
  t.ws().text({ t: 'exit', exitCode: 0, signal: null, reason: 'exit' });
  t.ws().text({ t: 'inconnu' });
  expect(t.log).toEqual([
    'link:true',
    'hello:working:false',
    'history:1:false',
    'event:2',
    'exit:0:exit',
  ]);
});

test('reconnexion : l’URL porte after = dernier seq reçu, qu’il vienne de l’historique ou du direct', async () => {
  const t = make();
  t.ws().onopen?.();
  t.ws().text({
    t: 'history',
    items: [
      { seq: 1, at: 't', event: {} },
      { seq: 3, at: 't', event: {} },
    ],
    truncated: false,
  });
  t.ws().text({ t: 'event', seq: 7, at: 't', event: {} });
  t.ws().drop();
  await vi.advanceTimersByTimeAsync(500);
  expect(FakeWs.all).toHaveLength(2);
  expect(t.ws().url).toBe('ws://127.0.0.1:4870/ws/agent/ag_1?after=7');
});

test('fermeture 4001 (client trop lent) : reconnexion immédiate', async () => {
  const t = make();
  t.ws().drop(4001);
  await vi.advanceTimersByTimeAsync(0);
  expect(FakeWs.all).toHaveLength(2);
});

test('autre fermeture : reconnexion par paliers 0,5 puis 1 s', async () => {
  const t = make();
  t.ws().drop();
  await vi.advanceTimersByTimeAsync(499);
  expect(FakeWs.all).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2);
  expect(FakeWs.all).toHaveLength(2);
  t.ws().drop();
  await vi.advanceTimersByTimeAsync(999);
  expect(FakeWs.all).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(2);
  expect(FakeWs.all).toHaveLength(3);
});

test('après exit ou après close(), plus aucune reconnexion', async () => {
  const a = make();
  a.ws().text({ t: 'exit', exitCode: 0, signal: null, reason: 'exit' });
  a.ws().drop();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(FakeWs.all).toHaveLength(1);

  FakeWs.all = [];
  const b = make();
  b.sock.close();
  b.ws().drop();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(FakeWs.all).toHaveLength(1);
  expect(b.ws().closedByClient).toBe(true);
});

test('close 1000 reçu après exit (fin normale décidée par le serveur) : aucune reconnexion', async () => {
  const t = make();
  t.ws().text({ t: 'exit', exitCode: 0, signal: null, reason: 'exit' });
  t.ws().drop(1000);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(FakeWs.all).toHaveLength(1);
});
