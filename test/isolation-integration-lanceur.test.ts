import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, it } from 'vitest';
import { envelopper, profilPour, spawnChildIsole } from '../src/daemon/isolation/lanceur.js';
import { sonderBwrap } from '../src/daemon/isolation/sonde.js';
import { ensureHome, resolvePaths } from '../src/daemon/paths.js';
import { getPty, ptyPreflight } from '../src/daemon/pty/native.js';

function bwrapDeTest() {
  try {
    return sonderBwrap().bin;
  } catch (cause) {
    if (process.env.AID_BWRAP_REQUIS === '1') {
      throw new Error(`AID_BWRAP_REQUIS=1 : ${(cause as Error).message}`, { cause });
    }
    return undefined;
  }
}

const bwrap = bwrapDeTest();

const fauxAgent = String.raw`#!/bin/sh
set -eu
if [ "$1" = pty ]; then test -t 0; fi
touch dans-worktree
printf '%s\n' 'worktree : écriture réussie'
test -d "$HOME"
if touch "$HOME/hors-worktree"; then
  printf '%s\n' 'home : écriture réussie'
else
  printf '%s\n' 'home : écriture refusée'
fi
`;

it.skipIf(!bwrap).each([
  ['claude', 'stream'],
  ['codex', 'stream'],
  ['claude', 'pty'],
  ['codex', 'pty'],
])(
  'borne les écritures de %s en %s avec le vrai bwrap',
  async (agent, mode) => {
    // Bubblewrap recouvre /tmp. Le faux home et le PATH doivent rester visibles.
    const temporaire = fs.realpathSync(tmpdir());
    const parent =
      temporaire === '/tmp' || temporaire.startsWith('/tmp/') ? process.cwd() : temporaire;
    const racine = fs.realpathSync(fs.mkdtempSync(join(parent, 'aid-bwrap-lanceur-')));
    try {
      const home = join(racine, 'home');
      const bin = join(racine, 'bin');
      const paths = resolvePaths(join(racine, 'aid'));
      const worktree = join(paths.worktrees, 'sujet');
      const agentId = 'ag_test';
      const env = {
        ...process.env,
        HOME: home,
        AID_HOME: paths.home,
        PATH: [bin, process.env.PATH ?? ''].join(delimiter),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      };
      const git = (fichier: string, args: string[]) =>
        execFileSync(fichier, args, { encoding: 'utf8', env });
      ensureHome(paths);
      fs.mkdirSync(join(paths.attachments, agentId), { recursive: true });
      fs.mkdirSync(home);
      fs.mkdirSync(bin);
      fs.writeFileSync(join(bin, agent), fauxAgent, { mode: 0o755 });
      git('git', ['init', '-q', worktree]);
      const profil = profilPour({ worktree, home, paths, agentId }, git, fs);

      let sortie = '';
      let code: number | null;
      if (mode === 'stream') {
        const enfant = spawnChildIsole(bwrap!, profil, fs)(agent, [mode], {
          cwd: worktree,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        enfant.stdin.end();
        enfant.stdout.on('data', (donnees) => (sortie += donnees.toString()));
        enfant.stderr.on('data', (donnees) => (sortie += donnees.toString()));
        code = await new Promise<number | null>((resolve, reject) => {
          const delai = setTimeout(() => enfant.kill('SIGKILL'), 5000);
          enfant.once('error', (erreur) => {
            clearTimeout(delai);
            reject(erreur);
          });
          enfant.once('close', (codeSortie) => {
            clearTimeout(delai);
            resolve(codeSortie);
          });
        });
      } else {
        await ptyPreflight();
        const lancement = envelopper(bwrap!, profil, { pty: true }, fs, agent, [mode]);
        const terminal = getPty().spawn(lancement.file, lancement.args, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: worktree,
          env,
        });
        terminal.onData((donnees) => (sortie += donnees));
        code = await new Promise<number>((resolve) => {
          const delai = setTimeout(() => terminal.kill('SIGKILL'), 5000);
          terminal.onExit(({ exitCode }) => {
            clearTimeout(delai);
            resolve(exitCode);
          });
        });
      }

      expect(code, sortie).toBe(0);
      expect(sortie).toContain('worktree : écriture réussie');
      expect(sortie).toContain('home : écriture refusée');
      expect(fs.existsSync(join(worktree, 'dans-worktree'))).toBe(true);
      expect(fs.existsSync(join(home, 'hors-worktree'))).toBe(false);
    } finally {
      fs.rmSync(racine, { recursive: true, force: true });
    }
  },
  15_000,
);
