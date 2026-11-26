import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runAcceptation } from '../src/cli/commands/acceptation.js';

const fichier = 'test/recette avec espace.test.ts';
const source = 'src/fixture.ts';
const commande = 'node lanceur.cjs ; {fichiers}';
const dossiers: string[] = [];

afterEach(() => {
  for (const dossier of dossiers.splice(0)) rmSync(dossier, { recursive: true, force: true });
});

function git(depot: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    { cwd: depot, encoding: 'utf8' },
  ).trim();
}

function ecrire(depot: string, chemin: string, contenu: string): void {
  const destination = join(depot, chemin);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contenu);
}

function commettre(depot: string, message: string, point?: string): string {
  git(depot, 'add', '-A');
  git(depot, 'commit', '-m', message, ...(point ? ['-m', `Acceptation: ${point}`] : []));
  return git(depot, 'rev-parse', 'HEAD');
}

function initialiser(): { depot: string; base: string } {
  const depot = mkdtempSync(join(tmpdir(), 'aid-preuve-'));
  dossiers.push(depot);
  git(depot, 'init', '--quiet');
  git(depot, 'config', 'user.name', 'Test acceptation');
  git(depot, 'config', 'user.email', 'acceptation@example.com');
  git(depot, 'remote', 'add', 'origin', 'https://example.com/owner-a/depot-a.git');
  ecrire(
    depot,
    'agent.yml',
    `acceptation:
  chemins: [test/, e2e/]
  lancer:
    test/: ${commande}
`,
  );
  ecrire(
    depot,
    'lanceur.cjs',
    `const { execFileSync } = require('node:child_process');
const { existsSync, lstatSync, readFileSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { isAbsolute, relative } = require('node:path');
const [separateur, fichier, ...reste] = process.argv.slice(2);
const chemin = relative(realpathSync(tmpdir()), realpathSync(process.cwd()));
const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
if (separateur !== ';' || !fichier || reste.length || head.trim() !== 'HEAD' ||
    !chemin || chemin.startsWith('..') || isAbsolute(chemin) ||
    !lstatSync('node_modules', { throwIfNoEntry: false })?.isSymbolicLink() ||
    !existsSync('node_modules/temoin.txt')) {
  process.exit(1);
}
const critere = readFileSync(fichier, 'utf8').trim();
process.exit(critere === 'vert' || (critere === 'source' && existsSync('${source}')) ? 0 : 1);
`,
  );
  const base = commettre(depot, 'Base');
  ecrire(depot, 'node_modules/temoin.txt', 'Dépendance disponible\n');
  writeFileSync(join(depot, '.git/info/exclude'), 'node_modules/\n');
  return { depot, base };
}

async function lancer(depot: string, base: string, ...options: string[]) {
  const sortie: string[] = [];
  const erreurs: string[] = [];
  const code = await runAcceptation(['preuve', '--base', base, ...options], {
    cwd: depot,
    out: (ligne: string) => sortie.push(ligne),
    err: (ligne: string) => erreurs.push(ligne),
  });
  return { code, sortie, erreurs };
}

describe('prouverAcceptation (67.4)', () => {
  test('rend les preuves dans l’ordre des points et prend les fichiers du premier commit marqué', async () => {
    const { depot, base } = initialiser();
    const fichierSuivant = 'test/suivant.test.ts';
    ecrire(depot, fichierSuivant, 'source\n');
    const second = commettre(depot, 'Premier commit du point suivant', '67.5');
    ecrire(depot, fichier, 'source\n');
    const premier = commettre(depot, 'Premier commit du point précédent', '67.4');
    ecrire(depot, 'test/ajout.test.ts', 'rouge\n');
    commettre(depot, 'Second commit du même point', '67.4');
    ecrire(depot, source, 'critère satisfait\n');
    const head = commettre(depot, 'Développement');

    const { prouverAcceptation } = await import('../src/acceptation/preuve.js');
    const preuves = await prouverAcceptation({
      depot,
      base,
      chemins: ['test/'],
      lancer: {
        'test/': commande,
      },
    });
    expect(preuves).toMatchObject([
      { base: premier, head, outcome: 'pass', fail_to_pass: [fichier] },
      { base: second, head, outcome: 'pass', fail_to_pass: [fichierSuivant] },
    ]);
  });
});

