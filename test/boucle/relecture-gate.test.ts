import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { lancerGate } from '../../src/daemon/boucle/gate.js';
import { commitFile, makeOriginAndClone, sh } from '../helpers/git.js';

let dossier: string;
let depot: string;
let base: string;
const variable = ['AID', 'SECRET', 'FICTIF'].join('_');
const fichier = 'test/recette.cjs';

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), 'aid-relecture-gate-'));
  const home = join(dossier, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(dossier, 'aid-home'));
  ({ clone: depot } = makeOriginAndClone(dossier));
  base = sh(depot, 'rev-parse', 'HEAD');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dossier, { recursive: true, force: true });
});

function preparerPreuve(instructionsAvant = 'process.exit(1);', instructions = '') {
  mkdirSync(join(depot, 'test'));
  writeFileSync(
    join(depot, fichier),
    `
    const fs = require('node:fs');
    ${instructions}
    if (!fs.existsSync('note.md')) { ${instructionsAvant} }
  `,
  );
  sh(depot, 'add', fichier);
  sh(depot, 'commit', '-qm', 'Recette fictive', '-m', 'Acceptation: 69.8');
  commitFile(depot, 'note.md', 'Note fictive.');
}

function avecPreuve(delaiMs = 2_000) {
  return lancerGate({
    depot,
    tete: sh(depot, 'rev-parse', 'HEAD'),
    commande: 'exit 0',
    delaiMs,
    acceptation: { base, chemins: ['test/'], lancer: { 'test/': 'node {fichiers}' } },
  });
}

test('une commande de preuve du gate ne reçoit pas une variable sensible héritée', async () => {
  vi.stubEnv(variable, ['valeur', 'fictive', 'de', 'test'].join('-'));
  preparerPreuve(
    'process.exit(1);',
    `
    if (Object.hasOwn(process.env, ${JSON.stringify(variable)})) process.exit(2);
  `,
  );

  expect(await avecPreuve()).toMatchObject({ issue: 'pass', fichiersAcceptation: [fichier] });
});

test.each(['.git/hooks', 'hooks-locaux'])(
  'le git du gate et des preuves neutralise les réglages exécutables avec %s',
  async (repertoire) => {
    preparerPreuve();
    const hooks = join(depot, repertoire);
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'post-checkout'), '# fixture inerte\n');
    if (repertoire !== '.git/hooks') sh(depot, 'config', '--local', 'core.hooksPath', hooks);
    const vraiGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(dossier, 'bin');
    const journal = join(dossier, 'appels-git.jsonl');
    mkdirSync(bin);
    vi.stubEnv(variable, ['exemple', 'non', 'sensible'].join('-'));
    writeFileSync(
      join(bin, 'git'),
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(journal)}, JSON.stringify({
  args, variablePresente: Object.hasOwn(process.env, ${JSON.stringify(variable)})
}) + '\\n');
const resultat = spawnSync(${JSON.stringify(vraiGit)}, args, { stdio: 'inherit' });
process.exit(resultat.status ?? 1);
`,
      { mode: 0o755 },
    );

    // Le témoin relève les arguments et la présence d’une variable fictive, sans exécuter de hook.
    vi.stubEnv('PATH', [bin, process.env.PATH].join(delimiter));
    expect(await avecPreuve()).toMatchObject({ issue: 'pass', fichiersAcceptation: [fichier] });

    const appels = readFileSync(journal, 'utf8')
      .trim()
      .split('\n')
      .map((ligne) => JSON.parse(ligne) as { args: string[]; variablePresente: boolean });
    const ajouts = appels.filter(({ args }) => args.includes('worktree') && args.includes('add'));
    expect(ajouts).toHaveLength(2);
    for (const { args, variablePresente } of [...ajouts, ...appels]) {
      const commande = args.join(' ');
      expect(commande).toContain('-c core.hooksPath=/dev/null');
      expect(commande).toContain('-c core.fsmonitor=false');
      expect(commande).toContain('-c credential.helper=');
      expect(commande).toMatch(/-c core\.sshCommand=\S/);
      expect(variablePresente).toBe(false);
    }
  },
);

function processusVivant(pid: number): boolean {
  const tableau = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' });
  return tableau.split('\n').some((ligne) => {
    const [identifiant, statut] = ligne.trim().split(/\s+/);
    return Number(identifiant) === pid && !statut?.startsWith('Z');
  });
}

function nettoyerProcessus(pid: number) {
  if (!processusVivant(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (erreur) {
    if ((erreur as NodeJS.ErrnoException).code !== 'ESRCH') throw erreur;
  }
}

async function verifierMort(temoin: string) {
  expect(existsSync(temoin)).toBe(true);
  const pid = Number(readFileSync(temoin, 'utf8').trim());
  expect(pid).toBeGreaterThan(1);
  try {
    await expect.poll(() => processusVivant(pid), { timeout: 1_000 }).toBe(false);
  } finally {
    nettoyerProcessus(pid);
  }
}

test('le gate réussi tue aussi le sleep laissé en arrière-plan', async () => {
  const resultat = await lancerGate({
    depot,
    tete: sh(depot, 'rev-parse', 'HEAD'),
    commande: 'sleep 30 </dev/null >/dev/null 2>&1 & echo "$!" > pid-fictif; exit 0',
    delaiMs: 2_000,
  });
  try {
    expect(resultat).toMatchObject({ issue: 'pass', codeSortie: 0 });
  } finally {
    await verifierMort(join(depot, 'pid-fictif'));
  }
});

test('le délai d’une commande de preuve tue également son enfant', async () => {
  const temoin = join(dossier, 'pid-preuve');
  preparerPreuve(`
    const { spawn } = require('node:child_process');
    const enfant = spawn('sleep', ['30'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(temoin)}, String(enfant.pid));
    setInterval(() => {}, 1000);
  `);
  const resultat = await avecPreuve(800);
  try {
    expect(resultat).toMatchObject({ issue: 'cannot_evaluate', fichiersAcceptation: [fichier] });
  } finally {
    await verifierMort(temoin);
  }
});
