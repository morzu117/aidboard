import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { produirePreuves } from '../../src/acceptation/preuve.js';
import { git } from '../../src/acceptation/verifier.js';
import { commitFile, makeOriginAndClone, sh } from '../helpers/git.js';

let racine: string;
let depot: string;
let base: string;

beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), 'aid-relecture-preuves-'));
  const home = join(racine, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(home, 'aid'));
  ({ clone: depot } = makeOriginAndClone(racine));
  base = sh(depot, 'rev-parse', 'HEAD');
  mkdirSync(join(depot, 'test'));
  const recette = `
    try {
      process.kill(-process.pid, 0);
      process.exit(0);
    } catch (erreur) {
      if (erreur.code !== 'ESRCH') throw erreur;
      process.exit(1);
    }
  `;
  commitFile(depot, 'test/groupe.cjs', recette, 'Recette fictive\n\nAcceptation: 69.9');
  commitFile(depot, 'note.md', 'Note fictive.');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(racine, { recursive: true, force: true });
});

test.each([
  { enGroupe: true, lireGit: git, code: 0, cas: 'git par défaut' },
  {
    enGroupe: false,
    lireGit: (depot: string, args: string[]) => git(depot, args),
    code: 1,
    cas: 'git injecté',
  },
])('les preuves appliquent enGroupe=$enGroupe avec $cas', async ({ enGroupe, lireGit, code }) => {
  const rapports = await produirePreuves(
    { depot, base, chemins: ['test/'], lancer: { 'test/': 'node {fichiers}' } },
    2_000,
    undefined,
    undefined,
    lireGit,
    { enGroupe },
  );
  expect(rapports).toHaveLength(1);
  expect(rapports[0]?.preuve.commands.map((commande) => commande.exit)).toEqual([code, code]);
});
