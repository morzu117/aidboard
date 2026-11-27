import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as attendre } from 'node:timers/promises';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { profilPour } from '../src/daemon/isolation/lanceur.js';
import { sonderBwrap } from '../src/daemon/isolation/sonde.js';
import { ensureHome, resolvePaths } from '../src/daemon/paths.js';

export function bwrapDeTest() {
  try {
    return sonderBwrap().bin;
  } catch (cause) {
    if (process.env.AID_BWRAP_REQUIS === '1') {
      throw new Error(`AID_BWRAP_REQUIS=1 : ${(cause as Error).message}`, { cause });
    }
    return undefined;
  }
}

export function utiliserBac() {
  let racine: string;
  let home: string;
  beforeEach(() => {
    const temporaire = fs.realpathSync(tmpdir());
    const masque = join(sep, 'tmp');
    // Le profil recouvre /tmp. Les témoins doivent rester visibles sous le montage racine.
    const parent =
      temporaire === masque || temporaire.startsWith(masque + sep) ? process.cwd() : temporaire;
    racine = fs.realpathSync(fs.mkdtempSync(join(parent, 'aid-isolation-acceptation-')));
    home = join(racine, 'home');
    fs.mkdirSync(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('AID_HOME', join(racine, 'aid'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(racine, { force: true, recursive: true });
  });
  return () => ({ racine, home });
}

export function preparerSujet(racine: string, home: string) {
  const depot = join(racine, 'depot');
  const worktree = join(racine, 'sujet');
  const paths = resolvePaths(join(racine, 'aid'));
  const agentId = 'ag_test';
  ensureHome(paths);
  fs.mkdirSync(join(paths.attachments, agentId), { recursive: true });
  const executer = (bin: string, args: string[]) => execFileSync(bin, args, { encoding: 'utf8' });
  const git = (cwd: string, ...args: string[]) => executer('git', ['-C', cwd, ...args]).trim();
  fs.mkdirSync(depot);
  git(depot, 'init', '-q');
  git(depot, 'config', 'user.name', 'Test');
  git(depot, 'config', 'user.email', 'test@example.com');
  git(depot, 'commit', '-qm', 'Base', '--allow-empty');
  git(depot, 'worktree', 'add', '-qb', 'sujet', worktree);
  const profil = profilPour({ worktree, home, paths, agentId, depot }, executer, fs);
  return { depot, worktree, paths, profil, git };
}

export function citer(texte: string) {
  return "'" + texte.replaceAll("'", "'\\''") + "'";
}

// La limite évite de laisser un processus persistant même si le test trouve un défaut.
const ecrireBattements = `
  for i in $(seq 1 150); do
    test ! -f fin-temoin || exit 0
    echo vivant >> battements || exit 1
    sleep 0.1
  done
`;

export const battement = `/bin/sh -c ${citer(`/bin/sh -c ${citer(ecrireBattements)} & wait`)} & wait`;

export function compterBattements(worktree: string) {
  const chemin = join(worktree, 'battements');
  return fs.existsSync(chemin) ? fs.readFileSync(chemin, 'utf8').split('\n').length - 1 : 0;
}

export async function verifierArret(worktree: string) {
  const avant = compterBattements(worktree);
  expect(avant, 'Le petit-fils doit avoir écrit plusieurs fois avant l’arrêt').toBeGreaterThan(1);
  await attendre(450);
  expect(compterBattements(worktree), 'Le petit-fils écrit encore après l’arrêt').toBe(avant);
}
