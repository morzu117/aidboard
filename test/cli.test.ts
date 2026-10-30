import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { waitFor } from './helpers/daemon.js';
import { makeOriginAndClone } from './helpers/git.js';

const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
// Le gate construit avant de tester ; sans dist (npm test seul) ces tests n'ont rien à lancer.
const built = existsSync(CLI);

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

let home = '';
// la gate peut tourner dans un terminal A-I-D : ses AID_* viseraient le vrai daemon
const withoutAid = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('AID_')));
const run = (...args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        env: { ...withoutAid(process.env), AID_HOME: home, AID_NO_BROWSER: '1', SHELL: '/bin/sh' },
        timeout: 40_000,
      },
      (err, stdout, stderr) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr });
      },
    );
  });
const info = () =>
  JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as {
    pid: number;
    port: number;
    token: string;
  };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  if (home && existsSync(join(home, 'daemon.json'))) {
    const { pid } = info();
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

async function boot() {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-cli-')));
  writeFileSync(join(home, 'config.yaml'), `port: ${await freePort()}\n`, { mode: 0o600 });
}

describe.skipIf(!built)('aid en sous-processus', () => {
  test('status sans daemon, démarrage détaché, status, arrêt', async () => {
    await boot();
    expect(await run('status')).toEqual({ code: 0, out: 'daemon arrêté\n' });
    expect((await run('stop')).out).toBe('daemon arrêté\n');

    const start = await run();
    expect(start.code).toBe(0);
    const { pid, port, token } = info();
    expect(start.out).toContain(`http://127.0.0.1:${port}/?token=${token}`);
    expect(alive(pid)).toBe(true);
    expect(pid).not.toBe(process.pid);

    const status = await run('status');
    expect(status.out).toContain(`daemon en marche (pid ${pid}, port ${port}`);
    expect(status.out).toContain('0 sujet(s), 0 agent(s) vivant(s)');

    expect((await run()).code).toBe(0);
    expect(info().pid).toBe(pid);

    expect((await run('open')).out).toContain(`/?token=${token}`);
    expect((await run('stop')).code).toBe(0);
    await waitFor(() => !alive(pid), 5000, 'arrêt');
    expect(existsSync(join(home, 'daemon.json'))).toBe(false);
  }, 90_000);

  test('stop refuse tant qu’un agent vit (code 2), --force arrête tout sans processus orphelin', async () => {
    await boot();
    await run();
    const { pid, port, token } = info();
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const call = async (method: string, path: string, body?: object) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: h,
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.json() as Promise<
        Record<string, unknown> & {
          id?: string;
          pid?: number;
          topics?: Array<{ id: string; state?: string }>;
          actionId?: string;
        }
      >;
    };
    const { clone } = makeOriginAndClone(
      realpathSync(mkdtempSync(join(tmpdir(), 'aid-cli-repo-'))),
    );
    const ws = await call('POST', '/api/workspaces', { path: clone });
    const created = await call('POST', '/api/topics', {
      workspaceId: ws.id,
      title: 'Cli',
      type: 'feat',
    });
    let topicId = '';
    // Le sujet part en « draft » : son worktree n'est prêt (et donc un agent spawnable) qu'une
    // fois topic.create terminé et le sujet passé en « active ».
    await waitFor(
      () => {
        void call('GET', '/api/state').then((s) => {
          const t = s.topics?.[0];
          topicId = t?.state === 'active' ? (t.id ?? '') : '';
        });
        return topicId || undefined;
      },
      20_000,
      'sujet actif',
    );
    expect(created.actionId).toBeTruthy();
    const agent = await call('POST', '/api/agents', { topicId, kind: 'shell' });
    const agentPid = agent.pid as number;
    expect(alive(agentPid)).toBe(true);

    const refused = await run('stop');
    expect(refused.code).toBe(2);
    expect(refused.out).toContain('1 agent(s) tournent encore');
    expect(alive(pid)).toBe(true);
    expect(alive(agentPid)).toBe(true);

    const forced = await run('stop', '--force');
    expect(forced.code).toBe(0);
    await waitFor(() => !alive(pid) && !alive(agentPid), 8000, 'tout est arrêté');
  }, 90_000);

  test('un daemon.json resté d’un daemon mort : aid relance proprement', async () => {
    await boot();
    writeFileSync(
      join(home, 'daemon.json'),
      JSON.stringify({
        pid: 2147483646,
        port: 1,
        token: 'perime',
        startedAt: new Date().toISOString(),
      }),
    );
    expect((await run('status')).out).toBe('daemon arrêté\n');
    const start = await run();
    expect(start.code).toBe(0);
    expect(info().token).not.toBe('perime');
    expect((await run('stop')).code).toBe(0);
  }, 90_000);

  test('un arrêt par signal laisse sa trace dans daemon.log', async () => {
    await boot();
    expect((await run()).code).toBe(0);
    const { pid } = info();
    process.kill(pid, 'SIGTERM');
    await waitFor(() => !alive(pid), 15_000);
    const log = readFileSync(join(home, 'daemon.log'), 'utf8');
    expect(log).toMatch(/signal SIGTERM reçu : arrêt du daemon/);
    expect(log).toMatch(/daemon arrêté \(code 0\)/);
  }, 90_000);

  test('commande inconnue : code 1 ; --version et aide', async () => {
    await boot();
    expect((await run('nimporte')).code).toBe(1);
    expect((await run('--version')).out).toMatch(/^aidboard \d+\.\d+\.\d+/);
    expect((await run('help')).out).toContain('aid stop');
  });

  test('aid emit hors A-I-D : ses options passent, rien ne sort, code 0', async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-cli-')));
    const r = await run('emit', 'agent.status', '--status', 'working', '--reason', 'x');
    expect(r).toEqual({ code: 0, out: '' });
    expect(existsSync(join(home, 'spool'))).toBe(false);
  });
});
