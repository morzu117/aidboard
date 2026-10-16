import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { screenShows } from '../src/daemon/pty/manager.js';
import { issueRunToken } from '../src/daemon/security.js';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

const BIN = join(import.meta.dirname, 'fixtures/bin');
const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };
let c: Ctx | undefined;
afterEach(async () => {
  process.env.PATH = saved.PATH;
  process.env.SHELL = saved.SHELL;
  await c?.t.d.stop();
  c = undefined;
});

async function spawn(kind: 'claude' | 'shell') {
  process.env.PATH = `${BIN}${delimiter}${saved.PATH}`;
  process.env.SHELL = '/bin/sh';
  c = await setupWorkspace();
  const topic = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind });
  const live = c.t.d.agents.get(agent.id)!;
  let out = '';
  live.subscribe((chunk) => (out += chunk));
  const inject = (
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    headers = c!.t.headers,
  ) =>
    c!.t.d.app.inject({
      method,
      url: `/api/agents/${agent.id}/${path}`,
      headers,
      payload: payload as never,
    });
  if (kind === 'claude')
    await waitFor(() => live.mirror.screen().some((l) => l.includes('PRÊT')), 5000, 'PRÊT');
  return { agent, live, inject, out: () => out };
}

const permission = {
  id: 'p1',
  kind: 'permission',
  question: 'autoriser Bash(ls) ?',
  options: [
    { label: 'Autoriser une fois', answer: 'yes' },
    { label: 'Toujours pour ls', answer: 'always' },
    { label: 'Refuser', answer: 'no' },
  ],
};

test('aperçu : les dernières lignes non vides de l’écran, bornées', async () => {
  const { live, inject } = await spawn('shell');
  live.pty.write('echo un; echo deux; echo trois\r');
  await waitFor(() => live.mirror.screen().some((l) => l === 'trois'), 5000, 'trois');
  const r = await inject('GET', 'screen?lines=2');
  expect(r.statusCode).toBe(200);
  expect(r.json().lines).toHaveLength(2);
  expect((await inject('GET', 'screen?lines=500')).json().lines.length).toBeLessThanOrEqual(40);
  expect(
    (
      await c!.t.d.app.inject({
        method: 'GET',
        url: '/api/agents/ag_x/screen',
        headers: c!.t.headers,
      })
    ).statusCode,
  ).toBe(404);
});

test('message : tapé puis Entrée ; plusieurs lignes en collage encadré ; contrôles refusés', async () => {
  const { inject, out, live } = await spawn('shell');
  expect((await inject('POST', 'input', { text: 'echo salut-$((40+2))' })).statusCode).toBe(202);
  await waitFor(() => out().includes('salut-42'), 5000, 'écho');
  expect((await inject('POST', 'input', { text: 'a\u001b[201~; rm -rf /' })).statusCode).toBe(422);
  expect((await inject('POST', 'input', { text: '   ' })).statusCode).toBe(422);
  const writes: string[] = [];
  const write = live.pty.write.bind(live.pty);
  live.pty.write = (d: string | Buffer) => {
    writes.push(String(d));
    write(d);
  };
  await inject('POST', 'input', { text: 'ligne 1\r\nligne 2' });
  expect(writes[0]).toBe('\u001b[200~ligne 1\nligne 2\u001b[201~');
  await waitFor(() => writes.includes('\r'), 2000, 'Entrée');
});