describe('runAcceptation preuve (67.4)', () => {
  test('code 0 et un seul objet JSON avec une preuve complète pour deux fichiers rouges puis verts', async () => {
    const { depot, base } = initialiser();
    const autre = 'test/autre.test.ts';
    const fichiers = [autre, fichier];
    for (const chemin of fichiers) ecrire(depot, chemin, 'source\n');
    const marque = commettre(depot, 'Acceptation du point', '67.4');
    ecrire(depot, source, 'critère satisfait\n');
    const head = commettre(depot, 'Développement');
    const worktrees = git(depot, 'worktree', 'list', '--porcelain');

    const { code, sortie } = await lancer(depot, base, '--json');

    expect(code).toBe(0);
    const rapport = JSON.parse(sortie.join('\n'));
    expect(Object.keys(rapport)).toEqual(['preuves']);
    const { preuves } = rapport;
    expect(preuves).toMatchObject([
      {
        schema_version: 1,
        repo: 'owner-a/depot-a',
        head,
        base: marque,
        outcome: 'pass',
        not_checked: [],
        suites: {
          base: { passed: 0, failed: 2, ids: expect.arrayContaining(fichiers) },
          head: { passed: 2, failed: 0, ids: expect.arrayContaining(fichiers) },
        },
        pass_to_fail: [],
        fail_to_pass: expect.arrayContaining(fichiers),
      },
    ]);
    const [preuve] = preuves;
    expect(preuve).not.toHaveProperty('relationship');
    expect(preuve.fail_to_pass).toHaveLength(2);
    expect(preuve.suites.base.ids).toHaveLength(2);
    expect(preuve.suites.head.ids).toHaveLength(2);
    const commandes = fichiers.flatMap((chemin) => [
      { argv: ['node', 'lanceur.cjs', ';', chemin], exit: 1, head: marque },
      { argv: ['node', 'lanceur.cjs', ';', chemin], exit: 0, head },
    ]);
    expect(preuve.commands).toHaveLength(commandes.length);
    expect(preuve.commands).toEqual(
      expect.arrayContaining(commandes.map((attendue) => expect.objectContaining(attendue))),
    );
    expect(git(depot, 'worktree', 'list', '--porcelain')).toBe(worktrees);
  });

  test.each([
    { cas: 'déjà vert au commit marqué', avant: 'vert', apres: 'vert', regressions: [] },
    { cas: 'encore rouge à la tête', avant: 'rouge', apres: 'rouge', regressions: [] },
    { cas: 'vert puis rouge', avant: 'vert', apres: 'rouge', regressions: [fichier] },
  ])('code 1 et nettoyage pour un fichier $cas', async ({ avant, apres, regressions }) => {
    const { depot, base } = initialiser();
    ecrire(depot, fichier, avant);
    const marque = commettre(depot, 'Acceptation du point', '67.4');
    ecrire(depot, fichier, apres);
    ecrire(depot, source, 'Développement\n');
    const head = commettre(depot, 'Développement');
    const worktrees = git(depot, 'worktree', 'list', '--porcelain');

    const { code, sortie } = await lancer(depot, base, '--json');

    expect(code).toBe(1);
    expect(JSON.parse(sortie.join('\n')).preuves).toMatchObject([
      {
        outcome: 'fail',
        pass_to_fail: regressions,
        commands: expect.arrayContaining([
          expect.objectContaining({ head: marque, exit: avant === 'vert' ? 0 : 1 }),
          expect.objectContaining({ head, exit: apres === 'vert' ? 0 : 1 }),
        ]),
      },
    ]);
    expect(git(depot, 'worktree', 'list', '--porcelain')).toBe(worktrees);
  });

  test.each([
    { cas: 'seul', avecEchec: false, resultat: 'cannot_evaluate' },
    { cas: 'avec un fichier encore rouge', avecEchec: true, resultat: 'fail' },
  ])(
    'code 1 et not_checked pour un fichier sans commande ($cas)',
    async ({ avecEchec, resultat }) => {
      const { depot, base } = initialiser();
      const sansCommande = 'e2e/sans-commande.spec.ts';
      ecrire(depot, sansCommande, 'source\n');
      if (avecEchec) ecrire(depot, fichier, 'rouge\n');
      commettre(depot, 'Acceptation du point', '67.4');
      ecrire(depot, source, 'Développement\n');
      commettre(depot, 'Développement');

      const { code, sortie } = await lancer(depot, base, '--json');

      expect(code).toBe(1);
      const { preuves } = JSON.parse(sortie.join('\n'));
      expect(preuves).toMatchObject([{ outcome: resultat }]);
      expect(preuves[0].not_checked).toHaveLength(1);
      expect(JSON.stringify(preuves[0].not_checked)).toContain(sansCommande);
      expect(preuves[0].commands).toHaveLength(avecEchec ? 2 : 0);
    },
  );

  test('sans --json, une seule ligne nomme le point, son résultat et le fichier en faute', async () => {
    const { depot, base } = initialiser();
    ecrire(depot, fichier, 'vert\n');
    commettre(depot, 'Acceptation du point', '67.4');

    const { code, sortie, erreurs } = await lancer(depot, base);

    expect(code).toBe(1);
    const lignes = [...sortie, ...erreurs];
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toContain('67.4');
    expect(lignes[0]).toMatch(/fail|échec|échou|en faute/i);
    expect(lignes[0]).toContain(fichier);
  });

  test('code 2 sans remote origin', async () => {
    const { depot, base } = initialiser();
    git(depot, 'remote', 'remove', 'origin');
    ecrire(depot, fichier, 'source\n');
    commettre(depot, 'Acceptation du point', '67.4');

    expect((await lancer(depot, base, '--json')).code).toBe(2);
  });

  test('code 0 et liste vide sans point couvert', async () => {
    const { depot, base } = initialiser();
    ecrire(depot, source, 'Développement\n');
    commettre(depot, 'Développement');

    const { code, sortie } = await lancer(depot, base, '--json');

    expect(code).toBe(0);
    expect(JSON.parse(sortie.join('\n'))).toEqual({ preuves: [] });
  });
});
