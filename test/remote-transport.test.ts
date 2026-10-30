import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Server } from '../src/shared/model.js';
import {
  remoteArgv,
  remoteCommand,
  remoteExec,
  remoteSpawn,
  shQuote,
} from '../src/daemon/remote/transport.js';

const FAKE_SSH = resolve(__dirname, 'fixtures/fake-ssh.sh');

type Conn = Pick<Server, 'mode' | 'target' | 'sshOptions' | 'loadProfile' | 'shell'>;
const alias: Conn = {
  mode: 'ssh_alias',
  target: 'vps',
  sshOptions: null,
  loadProfile: true,
  shell: 'bash',
};

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sandbox(extra: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aid-ssh-'));
  homes.push(home);
  const log = join(home, 'ssh.log');
  return { home, log, env: { ...process.env, FAKE_SSH_HOME: home, FAKE_SSH_LOG: log, ...extra } };
}

test('shQuote : tout est littéral, apostrophes comprises', () => {
  expect(shQuote('a b')).toBe(`'a b'`);
  expect(shQuote(`l'été $HOME`)).toBe(`'l'\\''été $HOME'`);
  expect(remoteCommand({ shell: 'zsh' }, 'ls ~')).toBe(`'zsh' -lc 'ls ~'`);
});

test('argv par mode : options ssh avant `--`, destination ensuite, commande en un seul argument', () => {
  expect(remoteArgv(alias, 'uptime', { ssh: 'ssh' })).toEqual({
    file: 'ssh',
    args: [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      '-T',
      '--',
      'vps',
      `'bash' -lc 'uptime'`,
    ],
  });
  const host: Conn = {
    mode: 'ssh_host',
    target: '57.129.159.207',
    sshOptions: { port: 2222, user: 'debian', identityFile: '~/.ssh/id_ovh', jump: 'bastion' },
    loadProfile: true,
    shell: 'bash',
  };
  expect(remoteArgv(host, 'uptime').args).toEqual([
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    '-T',
    '-p',
    '2222',
    '-l',
    'debian',
    '-i',
    '~/.ssh/id_ovh',
    '-J',
    'bastion',
    '--',
    '57.129.159.207',
    `'bash' -lc 'uptime'`,
  ]);
  const cmd: Conn = {
    mode: 'command',
    target: 'ssh vps',
    sshOptions: null,
    loadProfile: true,
    shell: 'bash',
  };
  expect(remoteArgv(cmd, 'uptime', { env: { SHELL: '/bin/zsh' } })).toEqual({
    file: '/bin/zsh',
    args: ['-ic', `ssh vps ''\\''bash'\\'' -lc '\\''uptime'\\'''`],
  });
  expect(remoteArgv({ ...cmd, loadProfile: false }, 'uptime')).toEqual({
    file: '/bin/sh',
    args: ['-c', `ssh vps ''\\''bash'\\'' -lc '\\''uptime'\\'''`],
  });
  // profil demandé mais SHELL inconnu : erreur dite, jamais un /bin/sh -ic qui ne le chargerait pas
  expect(() => remoteArgv(cmd, 'uptime', { env: {} })).toThrow(/SHELL absent/);
  // flux longs : sondes de vie ssh en plus
  expect(remoteArgv(alias, 'x', { keepAlive: true }).args).toContain('ServerAliveInterval=15');
  expect(remoteArgv(alias, 'x').args).not.toContain('ServerAliveInterval=15');
});

test('remoteExec : sortie, code, durée ; la commande arrive intacte sur le « serveur »', async () => {
  const s = sandbox();
  const r = await remoteExec(alias, `printf '%s' "l'été" && echo " $HOME"`, {
    ssh: FAKE_SSH,
    env: s.env,
  });
  expect(r).toMatchObject({ code: 0, timedOut: false, truncated: false });
  expect(r.stdout).toBe(`l'été ${s.home}\n`);
  expect(r.durationMs).toBeGreaterThanOrEqual(0);
  expect(readFileSync(s.log, 'utf8')).toBe(
    `vps\t'bash' -lc 'printf '\\''%s'\\'' "l'\\''été" && echo " $HOME"'\n`,
  );

  const fail = await remoteExec(alias, 'echo non >&2; exit 3', { ssh: FAKE_SSH, env: s.env });
  expect(fail).toMatchObject({ code: 3, stderr: 'non\n' });
});