test('répondre : la touche part seulement si l’écran montre l’option, puis la demande est close', async () => {
  const { agent, live, inject, out } = await spawn('claude');
  live.pty.write('ask\r');
  await waitFor(() => live.mirror.screen().some((l) => l.includes('1. Yes')), 5000, 'invite');
  c!.t.store.append({
    source: 'hook:claude',
    type: 'agent.status',
    agentId: agent.id,
    data: { status: 'needs_input', reason: 'permission', pending: permission },
  });
  // un message pendant une demande irait dans le dialogue
  expect((await inject('POST', 'input', { text: 'bonjour' })).statusCode).toBe(409);
  // « 2. No » à l'écran, pas « 2. Yes » : « Toujours » n'est plus proposé par le terminal
  const always = await inject('POST', 'answer', { pendingId: 'p1', answer: 'always' });
  expect(always.statusCode).toBe(409);
  expect(always.json().error).toContain('ouvrir le terminal');
  expect((await inject('POST', 'answer', { pendingId: 'p0', answer: 'yes' })).statusCode).toBe(409);
  expect((await inject('POST', 'answer', { pendingId: 'p1', answer: '7' })).statusCode).toBe(422);
  const before = out().length;
  expect((await inject('POST', 'answer', { pendingId: 'p1', answer: 'yes' })).statusCode).toBe(202);
  await waitFor(() => out().slice(before).includes('1'), 3000, 'touche 1');
  expect(c!.t.store.since(null).find((e) => e.type === 'approval.resolved')?.data).toEqual({
    pendingId: 'p1',
    option: 'yes',
    by: 'human',
  });
  const row = c!.t.db.prepare('SELECT pending FROM agents WHERE id = ?').get(agent.id) as {
    pending: string | null;
  };
  expect(row.pending).toBeNull();
});

test('écran attendu pour chaque réponse', () => {
  const ask = [
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. Yes, and don’t ask again for ls',
    '  3. No',
  ];
  expect(screenShows(ask, { label: 'x', answer: 'yes' })).toBe(true);
  expect(screenShows(ask, { label: 'x', answer: 'always' })).toBe(true);
  expect(screenShows(['$ '], { label: 'x', answer: 'no' })).toBe(false);
  const q = ['❯ 1. Point-virgule (Excel FR)', '  2. Virgule'];
  expect(screenShows(q, { label: 'Virgule', answer: '2' })).toBe(true);
  expect(screenShows(q, { label: 'Virgule', answer: '1' })).toBe(false);
  expect(screenShows(q, { label: 'Point-virgule (Excel FR)', answer: '1' })).toBe(true);
});

test('pause : le groupe est stoppé (état T), reprise, refus en double ; arrêter un agent en pause marche', async () => {
  const { agent, live, inject } = await spawn('shell');
  const stat = () =>
    execFileSync('ps', ['-o', 'stat=', '-p', String(live.pty.pid)], { encoding: 'utf8' });
  expect((await inject('POST', 'pause')).statusCode).toBe(202);
  await waitFor(() => stat().includes('T'), 3000, 'stoppé');
  expect((await inject('POST', 'pause')).statusCode).toBe(409);
  expect((await inject('POST', 'input', { text: 'echo x' })).statusCode).toBe(409);
  const paused = c!.t.db.prepare('SELECT paused_at FROM agents WHERE id = ?').get(agent.id) as {
    paused_at: string | null;
  };
  expect(paused.paused_at).not.toBeNull();
  expect((await inject('POST', 'resume')).statusCode).toBe(202);
  await waitFor(() => !stat().includes('T'), 3000, 'repris');
  await inject('POST', 'pause');
  await waitFor(() => stat().includes('T'), 3000, 'stoppé de nouveau');
  // relancé avant le signal d'arrêt : il sort tout de suite, sans attendre le SIGKILL
  const t0 = Date.now();
  await c!.t.d.agents.stop(agent.id, 'user', 4000);
  expect(live.exited).toBe(true);
  expect(Date.now() - t0).toBeLessThan(2500);
});

test('un agent ne pilote rien : ces routes refusent le token de run', async () => {
  const { agent, inject } = await spawn('shell');
  const h = {
    host: c!.t.headers.host!,
    authorization: `Bearer ${issueRunToken(c!.t.d.auth, agent.runId)}`,
  };
  for (const [m, p, body] of [
    ['GET', 'screen', undefined],
    ['POST', 'input', { text: 'x' }],
    ['POST', 'answer', { pendingId: 'p', answer: 'yes' }],
    ['POST', 'pause', undefined],
  ] as const)
    expect((await inject(m, p, body, h)).statusCode, p).toBe(403);
});
