import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, vi } from 'vitest';
import { git } from '../src/daemon/git/exec.js';
import { gitFileStatuses } from '../src/daemon/git/inspect.js';
import { makeOriginAndClone, sh } from './helpers/git.js';

const executer = promisify(execFile);

test('une lecture du daemon ne verrouille pas un index à rafraîchir et laisse commiter', async () => {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-verrou-'));
  try {
    const { clone } = makeOriginAndClone(dossier);
    const sujet = join(dossier, 'sujet');
    sh(clone, 'worktree', 'add', '-qb', 'sujet', sujet);
    const index = join(sh(sujet, 'rev-parse', '--absolute-git-dir'), 'index');
    const fichier = join(sujet, 'README.md');
    const salir = () => utimesSync(fichier, new Date(0), new Date(0));
    const evenements: string[] = [];
    const observateur = watch(join(index, '..'), (_, nom) => {
      if (nom) evenements.push(nom.toString());
    });
    try {
      // Témoin : le status ordinaire rafraîchit bien cet index et crée le verrou.
      salir();
      await executer('git', ['status', '--porcelain'], {
        cwd: sujet,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '1' },
      });
      expect(evenements).toContain('index.lock');
      evenements.length = 0;
      salir();
      const avant = readFileSync(index);
      expect(await gitFileStatuses(sujet)).toEqual(new Map());
      expect((await git(sujet, ['-c', 'color.ui=false', 'status', '--porcelain'])).ok).toBe(true);
      expect(evenements).not.toContain('index.lock');
      expect(readFileSync(index)).toEqual(avant);
    } finally {
      observateur.close();
    }

    // Lectures réellement lancées pendant le commit, sans sérialiser par une aide d’action.
    writeFileSync(fichier, '# dépôt modifié\n');
    const lectures = Array.from({ length: 20 }, () => gitFileStatuses(sujet));
    const commit = executer('git', ['commit', '-am', 'Pendant les lectures'], { cwd: sujet });
    await Promise.all([...lectures, commit]);
    expect(sh(sujet, 'log', '-1', '--format=%s')).toBe('Pendant les lectures');
    // Les écritures passant par l’aide commune restent possibles.
    expect((await git(sujet, ['commit', '--allow-empty', '-qm', 'Écriture du daemon'])).ok).toBe(
      true,
    );
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('les écritures git conservent leur environnement de verrous', async () => {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-env-git-'));
  try {
    writeFileSync(join(dossier, 'git'), '#!/bin/sh\nprintf "%s" "$GIT_OPTIONAL_LOCKS"\n', {
      mode: 0o700,
    });
    vi.stubEnv('PATH', dossier);
    vi.stubEnv('GIT_OPTIONAL_LOCKS', '1');
    for (const args of [
      ['commit', '--allow-empty'],
      ['merge', 'sujet'],
      ['push'],
      ['fetch'],
      ['worktree', 'add', 'sujet'],
      ['worktree', 'remove', 'sujet'],
      ['stash', 'drop', 'stash@{0}'],
      ['config', 'user.name', 'test'],
      ['symbolic-ref', 'HEAD', 'refs/heads/sujet'],
    ]) {
      expect((await git(dossier, args)).stdout, args.join(' ')).toBe('1');
    }
    expect((await git(dossier, ['status', '--porcelain'])).stdout).toBe('0');
    expect((await git(dossier, ['-c', 'color.ui=false', 'diff'])).stdout).toBe('0');
  } finally {
    vi.unstubAllEnvs();
    rmSync(dossier, { recursive: true, force: true });
  }
});
