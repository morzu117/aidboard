import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  comparerEmpreintes,
  constatsEmpreinteHome,
  empreinteEnvironnement,
} from '../../src/daemon/boucle/controles.js';

let racine: string;
let home: string;
let worktree: string;
let autreMemoire: string;
let memoireSujet: string;

beforeEach(() => {
  racine = realpathSync(mkdtempSync(join(tmpdir(), 'aid-relecture-memoire-')));
  home = join(racine, 'home');
  worktree = join(racine, 'sujet-fictif');
  const projets = join(home, '.claude', 'projects');
  autreMemoire = join(projets, '-autre-projet-fictif', 'memory');
  memoireSujet = join(projets, worktree.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  mkdirSync(worktree);
  mkdirSync(autreMemoire, { recursive: true });
  mkdirSync(memoireSujet, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(home, 'aid'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(racine, { recursive: true, force: true });
});

const relever = () => empreinteEnvironnement(home, undefined, { worktree });

test('un changement de mémoire dans un autre projet laisse l’empreinte intacte', async () => {
  const fichier = join(autreMemoire, 'MEMORY.md');
  writeFileSync(fichier, 'Avant.');
  const avant = await relever();
  writeFileSync(fichier, 'Après.');
  expect(await relever()).toEqual(avant);
});

test('plus de 5 000 entrées dans un autre projet ne consomment pas la borne du sujet', async () => {
  const avant = await relever();
  for (let i = 0; i < 5_001; i++) writeFileSync(join(autreMemoire, `note-${i}.md`), '');
  const apres = await relever();
  expect.soft(constatsEmpreinteHome(apres)).toEqual([]);
  expect(apres).toEqual(avant);
});

test('la mémoire du projet du worktree entre dans l’empreinte', async () => {
  const fichier = join(memoireSujet, 'MEMORY.md');
  writeFileSync(fichier, 'Avant.');
  const avant = await relever();
  writeFileSync(fichier, 'Après.');
  expect(comparerEmpreintes(avant, await relever())).toEqual([
    expect.stringContaining('MEMORY.md'),
  ]);
});
