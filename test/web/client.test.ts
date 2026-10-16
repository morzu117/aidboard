import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AidApiError, api, SessionExpired } from '../../web/src/data/api.js';
import { AidClient } from '../../web/src/data/client.js';
import type { StateSnapshot } from '../../src/shared/state.js';

const empty = (lastEventId: string | null = null): StateSnapshot => ({
  lastEventId,
  workspaces: [],
  topics: [],
  runs: [],
  agents: [],
  actions: [],
});

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  drop() {
    this.onclose?.();
  }
  send(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function make(fetchImpl: typeof fetch, extra: object = {}) {
  return new AidClient({
    fetchImpl,
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    origin: { protocol: 'http:', host: '127.0.0.1:4870' },
    ...extra,
  });
}
const ok = (state: StateSnapshot) =>
  vi.fn(
    async () => new Response(JSON.stringify(state), { status: 200 }),
  ) as unknown as typeof fetch;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
});
afterEach(() => vi.useRealTimers());

test('démarrage : instantané, puis WebSocket reprise à lastEventId, puis connecté', async () => {
  const c = make(ok(empty('01ABC')));
  c.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(c.getSnapshot().state?.lastEventId).toBe('01ABC');
  expect(FakeSocket.all[0]!.url).toBe('ws://127.0.0.1:4870/ws/events?since=01ABC');
  expect(c.getSnapshot().daemon).toBe('reconnexion');
  FakeSocket.all[0]!.open();
  expect(c.getSnapshot().daemon).toBe('connecte');
  c.stop();
});

test('dix événements en 50 ms provoquent une seule relecture', async () => {
  const f = ok(empty());
  const c = make(f);
  c.start();
  await vi.advanceTimersByTimeAsync(0);
  const sock = FakeSocket.all[0]!;
  sock.open();
  expect(f).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 10; i++) {
    sock.send({ kind: 'event', event: { id: `E${i}`, type: 'cost', data: {} } });
    await vi.advanceTimersByTimeAsync(5);
  }
  await vi.advanceTimersByTimeAsync(200);
  expect(f).toHaveBeenCalledTimes(2);
  c.stop();
});

test('une socket perdue : injoignable après trois échecs (paliers 0,5 s puis 1 s), reprise depuis le dernier id', async () => {
  let up = true;
  const f = vi.fn(async () => {
    if (!up) throw new TypeError('connexion refusée');
    return new Response(JSON.stringify(empty()), { status: 200 });
  }) as unknown as typeof fetch;
  const c = make(f);
  c.start();
  await vi.advanceTimersByTimeAsync(0);
  const first = FakeSocket.all[0]!;
  first.open();
  first.send({ kind: 'event', event: { id: 'DERNIER', type: 'cost', data: {} } });
  await vi.advanceTimersByTimeAsync(150);

  up = false;
  first.drop();
  expect(c.getSnapshot().daemon).toBe('reconnexion'); // échec 1, reprise dans 0,5 s
  await vi.advanceTimersByTimeAsync(500);
  expect(c.getSnapshot().daemon).toBe('reconnexion'); // échec 2, reprise dans 1 s
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.getSnapshot().daemon).toBe('injoignable'); // échec 3

  up = true;
  await vi.advanceTimersByTimeAsync(2500); // palier suivant : 2 s
  const again = FakeSocket.all.at(-1)!;
  expect(again.url).toContain('since=DERNIER');
  again.open();
  expect(c.getSnapshot().daemon).toBe('connecte');
  c.stop();
});

test('retry() repart tout de suite', async () => {
  let up = false;
  const f = vi.fn(async () => {
    if (!up) throw new TypeError('x');
    return new Response(JSON.stringify(empty()), { status: 200 });
  }) as unknown as typeof fetch;
  const c = make(f);
  c.start();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(c.getSnapshot().daemon).toBe('injoignable');
  up = true;
  c.retry();
  await vi.advanceTimersByTimeAsync(0);
  FakeSocket.all.at(-1)!.open();
  expect(c.getSnapshot().daemon).toBe('connecte');
  c.stop();
});

test('401 : session expirée, plus aucune tentative', async () => {
  const f = vi.fn(
    async () => new Response('Non authentifié', { status: 401 }),
  ) as unknown as typeof fetch;
  const c = make(f);
  c.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(c.getSnapshot().daemon).toBe('session-expiree');
  expect(f).toHaveBeenCalledTimes(1);
});

test('la sortie d’une action est accumulée par action et bornée', async () => {
  const c = make(ok(empty()), { maxOutputLines: 3 });
  c.start();
  await vi.advanceTimersByTimeAsync(0);
  const sock = FakeSocket.all[0]!;
  for (let i = 1; i <= 5; i++)
    sock.send({
      kind: 'ephemeral',
      type: 'action.output',
      actionId: 'ac_1',
      stream: 'stdout',
      line: `l${i}`,
    });
  sock.send({
    kind: 'ephemeral',
    type: 'action.output',
    actionId: 'ac_2',
    stream: 'stderr',
    line: 'autre',
  });
  expect(c.getSnapshot().outputs.ac_1!.map((l) => l.line)).toEqual(['l3', 'l4', 'l5']);
  expect(c.getSnapshot().outputs.ac_2).toEqual([{ stream: 'stderr', line: 'autre' }]);
  c.stop();
});

test('les abonnés sont prévenus à chaque changement et peuvent se désabonner', async () => {
  const c = make(ok(empty()));
  const cb = vi.fn();
  const off = c.subscribe(cb);
  c.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(cb).toHaveBeenCalled();
  const n = cb.mock.calls.length;
  off();
  FakeSocket.all[0]!.open();
  expect(cb.mock.calls.length).toBe(n);
  c.stop();
});

test('api() : 4xx devient AidApiError avec le message du daemon, 401 SessionExpired', async () => {
  const f422 = vi.fn(
    async () => new Response(JSON.stringify({ error: 'pas un dépôt', extra: 1 }), { status: 422 }),
  ) as unknown as typeof fetch;
  await expect(api('POST', '/api/workspaces', { path: 'x' }, f422)).rejects.toMatchObject({
    status: 422,
    message: 'pas un dépôt',
    body: { extra: 1 },
  });
  const f401 = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch;
  await expect(api('GET', '/api/state', undefined, f401)).rejects.toBeInstanceOf(SessionExpired);
  const fText = vi.fn(async () => new Response('boum', { status: 500 })) as unknown as typeof fetch;
  await expect(api('GET', '/x', undefined, fText)).rejects.toBeInstanceOf(AidApiError);
});
