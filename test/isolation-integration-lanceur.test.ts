import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, it } from 'vitest';
import {
  environnementIsole,
  envelopper,
  profilPour,
  spawnChildIsole,
} from '../src/daemon/isolation/lanceur.js';
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

const transcription = '00000000-0000-0000-0000-000000000001.jsonl';

const autreProjet = '.claude/projects/autre';

const fauxAgent = String.raw`#!/bin/sh
set -eu
for arg do
  if [ "$arg" = pty ]; then test -t 0; fi
done
for nom in GH_TOKEN AWS_SECRET_ACCESS_KEY SSH_AUTH_SOCK DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR; do
  if printenv "$nom" >/dev/null; then exit 3; fi
done
for fichier in .claude/settings.json .claude/settings.local.json .codex/config.toml; do
  if (printf '%s' modifie > "$HOME/$fichier"); then exit 4; fi
done
test "$(cat "$HOME/.claude.json")" = initial
printf '%s' modifie > "$HOME/.claude.json"
for fichier in .claude/.credentials.json .codex/auth.json; do
  printf '%s' rafraichi > "$HOME/$fichier"
done
if [ "$(basename "$0")" = codex ]; then
  test "$1" = -c
  printf '%s\n' 'codex continue après le refus de config'
else
  slug="$(pwd -P | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')"
  projet="$HOME/.claude/projects/$slug"
  test -d "$projet/memory"
  for fichier in "$projet/memory/MEMORY.md" "$projet/memory/nouveau.md"; do
    if (printf '%s' modifie > "$fichier"); then exit 5; fi
  done
  if (printf '%s' modifie > "$HOME/${autreProjet}/temoin"); then exit 6; fi
  test ! -e "$projet/${transcription}"
  printf '%s' nouvelle > "$projet/${transcription}"
  test ! -e "$HOME/.claude/todos/temoin"
  printf '%s' temporaire > "$HOME/.claude/todos/nouveau"
fi
test -f .mcp.json
if (printf '%s' modifie > .mcp.json); then exit 9; fi
test -d .claude
for fichier in .claude/settings.json .claude/settings.local.json; do
  if (printf '%s' modifie > "$fichier"); then exit 7; fi
done
if [ -f .claude/temoin ]; then
  test "$(cat .claude/temoin)" = initial
  if (printf '%s' modifie > .claude/temoin); then exit 8; fi
fi
touch dans-worktree CLAUDE.md AGENTS.md
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
      for (const nom of ['.claude', '.codex']) fs.mkdirSync(join(home, nom), { recursive: true });
      for (const fichier of [
        '.claude.json',
        '.claude/settings.json',
        '.claude/.credentials.json',
        '.codex/config.toml',
        '.codex/auth.json',
      ])
        fs.writeFileSync(join(home, fichier), 'initial');
      for (const nom of [
        'GH_TOKEN',
        'AWS_SECRET_ACCESS_KEY',
        'SSH_AUTH_SOCK',
        'DBUS_SESSION_BUS_ADDRESS',
        'XDG_RUNTIME_DIR',
      ])
        Object.assign(env, { [nom]: ['valeur', 'factice', nom].join('-') });
      fs.mkdirSync(join(home, autreProjet), { recursive: true });
      fs.writeFileSync(join(home, autreProjet, 'temoin'), 'initial');
      fs.mkdirSync(join(home, '.claude/todos'));
      fs.writeFileSync(join(home, '.claude/todos/temoin'), 'initial');
      fs.mkdirSync(bin);
      fs.writeFileSync(join(bin, agent), fauxAgent, { mode: 0o755 });
      git('git', ['init', '-q', worktree]);
      const projet = join(
        home,
        '.claude/projects',
        fs.realpathSync(worktree).replace(/[^A-Za-z0-9]/g, '-'),
      );
      const memoire = join(projet, 'memory');
      const claudeProjet = join(worktree, '.claude');
      if (mode === 'pty') {
        fs.mkdirSync(memoire, { recursive: true });
        fs.writeFileSync(join(memoire, 'MEMORY.md'), 'initial');
        fs.mkdirSync(claudeProjet);
        fs.writeFileSync(join(worktree, '.mcp.json'), '{}');
        fs.writeFileSync(join(claudeProjet, 'temoin'), 'initial');
      }
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
          env: environnementIsole(env),
        });
        terminal.onExit(() => lancement.nettoyer?.());
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
      if (mode === 'pty') {
        expect(fs.readFileSync(join(memoire, 'MEMORY.md'), 'utf8')).toBe('initial');
      } else {
        expect(fs.existsSync(join(memoire, 'MEMORY.md'))).toBe(false);
      }
      expect(fs.existsSync(join(memoire, 'nouveau.md'))).toBe(false);
      expect(fs.readFileSync(join(home, autreProjet, 'temoin'), 'utf8')).toBe('initial');
      expect(fs.readFileSync(join(home, '.claude/todos/temoin'), 'utf8')).toBe('initial');
      expect(fs.existsSync(join(home, '.claude/todos/nouveau'))).toBe(false);
      if (agent === 'codex') {
        expect(sortie).toContain('codex continue après le refus de config');
      } else {
        expect(fs.readFileSync(join(projet, transcription), 'utf8')).toBe('nouvelle');
      }
      for (const fichier of ['.claude.json', '.claude/settings.json', '.codex/config.toml']) {
        expect(fs.readFileSync(join(home, fichier), 'utf8')).toBe('initial');
      }
      expect(fs.existsSync(join(home, '.claude/settings.local.json'))).toBe(false);
      for (const fichier of ['.claude/.credentials.json', '.codex/auth.json']) {
        expect(fs.readFileSync(join(home, fichier), 'utf8')).toBe('rafraichi');
      }
      expect(sortie).toContain('worktree : écriture réussie');
      expect(sortie).toContain('home : écriture refusée');
      for (const fichier of ['dans-worktree', 'CLAUDE.md', 'AGENTS.md']) {
        expect(fs.existsSync(join(worktree, fichier))).toBe(true);
      }
      const mcpProjet = join(worktree, '.mcp.json');
      if (mode === 'pty') {
        expect(fs.readFileSync(mcpProjet, 'utf8')).toBe('{}');
      } else {
        expect(fs.existsSync(mcpProjet)).toBe(false);
        expect(fs.existsSync(claudeProjet)).toBe(false);
      }
      expect(fs.existsSync(join(claudeProjet, 'settings.json'))).toBe(false);
      expect(fs.existsSync(join(claudeProjet, 'settings.local.json'))).toBe(false);
      if (mode === 'pty')
        expect(fs.readFileSync(join(claudeProjet, 'temoin'), 'utf8')).toBe('initial');
      expect(fs.existsSync(join(home, 'hors-worktree'))).toBe(false);
    } finally {
      fs.rmSync(racine, { recursive: true, force: true });
    }
  },
  15_000,
);
