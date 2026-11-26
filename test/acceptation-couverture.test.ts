import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runAcceptation } from '../src/cli/commands/acceptation.js';

const fichierPlan = 'plan.md';
const raison = 'Le rendu doit être jugé à l’œil.';
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

function initialiser(points: string[], trailer?: string): { depot: string; base: string } {
  const depot = mkdtempSync(join(tmpdir(), 'aid-couverture-'));
  dossiers.push(depot);
  git(depot, 'init', '--quiet');
  git(depot, 'config', 'user.name', 'Test acceptation');
  git(depot, 'config', 'user.email', 'acceptation@example.com');
  writeFileSync(join(depot, fichierPlan), ['# Plan exemple', '', ...points, ''].join('\n'));
  git(depot, 'add', fichierPlan);
  git(depot, 'commit', '-m', 'Plan initial');
  const base = git(depot, 'rev-parse', 'HEAD');

  if (trailer !== undefined) {
    mkdirSync(join(depot, 'test'));
    writeFileSync(join(depot, 'test', 'recette.test.ts'), '// Critère du point\n');
    git(depot, 'add', 'test');
    git(depot, 'commit', '-m', 'Ajout du critère', '-m', `Acceptation: ${trailer}`);
  }

  return { depot, base };
}

async function lancer(depot: string, ...args: string[]) {
  const sortie: string[] = [];
  const erreurs: string[] = [];
  const code = await runAcceptation(['couverture', ...args], {
    cwd: depot,
    out: (ligne) => sortie.push(ligne),
    err: (ligne) => erreurs.push(ligne),
  });
  return { code, sortie, erreurs };
}

describe('mesurerCouverture (67.5)', () => {
  test('classe les points et calcule la part parmi les seuls points testables', async () => {
    const { depot, base } = initialiser(
      [
        '### 67.1 Le plan',
        '',
        '### 67.2',
        '',
        '### 67.3 Recette visuelle',
        '',
        `- _Acceptation._ Non testable à l'avance : ${raison}`,
        '',
        '### 67.4 Contrôle à automatiser',
        '',
        '### 67.5 Justification vide',
        '',
        "- _Acceptation._ Non testable à l'avance : .",
      ],
      '67.2',
    );
    const { mesurerCouverture } = await import('../src/acceptation/couverture.js');
    const rapport = await mesurerCouverture({ depot, base, plan: join(depot, fichierPlan) });

    expect(rapport).toEqual({
      points: expect.arrayContaining([
        { point: '67.2', etat: 'couvert' },
        { point: '67.3', etat: 'non_testable', raison },
        { point: '67.4', etat: 'manquant' },
        { point: '67.5', etat: 'manquant' },
      ]),
      total: 4,
      couverts: 1,
      nonTestables: 1,
      manquants: 2,
      part: 1 / 3,
    });
    expect(rapport.points).toHaveLength(4);
  });

  test('rend une part finie entre 0 et 1 sans point testable', async () => {
    const { depot, base } = initialiser([
      '### 67.1',
      '',
      '### 67.2 Recette visuelle',
      '',
      `- _Acceptation._ Non testable à l'avance : ${raison}`,
    ]);
    const { mesurerCouverture } = await import('../src/acceptation/couverture.js');
    const rapport = await mesurerCouverture({ depot, base, plan: join(depot, fichierPlan) });

    expect(rapport).toMatchObject({ total: 1, couverts: 0, nonTestables: 1, manquants: 0 });
    expect(rapport.part).toBeGreaterThanOrEqual(0);
    expect(rapport.part).toBeLessThanOrEqual(1);
  });
});

describe('runAcceptation couverture (67.5)', () => {
  test('rend 2 sans --plan', async () => {
    const { depot, base } = initialiser(['### 67.2']);
    const { code } = await lancer(depot, '--base', base);

    expect(code).toBe(2);
  });

  test('rend 1 avec une ligne de texte par point et la raison du point justifié', async () => {
    const { depot, base } = initialiser(
      [
        '### 67.2',
        '',
        '### 67.3 Recette visuelle',
        '',
        `- _Acceptation._ Non testable à l'avance : ${raison}`,
        '',
        '### 67.4 Contrôle à automatiser',
      ],
      '67.2',
    );
    const { code, sortie, erreurs } = await lancer(depot, '--base', base, '--plan', fichierPlan);

    expect(code).toBe(1);
    const lignes = [...sortie, ...erreurs].join('\n').trim().split(/\r?\n/);
    expect(lignes).toHaveLength(3);
    expect(lignes.find((ligne) => ligne.includes('67.2'))).toMatch(/couvert/i);
    expect(lignes.find((ligne) => ligne.includes('67.3'))).toContain(raison);
    expect(lignes.find((ligne) => ligne.includes('67.4'))).toMatch(/manquant/i);
  });

  test('rend 0 et écrit uniquement le rapport JSON si aucun point ne manque', async () => {
    const { depot, base } = initialiser(['### 67.2 Critère couvert'], '67.2');
    const { code, sortie, erreurs } = await lancer(
      depot,
      '--base',
      base,
      '--plan',
      fichierPlan,
      '--json',
    );

    expect(code).toBe(0);
    expect(erreurs).toEqual([]);
    expect(JSON.parse(sortie.join('\n'))).toEqual({
      points: [{ point: '67.2', etat: 'couvert' }],
      total: 1,
      couverts: 1,
      nonTestables: 0,
      manquants: 0,
      part: 1,
    });
  });
});
