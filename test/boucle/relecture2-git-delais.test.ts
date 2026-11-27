import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { gitBoucle } from '../../src/daemon/boucle/git.js';
import { makeOriginAndClone } from '../helpers/git.js';

vi.mock('node:child_process', { spy: true });

let racine: string;
let depot: string;

beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), 'aid-relecture-git-delais-'));
  const home = join(racine, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(home, 'aid'));
  ({ clone: depot } = makeOriginAndClone(racine));
  vi.mocked(execFile).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(racine, { recursive: true, force: true });
});

test('gitBoucle donne plus de temps à worktree add et status --ignored', async () => {
  await gitBoucle(depot, ['rev-parse', 'HEAD']);
  await gitBoucle(depot, ['status', '--porcelain', '--ignored']);
  await gitBoucle(depot, ['worktree', 'add', '--detach', join(racine, 'annexe'), 'HEAD']);

  const appels = vi.mocked(execFile).mock.calls;
  const delais = appels
    .filter(([programme]) => programme === 'git')
    .map(([, , options]) => (options as { timeout: number }).timeout);
  expect(delais).toHaveLength(3);
  expect(delais[0]).toBeGreaterThan(0);
  expect.soft(delais[1]).toBeGreaterThan(delais[0]!);
  expect(delais[2]).toBeGreaterThan(delais[0]!);
});
