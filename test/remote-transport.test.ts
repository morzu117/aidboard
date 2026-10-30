import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
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

function sandbox(extra: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aid-ssh-'));
  const log = join(home, 'ssh.log');
  return { home, log, env: { ...process.env, FAKE_SSH_HOME: home, FAKE_SSH_LOG: log, ...extra } };
}

test('shQuote : tout est littéral, apostrophes comprises', () => {
  expect(shQuote('a b')).toBe(`'a b'`);
  expect(shQuote(`l'été $HOME`)).toBe(`'l'\\''été $HOME'`);
  expect(remoteCommand({ shell: 'zsh' }, 'ls ~')).toBe(`zsh -lc 'ls ~'`);
});

test('argv par mode : options ssh avant `--`, destination ensuite, commande en un seul argument', () => {
  expect(remoteArgv(alias, 'uptime', { ssh: 'ssh' })).toEqual({
    file: 'ssh',
    args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T', '--', 'vps', `bash -lc 'uptime'`],
  });
  const host: Conn = {
    mode: 'ssh_host',
    target: '203.0.113.10',
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
    '203.0.113.10',
    `bash -lc 'uptime'`,
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
    args: ['-ic', `ssh vps 'bash -lc '\\''uptime'\\'''`],
  });
  expect(remoteArgv({ ...cmd, loadProfile: false }, 'uptime')).toEqual({
    file: '/bin/sh',
    args: ['-c', `ssh vps 'bash -lc '\\''uptime'\\'''`],
  });
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
  expect(readFileSync(s.log, 'utf8').split('\t')[0]).toBe('vps');

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
  expect(slow.timedOut).toBe(true);
  expect(slow.code).not.toBe(0);

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
});

test('mode commande locale : le préfixe reçoit la commande distante en argument', async () => {
  const s = sandbox();
  const cmd: Conn = {
    mode: 'command',
    target: `${FAKE_SSH} vps`,
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
