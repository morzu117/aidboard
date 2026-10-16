import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AidHttpError } from '../src/daemon/errors.js';
import { LogWriter } from '../src/daemon/pty/log.js';
import { agentCommand, agentEnv, resolveOnPath } from '../src/daemon/pty/spawn.js';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

const FAKE_AGENT = join(import.meta.dirname, 'fixtures/fake-agent.sh');
const saved = { SHELL: process.env.SHELL, PATH: process.env.PATH };
let c: Ctx;

afterEach(async () => {
  process.env.SHELL = saved.SHELL;
  process.env.PATH = saved.PATH;
  delete process.env.ANTHROPIC_API_KEY;
  await c?.t.d.stop();
});

async function start(shell: string, title?: string) {
  process.env.SHELL = shell;
  c = await setupWorkspace();
  const topic = await makeTopic(c, title);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'shell' });
  let text = '';
  c.t.d.agents.get(agent.id)!.subscribe((chunk) => (text += chunk));
  return {
    agent,
    topic,
    out: () => text,
    type: (s: string) => c.t.d.agents.get(agent.id)!.pty.write(s),
    exited: () =>
      waitFor(
        () =>
          c.t.store.since(null).find((e) => e.type === 'agent.exited' && e.agentId === agent.id),
        10_000,
        'sortie de l’agent',
      ),
    status: () =>
      (c.t.db.prepare('SELECT status FROM agents WHERE id = ?').get(agent.id) as { status: string })
        .status,
  };
}

test('un shell démarre dans le worktree du sujet', async () => {
  const a = await start('/bin/sh');
  expect(a.agent).toMatchObject({
    kind: 'shell',
    transport: 'pty',
    status: 'starting',
    cwd: a.topic.wt,
  });
  a.type('echo "ICI=$(pwd)"\n');
  await waitFor(() => a.out().includes(`ICI=${a.topic.wt}`), 5000, 'pwd');
  expect(c.t.db.prepare('SELECT status, pid FROM agents WHERE id = ?').get(a.agent.id)).toEqual({
    status: 'starting',
    pid: a.agent.pid,
  });
});

test('ANTHROPIC_API_KEY n’atteint jamais le processus enfant, les AID_* y sont', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ne-doit-pas-passer';
  const a = await start('/bin/sh');
  a.type('echo "CLE=$(printenv ANTHROPIC_API_KEY | wc -c | tr -d \' \')"\n');
  a.type('echo "AIDVARS=$(env | grep ^AID_ | cut -d= -f1 | sort | tr \'\\n\' ,)"\n');
  a.type('echo "TOK=$AID_TOKEN"; echo "TOP=$AID_TOPIC"; echo "RUN=$AID_RUN"\n');
  await waitFor(() => /RUN=run_\w+/.test(a.out()), 5000, 'variables');
  expect(a.out()).toContain('CLE=0');
  expect(a.out()).toContain('AIDVARS=AID_AGENT,AID_RUN,AID_TOKEN,AID_TOPIC,AID_URL,');
  expect(a.out()).toContain(`TOP=${a.topic.topicId}`);
  const token = /TOK=([A-Za-z0-9_-]{20,})/.exec(a.out())![1]!;
  expect(c.t.d.auth.runTokens.get(token)).toBe(a.agent.runId);
});

test('quit : agent.exited code 0 et statut done ; fail : code 3 et statut error', async () => {
  const ok = await start(FAKE_AGENT);
  ok.type('quit\n');
  expect((await ok.exited()).data).toMatchObject({ exitCode: 0, reason: 'exit' });
  expect(ok.status()).toBe('done');
  await c.t.d.stop();
  const ko = await start(FAKE_AGENT);
  ko.type('fail\n');
  expect((await ko.exited()).data).toMatchObject({ exitCode: 3 });
  expect(ko.status()).toBe('error');
});

test('un agent tué de l’extérieur est en erreur, pas « terminé »', async () => {
  const a = await start('/bin/sh');
  process.kill(a.agent.pid!, 'SIGKILL');
  const e = await a.exited();
  expect(e.data.exitCode).toBeNull();
  expect(a.status()).toBe('error');
});

test('stop user sur un sleep : stopped en moins de 6 s', async () => {
  const a = await start('/bin/sh');
  a.type('sleep 300\n');
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  await c.t.d.agents.stop(a.agent.id, 'user');
  expect(Date.now() - t0).toBeLessThan(6000);
  expect((await a.exited()).data.reason).toBe('user');
  expect(a.status()).toBe('stopped');
});

