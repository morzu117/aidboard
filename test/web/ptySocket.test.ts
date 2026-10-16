import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PtySocket } from '../../web/src/terminal/ptySocket.js';

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 1;
  binaryType = '';
  sent: string[] = [];
  closedByClient = false;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((m: { data: string | ArrayBuffer }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closedByClient = true;
  }
  text(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  bytes(...b: number[]) {
    this.onmessage?.({ data: new Uint8Array(b).buffer });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

vi.stubGlobal('WebSocket', Object.assign(FakeWs, { OPEN: 1 }));

function make() {
  const log: string[] = [];
  const out: number[][] = [];
  const sock = new PtySocket(
    'ag_1',
    {
      onHello: (h) => log.push(`hello:${h.cols}x${h.rows}:${h.owner}:${h.replay}`),
      onOutput: (b) => out.push([...b]),
      onSize: (c, r) => log.push(`size:${c}x${r}`),
      onOwner: (o) => log.push(`owner:${o}`),
      onExit: (e) => log.push(`exit:${e.exitCode}`),
      onLink: (c) => log.push(`link:${c}`),
    },
    {
      socketFactory: (u) => new FakeWs(u) as unknown as WebSocket,
      origin: { protocol: 'http:', host: '127.0.0.1:4870' },
    },
  );
  return { sock, log, out, ws: () => FakeWs.all.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWs.all = [];
});
afterEach(() => vi.useRealTimers());

test('se connecte à /ws/pty/<agent> en binaire et transmet hello, sortie, taille, propriétaire et sortie du process', () => {
  const t = make();
  expect(t.ws().url).toBe('ws://127.0.0.1:4870/ws/pty/ag_1');
  expect(t.ws().binaryType).toBe('arraybuffer');
  t.ws().onopen?.();
  t.ws().text({ t: 'hello', cols: 120, rows: 32, owner: true, status: 'starting', replay: 'live' });
  t.ws().bytes(104, 105);
  t.ws().text({ t: 'size', cols: 100, rows: 40 });
  t.ws().text({ t: 'owner', owner: false });
  t.ws().text({ t: 'exit', exitCode: 3, signal: null, reason: 'exit' });
  t.ws().text({ t: 'inconnu' });
  expect(t.log).toEqual([
    'link:true',
    'hello:120x32:true:live',
    'size:100x40',
    'owner:false',
    'exit:3',
  ]);
  expect(t.out).toEqual([[104, 105]]);
});

test('input, resize et claim partent en JSON ; un message invalide est ignoré', () => {
  const t = make();
  t.ws().onmessage?.({ data: 'pas du json' });
  t.sock.input('ls\n');
  t.sock.resize(100, 40);
  t.sock.claim();
  expect(t.ws().sent.map((s) => JSON.parse(s))).toEqual([
    { t: 'in', d: 'ls\n' },
    { t: 'resize', cols: 100, rows: 40 },
    { t: 'claim' },
  ]);
});

test('rien n’est envoyé tant que la socket n’est pas ouverte', () => {
  const t = make();
  t.ws().readyState = 0;
  t.sock.input('x');
  expect(t.ws().sent).toEqual([]);
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

test('une connexion réussie remet les paliers à zéro', async () => {
  const t = make();
  t.ws().drop();
  await vi.advanceTimersByTimeAsync(500);
  t.ws().drop();
  await vi.advanceTimersByTimeAsync(1000);
  t.ws().onopen?.();
  t.ws().drop();
  await vi.advanceTimersByTimeAsync(501);
  expect(FakeWs.all).toHaveLength(4);
});

test('après la sortie du process ou après close(), plus aucune reconnexion', async () => {
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
