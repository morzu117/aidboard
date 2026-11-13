import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AidHttpError } from '../src/daemon/errors.js';
import { LogWriter } from '../src/daemon/pty/log.js';
import { agentCommand, agentEnv, meshEnv, resolveOnPath } from '../src/daemon/pty/spawn.js';
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
  // AID_CLI, AID_HOOK, AID_NODE (hooks) n'existent que si la CLI est construite
  const hooks = existsSync(join(import.meta.dirname, '../dist/cli/aid.js'))
    ? 'AID_CLI,AID_HOOK,AID_NODE,'
    : '';
  expect(a.out()).toContain(
    `AIDVARS=AID_AGENT,${hooks}AID_RUN,AID_SPOOL,AID_TOKEN,AID_TOPIC,AID_URL,`,
  );
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

// 12.6 (D38) : la cell swarph en PTY. Faux swarph (D40) ; jamais le token dans l'environnement.
const FAKE_SWARPH = join(import.meta.dirname, 'fixtures/fake-swarph.sh');

test('agentCommand et meshEnv pour swarph-cell : la commande spawn, l’environnement du mesh pour cette cell seulement', () => {
  const mesh = { bin: '/opt/swarph', cellFile: '/home/moi/.config/swarph/cells/cell-aid.yaml' };
  expect(agentCommand('swarph-cell', {}, mesh)).toEqual([
    '/opt/swarph',
    'spawn',
    mesh.cellFile,
    '--no-starter',
    '--no-banner',
  ]);
  expect(() => agentCommand('swarph-cell', {})).toThrow(/mesh non configuré/);
  const cfg = { gateway: 'http://gw.example:8788', stateRoot: '/home/moi/swarph_state' };
  expect(meshEnv('swarph-cell', cfg)).toEqual({
    MESH_GATEWAY_URL: 'http://gw.example:8788',
    SWARPH_STATE: '/home/moi/swarph_state',
  });
  expect(meshEnv('claude', cfg)).toEqual({});
  expect(meshEnv('swarph-cell', { gateway: '', stateRoot: '' })).toEqual({});
});

test('swarph-cell : une session par cell (409), MESH_GATEWAY_URL et SWARPH_STATE dans son PTY, jamais sans mesh.cell', async () => {
  process.env.SHELL = '/bin/sh';
  const home = mkdtempSync(join(tmpdir(), 'aid-cell-'));
  const { DEFAULT_CONFIG } = await import('../src/daemon/config.js');
  c = await setupWorkspace({
    config: {
      mesh: {
        ...DEFAULT_CONFIG.mesh,
        bin: FAKE_SWARPH,
        cell: 'cell-aid',
        cellFile: join(home, 'cell-aid.yaml'),
        gateway: 'http://gateway.example:8788',
        stateRoot: join(home, 'swarph_state'),
      },
    },
  });
  const topic = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'swarph-cell' });
  expect(agent.kind).toBe('swarph-cell');
  expect(agent.command).toEqual([
    FAKE_SWARPH,
    'spawn',
    join(home, 'cell-aid.yaml'),
    '--no-starter',
    '--no-banner',
  ]);
  let text = '';
  c.t.d.agents.get(agent.id)!.subscribe((chunk) => (text += chunk));
  await waitFor(() => text.includes('SWARPH_SELF='), 5000, 'sortie de la cell');
  expect(text).toContain(
    `FAKE_CELL cell=${join(home, 'cell-aid.yaml')} args=--no-starter --no-banner`,
  );
  expect(text).toContain('MESH_GATEWAY_URL=http://gateway.example:8788');
  expect(text).toContain(`SWARPH_STATE=${join(home, 'swarph_state')}`);
  // D314 : SWARPH_SELF vient de la config de ce mesh.
  expect(text).toContain(`SWARPH_SELF=${c.t.d.mesh!.current().cell}`);
  // une seconde cell : refusée tant que la première vit
  expect(() => c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'swarph-cell' })).toThrow(
    expect.objectContaining({ status: 409, message: expect.stringContaining('déjà ouverte') }),
  );
  // un claude ordinaire n'hérite rien du mesh
  const shell = c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'shell' });
  let sh = '';
  c.t.d.agents.get(shell.id)!.subscribe((chunk) => (sh += chunk));
  c.t.d.agents
    .get(shell.id)!
    .pty.write('echo "GW=[$MESH_GATEWAY_URL]"; echo "ST=[$SWARPH_STATE]"\n');
  // la ligne tapée revient d'abord en écho par le terminal (`echo "ST=[$SWARPH_STATE]"`) : on
  // attend la ligne produite par le shell, en début de ligne et complète, pas l'écho de la commande
  await waitFor(() => /\nST=\[.*\]\r?\n/.test(sh), 5000, 'shell');
  expect(sh).toContain('GW=[]');
  expect(sh).toContain('ST=[]');
  c.t.d.agents.get(agent.id)!.pty.write('quit\n');
  await waitFor(
    () => c.t.store.since(null).find((e) => e.type === 'agent.exited' && e.agentId === agent.id),
    10_000,
    'sortie de la cell',
  );
  // la cell sortie, une nouvelle peut s'ouvrir
  const again = c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'swarph-cell' });
  expect(again.kind).toBe('swarph-cell');
});

