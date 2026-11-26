import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { argumentsAvis } from '../src/daemon/avis/fournisseurs.js';

// Les noms mentionnés dans la description d'une option ne sont pas des déclarations.
function lireOptions(aide: string): Map<string, boolean> {
  const options = new Map<string, boolean>();
  for (const ligne of aide.split('\n')) {
    const declaration = ligne
      .trimStart()
      .replace(/^│\s*/u, '')
      .split(/\s{2,}|│/u, 1)[0]!;
    const entete = declaration.match(
      /^(-[\w-]+(?:,?\s+-[\w-]+)*)(?:[ =](<[^>]+>|\[[^\]]+\]|\{[^}]+\}|[A-Z][A-Z_0-9-]*))?/,
    );
    if (!entete) continue;
    const [, noms, valeur] = entete;
    for (const nom of noms!.split(/[,\s]+/)) {
      options.set(nom, valeur !== undefined && !valeur.startsWith('['));
    }
  }
  return options;
}

function verifierOptions(argv: string[], aide: string): void {
  const options = lireOptions(aide);
  for (const [index, argument] of argv.entries()) {
    const [nom, valeur] = argument.split('=', 2) as [string, string?];
    if (nom.startsWith('--') && !options.has(nom)) throw new Error(`Option absente : ${nom}`);
    if (options.get(nom) && valeur === undefined) {
      const suivante = argv[index + 1];
      if (suivante === undefined || suivante.startsWith('-'))
        throw new Error(`Valeur requise : ${nom}`);
    }
  }
}

test('lit les déclarations Clap et Vibe, ignore les mentions dans le texte', () => {
  const aide = `
  -c, --config <KEY=VALUE>  Configuration, voir --ailleurs
      --disable <FEATURE>  Désactive une fonctionnalité
  │ --output {text,json}     Format │
      --enabled-tools TOOL [TOOL ...]   Outils autorisés
      --ignore-user-config
      --facultatif [VALUE]
      Une description mentionne --ailleurs.
  `;
  expect([...lireOptions(aide)]).toEqual([
    ['-c', true],
    ['--config', true],
    ['--disable', true],
    ['--output', true],
    ['--enabled-tools', true],
    ['--ignore-user-config', false],
    ['--facultatif', false],
  ]);
  expect(() => verifierOptions(['--enabled-tools', '', '--output=json'], aide)).not.toThrow();
  expect(() => verifierOptions(['--output', '--ignore-user-config'], aide)).toThrow('--output');
  expect(() => verifierOptions(['--ailleurs'], aide)).toThrow('--ailleurs');
});

const lireCli = (binaire: string, argv: string[]) =>
  execFileSync(binaire, argv, {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', COLUMNS: '120', TERM: 'dumb' },
    timeout: 15_000,
  });

test.skipIf(process.env.AID_CONTRAT_CLI !== '1').each(['codex', 'vibe'] as const)(
  '%s reconnaît les options de l’adaptateur',
  (fournisseur) => {
    const argv = argumentsAvis(
      fournisseur,
      { prompt: 'Question de contrat', modele: 'modele-test', budgetUsd: 0.5, delaiMs: 1000 },
      'avis.txt',
    );
    const commande = fournisseur === 'codex' ? [argv[0]!] : [];
    verifierOptions(argv, lireCli(fournisseur, [...commande, '--help']));
    if (fournisseur === 'codex') {
      const fonctionnalites = new Set(
        lireCli('codex', ['features', 'list'])
          .split('\n')
          .map((ligne) => ligne.trim().split(/\s+/)[0]),
      );
      for (const [index, argument] of argv.entries()) {
        if (argument === '--disable') {
          const nom = argv[index + 1];
          expect(fonctionnalites.has(nom), `Fonctionnalité absente : ${nom}`).toBe(true);
        }
      }
    }
  },
  35_000,
);