test('remoteExec : connexion refusée, délai dépassé, sortie bornée, binaire absent', async () => {
  const refused = await remoteExec(alias, 'true', {
    ssh: FAKE_SSH,
    env: sandbox({ FAKE_SSH_FAIL: '1' }).env,
  });
  expect(refused.code).toBe(255);
  expect(refused.stderr).toContain('Connection refused');

  const slow = await remoteExec(alias, 'true', {
    ssh: FAKE_SSH,
    env: sandbox({ FAKE_SSH_DELAY: '5' }).env,
    timeoutMs: 200,
  });
  expect(slow).toMatchObject({ timedOut: true, code: null });

  const big = await remoteExec(alias, 'yes x | head -c 5000', {
    ssh: FAKE_SSH,
    env: sandbox().env,
    maxBytes: 100,
  });
  expect(big.stdout).toHaveLength(100);
  expect(big.truncated).toBe(true);

  const missing = await remoteExec(alias, 'true', { ssh: '/nonexistent/ssh', env: sandbox().env });
  expect(missing.code).toBeNull();
  expect(missing.stderr).toMatch(/ENOENT/);

  // spawn qui lève de façon synchrone (octet nul) : un résultat, jamais une promesse rejetée
  const nul = await remoteExec(alias, 'echo a\0b', { ssh: FAKE_SSH, env: sandbox().env });
  expect(nul.code).toBeNull();
  expect(nul.stderr).not.toBe('');
});

test('délai dépassé : tout le groupe meurt, petit-enfant compris, y compris en mode commande', async () => {
  const s = sandbox();
  const mark = join(s.home, 'vivant');
  const late = `sleep 1; touch ${mark}`;
  const viaAlias = await remoteExec(alias, late, { ssh: FAKE_SSH, env: s.env, timeoutMs: 200 });
  expect(viaAlias).toMatchObject({ timedOut: true, code: null });

  // une fonction de shell empêche l'`exec` du dernier maillon : sh reste parent du faux ssh
  const wrapped: Conn = {
    mode: 'command',
    target: `w() { ${shQuote(FAKE_SSH)} vps "$@"; }; w`,
    sshOptions: null,
    loadProfile: false,
    shell: 'sh',
  };
  const viaCommand = await remoteExec(wrapped, late, { env: s.env, timeoutMs: 200 });
  expect(viaCommand).toMatchObject({ timedOut: true, code: null });

  await sleep(1500);
  expect(existsSync(mark)).toBe(false);
});

test('mode commande locale : le préfixe reçoit la commande distante en argument', async () => {
  const s = sandbox();
  const cmd: Conn = {
    mode: 'command',
    target: `${shQuote(FAKE_SSH)} vps`,
    sshOptions: null,
    loadProfile: false,
    shell: 'sh',
  };
  const r = await remoteExec(cmd, 'echo ok', { env: s.env });
  expect(r).toMatchObject({ code: 0, stdout: 'ok\n' });
});

test('remoteSpawn : flux ouverts dans les deux sens', async () => {
  const child = remoteSpawn(alias, 'read l; echo "reçu $l"', { ssh: FAKE_SSH, env: sandbox().env });
  let out = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString()));
  child.stdin.end('bonjour\n');
  const code = await new Promise((r) => child.on('close', r));
  expect(code).toBe(0);
  expect(out).toBe('reçu bonjour\n');
});

test('remoteSpawn : ssh absent ou stdin fermé, jamais d’exception non capturée', async () => {
  const missing = remoteSpawn(alias, 'true', { ssh: '/nonexistent/ssh', env: sandbox().env });
  await new Promise((r) => missing.on('close', r));
  missing.stdin.write('après la mort\n');

  const done = remoteSpawn(alias, 'true', { ssh: FAKE_SSH, env: sandbox().env });
  await new Promise((r) => done.on('close', r));
  done.stdin.write('après la fin\n');
  await sleep(50);
});
