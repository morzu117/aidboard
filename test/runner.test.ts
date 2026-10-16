import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runScript } from '../src/daemon/actions/runner.js';

const script = (name: string) => join(import.meta.dirname, 'fixtures/scripts', name);
const tmp = () => mkdtempSync(join(tmpdir(), 'aid-run-'));

function run(name: string, extra: Partial<Parameters<typeof runScript>[0]> = {}) {
  const dir = tmp();
  return {
    dir,
    promise: runScript({
      script: script(name),
      cwd: dir,
      env: { ...process.env },
      timeoutMs: 10_000,
      logPath: join(dir, 'out.log'),
      ...extra,
    }),
  };
}

test('code 0 : succeeded, stdout et stderr dans la queue', async () => {
  const { promise } = run('ok.sh');
  const out = await promise;
  expect(out).toMatchObject({ exitCode: 0, outcome: 'succeeded' });
  expect(out.tail.sort()).toEqual(['bonjour', 'erreur']);
});

test('code 2 : needs_human ; autre code : failed', async () => {
  expect((await run('human.sh').promise).outcome).toBe('needs_human');
  const fail = await run('fail.sh').promise;
  expect(fail).toMatchObject({ exitCode: 1, outcome: 'failed' });
});

test('::aid:: est fusionné, un JSON invalide reste une ligne ordinaire', async () => {
  const out = await run('result.sh').promise;
  expect(out.result).toEqual({ a: 1, b: 'x' });
  expect(out.tail).toEqual(['début', '::aid:: pas du json', 'fin']);
});

test('les lignes sont relayées une à une avec leur flux', async () => {
  const seen: Array<[string, string]> = [];
  await run('ok.sh', { onLine: ({ stream, line }) => seen.push([stream, line]) }).promise;
  expect(seen).toContainEqual(['stdout', 'bonjour']);
  expect(seen).toContainEqual(['stderr', 'erreur']);
});

test('la queue garde 50 lignes, dont une dernière ligne sans retour à la ligne', async () => {
  const out = await run('many.sh').promise;
  expect(out.tail).toHaveLength(50);
  expect(out.tail.at(-1)).toBe('sans retour');
  expect(out.tail[0]).toBe('ligne 72');
});

test('le journal contient la sortie brute et est en 0600', async () => {
  const r = run('ok.sh');
  await r.promise;
  const log = join(r.dir, 'out.log');
  expect(readFileSync(log, 'utf8')).toContain('bonjour');
  expect(statSync(log).mode & 0o777).toBe(0o600);
});

test('délai dépassé : failed, raison timeout, et les petits-enfants sont tués', async () => {
  const dir = tmp();
  const pidFile = join(dir, 'child.pid');
  const out = await runScript({
    script: script('sleeper.sh'),
    cwd: dir,
    env: { ...process.env, AID_CHILD_PID_FILE: pidFile },
    timeoutMs: 400,
    killGraceMs: 300,
    logPath: join(dir, 'out.log'),
  });
  expect(out).toMatchObject({ outcome: 'failed', reason: 'timeout' });
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
  await new Promise((r) => setTimeout(r, 200));
  expect(() => process.kill(pid, 0)).toThrow();
});

test('impossible de lancer (cwd absent) : failed, raison spawn', async () => {
  const dir = tmp();
  const out = await runScript({
    script: script('ok.sh'),
    cwd: join(dir, 'absent'),
    env: { ...process.env },
    timeoutMs: 5000,
    logPath: join(dir, 'out.log'),
  });
  expect(out).toMatchObject({ outcome: 'failed', reason: 'spawn' });
});
