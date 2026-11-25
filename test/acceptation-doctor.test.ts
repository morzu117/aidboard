import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runDoctor, type Probes } from '../src/cli/commands/doctor.js';
import { resolvePaths } from '../src/daemon/paths.js';

const sondesSaines: Probes = {
  nodeVersion: 'v22.23.3',
  platform: 'darwin',
  procVersion: null,
  has: () => true,
  version: async () => 'git version 2.54.0',
  loadPty: async () => null,
  loadSqlite: async () => null,
  homeMode: () => 0o40700,
  port: async () => ({ port: 4870, state: 'libre' }),
  artefactsPort: async () => ({ port: 4880, state: 'libre' }),
  claudeHooks: () => true,
  memoryHealth: async () => null,
  mcpRegistration: () => false,
  structural: async () => null,
  install: () => ({ mode: 'repo', version: null }),
  mesh: async () => null,
  swairm: async () => null,
  modeHost: async () => null,
};

const phase = 'phases: [plan, acceptation, dev, review, triage, retro]\n';
const chemins = 'acceptation:\n  chemins: [test/]\n';
const commande = '    test/: npx vitest run {fichiers}\n';
const avecCommande = chemins + '  lancer:\n' + commande;

async function diagnostiquer(manifeste: string) {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-acceptation-doctor-'));
  const courant = process.cwd();
  const aidHome = join(dossier, '.aid');
  const lignes: string[] = [];
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: dossier });
    writeFileSync(join(dossier, 'agent.yml'), 'project:\n  name: exemple\n' + manifeste);
    process.chdir(dossier);
    vi.stubEnv('AID_HOME', aidHome);
    const code = await runDoctor(resolvePaths(aidHome), sondesSaines, (ligne) =>
      lignes.push(ligne),
    );
    const avertissements = lignes
      .join('\n')
      .split(/\n(?=\s*[✓⚠✗])/)
      .filter((diagnostic) => diagnostic.trimStart().startsWith('⚠'));
    return { code, avertissements };
  } finally {
    vi.unstubAllEnvs();
    process.chdir(courant);
    rmSync(dossier, { recursive: true, force: true });
  }
}

test.each([
  ['absent', chemins],
  ['vide', chemins + '  lancer: {}\n'],
])(
  '67.6 : la phase avec acceptation.lancer %s produit un avertissement et sort à 0',
  async (_, acceptation) => {
    const { code, avertissements } = await diagnostiquer(phase + acceptation);

    expect(code).toBe(0);
    expect(avertissements).toContainEqual(expect.stringContaining('acceptation.lancer'));
  },
);

test.each([
  ['phase déclarée et commande configurée', phase + avecCommande],
  ['phase absente et bloc acceptation absent', ''],
  ['phase absente et bloc acceptation sans commande', chemins],
])('67.6 : aucun avertissement acceptation.lancer avec %s', async (_, manifeste) => {
  const { code, avertissements } = await diagnostiquer(manifeste);

  expect(code).toBe(0);
  expect(avertissements).not.toContainEqual(expect.stringContaining('acceptation.lancer'));
});

test('67.6 : un chemin déclaré sans commande est nommé dans un avertissement et doctor sort à 0', async () => {
  const { code, avertissements } = await diagnostiquer(
    phase + 'acceptation:\n  chemins: [test/, recette/]\n  lancer:\n' + commande,
  );

  expect(code).toBe(0);
  expect(avertissements).toContainEqual(expect.stringContaining('recette/'));
});