test('swarph-cell sans mesh.cell : 409, aucun agent créé', async () => {
  process.env.SHELL = '/bin/sh';
  c = await setupWorkspace();
  const topic = await makeTopic(c);
  expect(() => c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'swarph-cell' })).toThrow(
    expect.objectContaining({ status: 409, message: expect.stringContaining('mesh désactivé') }),
  );
  expect(c.t.db.prepare('SELECT count(*) AS n FROM agents').get()).toEqual({ n: 0 });
});
// 14.2 : CLI direct, environnement commun et coexistence des deux genres de cell.
const FAKE_SWAIRM = join(import.meta.dirname, 'fixtures/fake-swairm.sh');

test('swairm-cell : commande exacte et configuration obligatoire, sans environnement mesh ajouté', () => {
  expect(agentCommand('swairm-cell', {}, undefined, { bin: FAKE_SWAIRM })).toEqual([
    FAKE_SWAIRM,
    'cell',
  ]);
  expect(() => agentCommand('swairm-cell', {})).toThrow(/swairm non configuré/);
  expect(() => agentCommand('swairm-cell', {}, undefined, { bin: '' })).toThrow(
    /swairm non configuré/,
  );
  expect(meshEnv('swairm-cell', { gateway: 'http://mesh.invalid', stateRoot: '/mesh' })).toEqual(
    {},
  );
  const env = agentEnv({}, [], { AID_TOPIC: 'topic-test' });
  expect(env).toEqual({ TERM: 'xterm-256color', COLORTERM: 'truecolor', AID_TOPIC: 'topic-test' });
});

test('swairm-cell : cwd, terminal, présence des AID et lectures locales sans ajout mesh ni GitHub', async () => {
  const { DEFAULT_CONFIG } = await import('../src/daemon/config.js');
  c = await setupWorkspace({
    config: {
      swairm: { bin: FAKE_SWAIRM },
      mesh: { ...DEFAULT_CONFIG.mesh, gateway: 'http://mesh.invalid', stateRoot: '/mesh' },
      env: {
        strip: [
          ...DEFAULT_CONFIG.env.strip,
          'MESH_GATEWAY_URL',
          'SWARPH_STATE',
          'SWARPH_SELF',
          'GH_TOKEN',
          'GITHUB_TOKEN',
        ],
      },
    },
  });
  const topic = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'swairm-cell' });
  expect(agent).toMatchObject({ kind: 'swairm-cell', transport: 'pty', cwd: topic.wt });
  expect(agent.command).toEqual([FAKE_SWAIRM, 'cell']);
  const live = c.t.d.agents.get(agent.id)!;
  let text = '';
  live.subscribe((chunk) => (text += chunk));
  await waitFor(() => text.includes('swairm> '), 5000, 'invite Swairm');
  expect(text).toContain(`FAKE_SWAIRM cwd=${topic.wt} argc=1 args=cell`);
  expect(text).toContain('TERM=xterm-256color COLORTERM=truecolor');
  for (const key of ['AID_URL', 'AID_TOKEN', 'AID_TOPIC', 'AID_RUN', 'AID_AGENT', 'AID_SPOOL'])
    expect(text).toContain(`${key}=present`);
  for (const key of ['MESH_GATEWAY_URL', 'SWARPH_STATE', 'SWARPH_SELF', 'GH_TOKEN', 'GITHUB_TOKEN'])
    expect(text).toContain(`${key}=absent`);
  live.pty.write('help\nstatus\ninbox\nevents\n');
  await waitFor(() => text.includes('events: empty'), 5000, 'lectures locales');
  expect(text).toContain('help status inbox events quit');
  expect(text).toContain('status: ready');
  expect(text).toContain('inbox: empty');
  live.pty.write('quit\n');
  await waitFor(() => live.exited, 5000, 'quit Swairm');
  expect(live.exit).toMatchObject({ exitCode: 0, reason: 'exit' });
  expect(c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'swairm-cell' }).kind).toBe(
    'swairm-cell',
  );
});

test('swairm-cell et swarph-cell peuvent coexister', async () => {
  const { DEFAULT_CONFIG } = await import('../src/daemon/config.js');
  const home = mkdtempSync(join(tmpdir(), 'aid-swairm-mesh-'));
  c = await setupWorkspace({
    config: {
      swairm: { bin: FAKE_SWAIRM },
      mesh: {
        ...DEFAULT_CONFIG.mesh,
        bin: FAKE_SWARPH,
        cell: 'test-cell',
        cellFile: join(home, 'cell.yaml'),
        stateRoot: join(home, 'state'),
      },
    },
  });
  const { topicId } = await makeTopic(c);
  const swarph = c.t.d.agents.spawn({ topicId, kind: 'swarph-cell' });
  const swairm = c.t.d.agents.spawn({ topicId, kind: 'swairm-cell' });
  for (const agent of [swarph, swairm]) {
    const live = c.t.d.agents.get(agent.id)!;
    await waitFor(() => live.mirror.screen().length > 0, 5000, 'cell prête');
    expect(live.exited).toBe(false);
  }
  expect(
    c.t.d.agents
      .liveAgents()
      .map((a) => a.kind)
      .sort(),
  ).toEqual(['swairm-cell', 'swarph-cell']);
});