test('stopAll ne laisse aucun processus', async () => {
  const a = await start('/bin/sh');
  const b = c.t.d.agents.spawn({ topicId: a.topic.topicId, kind: 'shell' });
  a.type('sleep 300\n');
  await c.t.d.agents.stopAll('daemon_stop', 5000);
  for (const pid of [a.agent.pid!, b.pid!]) expect(() => process.kill(pid, 0)).toThrow();
  const reasons = c.t.store
    .since(null)
    .filter((e) => e.type === 'agent.exited')
    .map((e) => e.data.reason);
  expect(reasons).toEqual(['daemon_stop', 'daemon_stop']);
});

test('un binaire absent du PATH : 422 et aucun agent créé', async () => {
  process.env.SHELL = '/bin/sh';
  c = await setupWorkspace();
  const { topicId } = await makeTopic(c);
  process.env.PATH = '/nexiste/pas';
  expect(() => c.t.d.agents.spawn({ topicId, kind: 'claude' })).toThrow(AidHttpError);
  process.env.PATH = saved.PATH;
  expect(c.t.db.prepare('SELECT count(*) c FROM agents').get()).toEqual({ c: 0 });
});

test('worktree introuvable : 409 ; sujet archivé : 409 ; sujet inconnu : 404', async () => {
  process.env.SHELL = '/bin/sh';
  c = await setupWorkspace();
  const { topicId, wt } = await makeTopic(c);
  rmSync(wt, { recursive: true, force: true });
  expect(() => c.t.d.agents.spawn({ topicId, kind: 'shell' })).toThrow(/worktree introuvable/);
  c.t.store.append({ source: 'daemon', type: 'topic.state', topicId, data: { state: 'archived' } });
  expect(() => c.t.d.agents.spawn({ topicId, kind: 'shell' })).toThrow(/pas actif/);
  expect(() => c.t.d.agents.spawn({ topicId: 'tp_nope', kind: 'shell' })).toThrow(/inconnu/);
});

test('le journal brut est écrit en 0600', async () => {
  const a = await start('/bin/sh');
  a.type('echo JOURNAL-OK\n');
  await waitFor(() => a.out().includes('JOURNAL-OK'), 5000, 'sortie');
  const log = join(c.t.home, 'logs', `${a.agent.id}.log`);
  expect(readFileSync(log, 'utf8')).toContain('JOURNAL-OK');
  expect(statSync(log).mode & 0o777).toBe(0o600);
});

test('rotation : 2 Mio écrits avec une limite de 1 Mio gardent .log sous la limite et un .log.1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aid-log-'));
  const path = join(dir, 'a.log');
  const w = new LogWriter(path, 1024 * 1024);
  const line = `${'x'.repeat(1023)}\n`;
  for (let i = 0; i < 2048; i++) w.write(line);
  w.close();
  expect(existsSync(`${path}.1`)).toBe(true);
  expect(statSync(path).size).toBeLessThanOrEqual(1024 * 1024);
  expect(statSync(`${path}.1`).size).toBeLessThanOrEqual(1024 * 1024);
});

test('agentCommand, resolveOnPath et agentEnv', () => {
  expect(agentCommand('claude', {})).toEqual(['claude']);
  expect(agentCommand('codex', {})).toEqual(['codex']);
  expect(agentCommand('shell', { SHELL: '/bin/zsh' })).toEqual(['/bin/zsh', '-l']);
  expect(agentCommand('shell', {})).toEqual(['/bin/bash', '-l']);
  expect(resolveOnPath('sh', '/nexiste:/bin')).toBe('/bin/sh');
  expect(resolveOnPath('sh-absent', '/bin')).toBeNull();
  expect(resolveOnPath('/bin/sh', '')).toBe('/bin/sh');
  const env = agentEnv(
    { PATH: '/bin', ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y' },
    ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    {
      AID_TOPIC: 't',
    },
  );
  expect(env).toEqual({
    PATH: '/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    AID_TOPIC: 't',
  });
});

test('agentEnv retire les marqueurs d’une session Claude Code héritée, pas la configuration de l’utilisateur', () => {
  const env = agentEnv(
    {
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/x.sock',
      CLAUDE_PID: '12',
      CLAUDE_AGENT_SDK_VERSION: '1',
      CLAUDE_CONFIG_DIR: '/home/moi/.claude-pro',
      CLAUDE_CODE_USE_BEDROCK: '1',
    },
    [],
    {},
  );
  expect(Object.keys(env).sort()).toEqual([
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CONFIG_DIR',
    'COLORTERM',
    'PATH',
    'TERM',
  ]);
});

test('agent.spawned porte kind, role, cwd, pid et commande (schéma d’événements de la spec)', async () => {
  const a = await start('/bin/sh');
  const e = c.t.store.since(null).find((x) => x.type === 'agent.spawned')!;
  expect(e.data).toMatchObject({ kind: 'shell', role: 'free', cwd: a.topic.wt, pid: a.agent.pid });
  expect(e.data.command).toEqual(a.agent.command);
});
