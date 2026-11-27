import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { comparerEmpreintes, empreinteEnvironnement } from '../../src/daemon/boucle/controles.js';
import { makeOriginAndClone, sh } from '../helpers/git.js';

let racine: string;
let home: string;
let worktree: string;
let principal: string;

beforeEach(() => {
  racine = realpathSync(mkdtempSync(join(tmpdir(), 'aid-relecture3-memoire-')));
  home = join(racine, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(home, 'aid'));
  principal = makeOriginAndClone(racine, { name: 'depot-fictif' }).clone;
  worktree = join(racine, 'sujet-fictif');
  sh(principal, 'worktree', 'add', '-qb', 'feat/s', worktree, 'main');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(racine, { recursive: true, force: true });
});

test('un worktree lié surveille ses deux mémoires Claude et ignore celles des autres projets', async () => {
  const fichiers = [principal, worktree, join(racine, 'autre-projet-fictif')].map((chemin) => {
    const code = chemin.replace(/[^a-zA-Z0-9]/g, '-');
    const dossier = join(home, '.claude', 'projects', code, 'memory');
    mkdirSync(dossier, { recursive: true });
    const fichier = join(dossier, 'MEMORY.md');
    writeFileSync(fichier, 'Avant.');
    return fichier;
  });
  const relever = () => empreinteEnvironnement(home, undefined, { worktree });
  const avant = await relever();
  for (const fichier of fichiers) writeFileSync(fichier, 'Après.');
  expect(comparerEmpreintes(avant, await relever())).toEqual(
    fichiers
      .slice(0, 2)
      .sort()
      .map((fichier) => expect.stringContaining(fichier)),
  );
});
