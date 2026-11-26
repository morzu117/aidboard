import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { produirePreuves } from '../src/acceptation/preuve.js';
import { runAcceptation } from '../src/cli/commands/acceptation.js';

test.each([
  { cas: 'les deux lancements dépassent le délai', codePresent: false, signal: false },
  { cas: 'la base dépasse le délai et la tête passe', codePresent: true, signal: false },
  { cas: 'la base s’arrête par signal et la tête passe', codePresent: true, signal: true },
])('$cas', async ({ codePresent, signal }) => {
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
    await writeFile(
      join(depot, 'agent.yml'),
      'acceptation:\n  lancer:\n    test/: node {fichiers}\n',
    );
    git('add', 'agent.yml');
    git('commit', '-m', 'Base');
    const base = git('rev-parse', 'HEAD');
    const fichier = 'test/recette.cjs';
    await mkdir(join(depot, 'test'));
    const interruption = signal
      ? "process.kill(process.pid, 'SIGTERM');"
      : 'setInterval(() => {}, 1000);';
    await writeFile(
      join(depot, fichier),
      `if (!require('node:fs').existsSync('code.cjs')) ${interruption}\n`,
    );
    git('add', fichier);
    git('commit', '-m', 'Test', '-m', 'Acceptation: 67.4');
    const marque = git('rev-parse', 'HEAD');
    if (codePresent) {
      await writeFile(join(depot, 'code.cjs'), 'module.exports = true;\n');
      git('add', 'code.cjs');
      git('commit', '-m', 'Code');
    }
    const head = git('rev-parse', 'HEAD');
    const worktrees = git('worktree', 'list', '--porcelain');

    const [rapport] = await produirePreuves(
      { depot, base, chemins: ['test/'], lancer: { 'test/': 'node {fichiers}' } },
      500,
    );
    expect(rapport?.fautes).toEqual([]);
    expect(rapport?.preuve).toMatchObject({
      outcome: 'cannot_evaluate',
      not_checked: [fichier],
      fail_to_pass: [],
      pass_to_fail: [],
      commands: [
        { exit: null, head: marque, ...(signal ? {} : { delai_depasse: true }) },
        codePresent ? { exit: 0, head } : { exit: null, head, delai_depasse: true },
      ],
      suites: {
        base: { passed: 0, failed: 1, ids: [fichier] },
        head: { passed: codePresent ? 1 : 0, failed: codePresent ? 0 : 1, ids: [fichier] },
      },
    });
    if (signal) {
      const sortie: string[] = [];
      const code = await runAcceptation(['preuve', '--base', base], {
        cwd: depot,
        out: (ligne) => sortie.push(ligne),
      });
      expect(code).toBe(1);
      expect(sortie).toEqual([`Point 67.4 — non évaluable — ${fichier}`]);
    }
    expect(git('worktree', 'list', '--porcelain')).toBe(worktrees);
  } finally {
    await rm(depot, { recursive: true, force: true });
  }
});
