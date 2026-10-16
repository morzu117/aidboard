import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { attachClient } from '../src/daemon/pty/attach.js';
import { TerminalMirror } from '../src/daemon/pty/mirror.js';
import { waitFor } from './helpers/daemon.js';
import { COLS, Replica, ROWS } from './helpers/replica.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

const FAKE_AGENT = join(import.meta.dirname, 'fixtures/fake-agent.sh');
const saved = process.env.SHELL;
let c: Ctx;

afterEach(async () => {
  process.env.SHELL = saved;
  await c?.t.d.stop();
});

async function start(shell: string) {
  process.env.SHELL = shell;
  c = await setupWorkspace();
  const { topicId } = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId, kind: 'shell' });
  const live = c.t.d.agents.get(agent.id)!;
  const syncMirror = () => new Promise<void>((r) => live.mirror.snapshotThen(() => r()));
  return { live, agent, syncMirror, type: (s: string) => live.pty.write(s) };
}

test('reconnexion à un agent plein écran : la copie retrouve exactement l’écran, cadre et saisies compris', async () => {
  const a = await start(FAKE_AGENT);
  await waitFor(() => a.live.mirror.screen().some((l) => l.includes('PRÊT')), 5000, 'agent prêt');
  a.type('bonjour\n');
  await waitFor(() => a.live.mirror.screen().some((l) => l.includes('> bonjour')), 5000, 'écho');

  const first = new Replica();
  const att1 = attachClient(a.live, first.feed);
  await att1.ready;
  att1.detach();

  a.type('second\n');
  await waitFor(
    () => a.live.mirror.screen().some((l) => l.includes('> second')),
    5000,
    'second écho',
  );
  await a.syncMirror();

  const second = new Replica();
  const att2 = attachClient(a.live, second.feed);
  await att2.ready;
  await second.flush();
  att2.detach();

  expect(a.live.mirror.isAlternate).toBe(true);
  expect(second.term.buffer.active.type).toBe('alternate');
  expect(second.screen()).toEqual(a.live.mirror.screen());
  const text = second.screen().join('\n');
  expect(text).toContain('|  FAKE AGENT        |');
  expect(text).toContain('PRÊT');
  expect(text).toContain('> bonjour');
  expect(text).toContain('> second');
});

test('deux instantanés successifs sans nouvelle sortie sont identiques', async () => {
  const a = await start(FAKE_AGENT);
  await waitFor(() => a.live.mirror.screen().some((l) => l.includes('PRÊT')), 5000, 'agent prêt');
  const snap = () => new Promise<string>((r) => a.live.mirror.snapshotThen(r));
  expect(await snap()).toBe(await snap());
});

test('rafale de 100 000 lignes pendant dix reconnexions : le dernier client a exactement la fin du miroir', async () => {
  const a = await start('/bin/sh');
  a.type('seq 1 100000; echo "FIN""ISH"\n');

  for (let i = 0; i < 10; i++) {
    const r = new Replica();
    const att = attachClient(a.live, r.feed);
    await att.ready;
    await new Promise((res) => setTimeout(res, 15));
    att.detach();
  }

  const last = new Replica();
  const att = attachClient(a.live, last.feed);
  await waitFor(
    () => a.live.mirror.allLines().some((l) => l.includes('FINISH')),
    20_000,
    'fin de la rafale',
  );
  await att.ready;
  await a.syncMirror();
  await last.flush();
  att.detach();

  const mirror = a.live.mirror.allLines();
  const client = last.lines();
  expect(client.slice(-400)).toEqual(mirror.slice(-400));

  const numbers = client
    .map((l) => Number.parseInt(l, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  expect(numbers.at(-1)).toBe(100000);
  const tail = numbers.slice(-2000);
  for (let i = 1; i < tail.length; i++) expect(tail[i]).toBe(tail[i - 1]! + 1);
});

test('après la sortie de l’agent, le miroir reste lisible par une nouvelle connexion', async () => {
  const a = await start('/bin/sh');
  a.type('echo "avant""-fin"; exit 0\n');
  await waitFor(() => a.live.exited, 5000, 'sortie');
  await a.syncMirror();
  const r = new Replica();
  const att = attachClient(a.live, r.feed);
  await att.ready;
  await r.flush();
  att.detach();
  expect(a.live.exit?.exitCode).toBe(0);
  expect(r.lines().join('\n')).toContain('avant-fin');
  expect(r.screen()).toEqual(a.live.mirror.screen());
});

test('fromLog sur un journal coupé au milieu d’une séquence ne lève pas', () => {
  expect(() => TerminalMirror.fromLog('abc\u001b[3', COLS, ROWS, 100)).not.toThrow();
  expect(() => TerminalMirror.fromLog('é\u001b[?1049h\u001b[', COLS, ROWS, 100)).not.toThrow();
});

test('resize : les deux côtés suivent et une taille absurde est ignorée', async () => {
  const a = await start('/bin/sh');
  expect(c.t.d.agents.resize(a.agent.id, 100, 40)).toBe(true);
  expect([a.live.mirror.cols, a.live.mirror.rows]).toEqual([100, 40]);
  expect(a.live.size).toEqual({ cols: 100, rows: 40 });
  for (const [cols, rows] of [
    [0, 0],
    [1, 24],
    [80, 1],
    [5000, 24],
    [80.5, 24],
  ] as const) {
    expect(c.t.d.agents.resize(a.agent.id, cols, rows)).toBe(false);
  }
  expect(a.live.size).toEqual({ cols: 100, rows: 40 });
});

test('un gros bloc encore en cours d’analyse au moment de la connexion est dans l’instantané', async () => {
  const a = await start('/bin/sh');
  const big = Array.from({ length: 20000 }, (_, i) => `ligne ${i}\r\n`).join('');
  a.live.mirror.write(big);
  const r = new Replica();
  const att = attachClient(a.live, r.feed);
  await att.ready;
  await r.flush();
  att.detach();
  expect(r.lines()).toContain('ligne 19999');
  expect(r.lines()).toContain('ligne 15000');
});
