import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { verifierAcceptation } from '../src/acceptation/verifier.js';
import { runAcceptation } from '../src/cli/commands/acceptation.js';

const fichier = 'test/recette.test.ts';
const chemins = ['test/', 'e2e/'];
const dossiers: string[] = [];

function dossierTemporaire(): string {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-acc-'));
  dossiers.push(dossier);
  return dossier;
}

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

function ecrire(depot: string, fichier: string, contenu = 'critère initial\n'): void {
  const destination = join(depot, fichier);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contenu);
}

function commettre(depot: string, message: string, marque = false): string {
  git(depot, 'add', '-A');
  git(
    depot,
    'commit',
    '--allow-empty',
    '-m',
    message,
    ...(marque ? ['-m', 'Acceptation: 67.3'] : []),
  );
  return git(depot, 'rev-parse', 'HEAD');
}

function initialiser(manifeste?: string): { depot: string; base: string } {
  const depot = dossierTemporaire();
  git(depot, 'init', '--quiet');
  git(depot, 'config', 'user.name', 'Test acceptation');
  git(depot, 'config', 'user.email', 'acceptation@example.com');
  if (manifeste !== undefined) ecrire(depot, 'agent.yml', manifeste);
  return { depot, base: commettre(depot, 'Base') };
}

async function lancer(depot: string, ...args: string[]) {
  const sortie: string[] = [];
  const erreurs: string[] = [];
  const code = await runAcceptation(args, {
    cwd: depot,
    out: (ligne: string) => sortie.push(ligne),
    err: (ligne: string) => erreurs.push(ligne),
  });
  return { code, sortie, erreurs };
}

describe('verifierAcceptation (67.3)', () => {
  test('un test existant modifié par un commit marqué devient un fichier d’acceptation', async () => {
    const { depot } = initialiser();
    ecrire(depot, fichier);
    const base = commettre(depot, 'Test existant');
    ecrire(depot, fichier, 'critère du point\n');
    const commit = commettre(depot, 'Acceptation du point', true);

    expect(await verifierAcceptation({ depot, base, chemins })).toEqual({
      ok: true,
      points: { '67.3': { commits: [commit], fichiers: [fichier] } },
      fautes: [],
    });
  });

  test('un commit marqué qui touche src/ signale hors_chemins', async () => {
    const { depot, base } = initialiser();
    const source = 'src/fixture.ts';
    ecrire(depot, fichier);
    ecrire(depot, source);
    const commit = commettre(depot, 'Acceptation avec source', true);

    const rapport = await verifierAcceptation({ depot, base, chemins });
    expect(rapport.ok).toBe(false);
    expect(rapport.fautes).toEqual([{ commit, fichier: source, raison: 'hors_chemins' }]);
  });

  test.each([
    {
      action: 'modifie',
      raison: 'modifie_par_dev',
      changer: (depot: string) => ecrire(depot, fichier, 'modification du dev\n'),
    },
    {
      action: 'renomme',
      raison: 'renomme_par_dev',
      changer: (depot: string) => git(depot, 'mv', fichier, 'test/recette-renommee.test.ts'),
    },
    {
      action: 'supprime',
      raison: 'supprime_par_dev',
      changer: (depot: string) => git(depot, 'rm', fichier),
    },
  ])(
    'un commit de dev qui $action un fichier d’acceptation produit une faute',
    async ({ raison, changer }) => {
      const { depot, base } = initialiser();
      ecrire(depot, fichier);
      commettre(depot, 'Ajout du critère', true);
      changer(depot);
      const commit = commettre(depot, 'Changement du dev');

      const rapport = await verifierAcceptation({ depot, base, chemins });
      expect(rapport.ok).toBe(false);
      expect(rapport.fautes).toEqual([{ commit, fichier, raison }]);
    },
  );

  test('un re-dev marqué du même point modifie le fichier sans faute', async () => {
    const { depot, base } = initialiser();
    ecrire(depot, fichier);
    const premier = commettre(depot, 'Ajout du critère', true);
    ecrire(depot, fichier, 'critère corrigé\n');
    const second = commettre(depot, 'Correction du testeur', true);

    const rapport = await verifierAcceptation({ depot, base, chemins });
    expect(rapport.ok).toBe(true);
    expect(rapport.fautes).toEqual([]);
    expect(Object.keys(rapport.points)).toEqual(['67.3']);
    expect(rapport.points['67.3']?.fichiers).toEqual([fichier]);
    expect(rapport.points['67.3']?.commits).toHaveLength(2);
    expect(rapport.points['67.3']?.commits).toEqual(expect.arrayContaining([premier, second]));
  });

  test('sans commit marqué dans la plage, le rapport est vide', async () => {
    const { depot } = initialiser();
    ecrire(depot, fichier);
    const base = commettre(depot, 'Acceptation hors de la plage', true);
    ecrire(depot, fichier, 'changement après la base\n');
    commettre(depot, 'Acceptation: 67.3\nCette mention fait partie du message.');

    expect(await verifierAcceptation({ depot, base, chemins })).toEqual({
      ok: true,
      points: {},
      fautes: [],
    });
  });
});

