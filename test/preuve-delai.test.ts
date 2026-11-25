import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { produirePreuves } from '../src/acceptation/preuve.js';

test('un délai dépassé compte comme un échec et le worktree est retiré', async () => {
  const depot = await mkdtemp(join(tmpdir(), 'aid-preuve-delai-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: depot,
      encoding: 'utf8',
    }).trim();
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Test acceptation');
    git('config', 'user.email', 'acceptation@example.com');
    git('remote', 'add', 'origin', 'https://example.com/exemple/depot.git');
    git('commit', '--allow-empty', '-m', 'Base');
    const base = git('rev-parse', 'HEAD');
    const fichier = 'test/recette.cjs';
    await mkdir(join(depot, 'test'));
    await writeFile(join(depot, fichier), 'setInterval(() => {}, 1000);\n');
    git('add', fichier);
    git('commit', '-m', 'Test', '-m', 'Acceptation: 67.4');
    const marque = git('rev-parse', 'HEAD');
    const worktrees = git('worktree', 'list', '--porcelain');

    const [rapport] = await produirePreuves(
      { depot, base, chemins: ['test/'], lancer: { 'test/': 'node {fichiers}' } },
      100,
    );
    expect(rapport?.preuve).toMatchObject({
      outcome: 'fail',
      commands: [
        { exit: null, head: marque, delai_depasse: true },
        { exit: null, head: marque, delai_depasse: true },
      ],
      suites: {
        base: { passed: 0, failed: 1, ids: [fichier] },
        head: { passed: 0, failed: 1, ids: [fichier] },
      },
    });
    expect(git('worktree', 'list', '--porcelain')).toBe(worktrees);
  } finally {
    await rm(depot, { recursive: true, force: true });
  }
});