describe('runAcceptation (67.3)', () => {
  test.each([
    { cas: 'sans agent.yml', manifeste: undefined },
    { cas: 'sans acceptation.chemins', manifeste: 'acceptation: {}\n' },
  ])(
    'code 0 et une ligne pour le point avec les chemins par défaut ($cas)',
    async ({ manifeste }) => {
      const { depot, base } = initialiser(manifeste);
      ecrire(depot, fichier);
      ecrire(depot, 'e2e/recette.spec.ts');
      commettre(depot, 'Acceptation dans les deux chemins par défaut', true);

      const { code, sortie } = await lancer(depot, 'verifier', '--base', base);
      expect(code).toBe(0);
      expect(sortie).toHaveLength(1);
      expect(sortie[0]).toContain('67.3');
    },
  );

  test('lit acceptation.chemins dans agent.yml à la racine du dépôt', async () => {
    const { depot, base } = initialiser('acceptation:\n  chemins:\n    - recette/\n');
    ecrire(depot, 'recette/critere.test.ts');
    commettre(depot, 'Acceptation dans le chemin configuré', true);
    expect((await lancer(depot, 'verifier', '--base', base)).code).toBe(0);

    ecrire(depot, fichier);
    commettre(depot, 'Acceptation dans un chemin remplacé', true);
    expect((await lancer(depot, 'verifier', '--base', base)).code).toBe(1);
  });

  test('code 1 et une ligne nommant le fichier et le commit en faute', async () => {
    const { depot, base } = initialiser();
    const source = 'src/fixture.ts';
    ecrire(depot, source);
    const commit = commettre(depot, 'Acceptation hors chemins', true);

    const { code, sortie, erreurs } = await lancer(depot, 'verifier', '--base', base);
    expect(code).toBe(1);
    const lignes = [...sortie, ...erreurs];
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toContain(source);
    expect(lignes[0]).toContain(commit.slice(0, 7));
  });

  test.each([
    { cas: 'une sous-commande inconnue', args: ['inconnue', '--base', 'HEAD'] },
    { cas: 'une option --base absente', args: ['verifier'] },
    { cas: 'une ref introuvable', args: ['verifier', '--base', 'ref-introuvable'] },
  ])('code 2 pour $cas', async ({ args }) => {
    const { depot } = initialiser();
    expect((await lancer(depot, ...args)).code).toBe(2);
  });

  test('code 2 hors d’un dépôt git', async () => {
    expect((await lancer(dossierTemporaire(), 'verifier', '--base', 'HEAD')).code).toBe(2);
  });

  test('--json écrit uniquement le rapport sous forme d’un objet JSON', async () => {
    const { depot, base } = initialiser();
    ecrire(depot, fichier);
    const commit = commettre(depot, 'Ajout du critère', true);

    const { code, sortie } = await lancer(depot, 'verifier', '--base', base, '--json');
    expect(code).toBe(0);
    expect(JSON.parse(sortie.join('\n'))).toEqual({
      ok: true,
      points: { '67.3': { commits: [commit], fichiers: [fichier] } },
      fautes: [],
    });
  });
});
