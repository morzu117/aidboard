import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { creer } from '../src/daemon/boucle/depot.js';
import { heureDepartGroupe } from '../src/daemon/boucle/groupes.js';
import { envelopper } from '../src/daemon/isolation/lanceur.js';
import { seedTopic, startTestDaemon, waitFor } from './helpers/daemon.js';
import {
  battement,
  bwrapDeTest,
  compterBattements,
  preparerSujet,
  utiliserBac,
  verifierArret,
} from './isolation-acceptation-temoins.js';

const bwrap = bwrapDeTest();
const bac = utiliserBac();

test.skipIf(!bwrap)(
  'isole le codex de dev et arrête le groupe consigné avec son petit-fils',
  async () => {
    const { racine, home } = bac();
    const { depot, worktree, paths, git } = preparerSujet(racine, home);
    fs.writeFileSync(
      join(racine, 'codex'),
      `#!/bin/sh
test -d "$HOME" || exit 30
if (touch "$HOME/hors-sujet"); then exit 31; fi
touch home-refuse || exit 32
${battement}`,
      { mode: 0o700 },
    );
    vi.stubEnv('PATH', [racine, process.env.PATH].join(delimiter));
    const { d, db } = await startTestDaemon(paths.home, {
      config: { agents: { transport: 'stream', isolation: 'bwrap' } },
    });
    try {
      seedTopic(db);
      db.prepare('UPDATE workspaces SET root = ?, worktrees_dir = ?').run(depot, racine);
      db.prepare('UPDATE topics SET worktree = ?').run(worktree);
      creer(db, {
        id: 'boucle-fictive',
        sujetId: 'tp_1',
        etat: {
          phase: 'dev',
          acceptation: false,
          empreintePlan: null,
          tete: git(worktree, 'rev-parse', 'HEAD'),
          etapes: [],
          redevCap: 2,
          redevs: 0,
          gate: null,
          revue: null,
        },
      });
      const consignerGroupe = vi.fn<(pid: number) => undefined>(() => undefined);
      const agent = d.agents.spawn({
        topicId: 'tp_1',
        kind: 'codex',
        roleBoucle: 'dev',
        consignerGroupe,
      });
      expect(agent.isole).toBe(true);
      await waitFor(() => compterBattements(worktree) >= 3, 5_000, 'battements de codex isolé');
      expect(fs.existsSync(join(worktree, 'home-refuse'))).toBe(true);
      expect(fs.existsSync(join(home, 'hors-sujet'))).toBe(false);
      expect(consignerGroupe).toHaveBeenCalledTimes(1);
      const pid = consignerGroupe.mock.calls[0]![0];
      expect(heureDepartGroupe(pid)).toBeDefined();
      expect(fs.readFileSync(join('/proc', String(pid), 'cmdline'), 'utf8').split('\0')[0]).toBe(
        bwrap,
      );
      await d.agents.arreterBoucle(agent.id);
      await verifierArret(worktree);
    } finally {
      fs.writeFileSync(join(worktree, 'fin-temoin'), '');
      await d.stop();
    }
  },
  20_000,
);

function verifierDansBac(
  profil: ReturnType<typeof preparerSujet>['profil'],
  script: string,
  ...argumentsScript: string[]
) {
  const lancement = envelopper(bwrap!, profil, { pty: false }, fs, '/bin/sh', [
    '-ec',
    script,
    'verifier',
    ...argumentsScript,
  ]);
  try {
    execFileSync(lancement.file, lancement.args, { cwd: profil.worktree, timeout: 5_000 });
  } finally {
    lancement.nettoyer?.();
  }
}

test.skipIf(!bwrap).each(['.git', 'commondir'])('protège %s contre le remplacement', (nom) => {
  const { racine, home } = bac();
  const { profil, worktree } = preparerSujet(racine, home);
  const chemin = nom === '.git' ? join(worktree, nom) : join(profil.gitDir!, nom);
  const contenu = fs.readFileSync(chemin, 'utf8');
  const { ino, dev } = fs.statSync(chemin);
  verifierDansBac(
    profil,
    `
    test -f "$1"
    touch "\${1%/*}/.temoin-renommage"
    mv "\${1%/*}/.temoin-renommage" "\${1%/*}/.temoin-deplace"
    rm "\${1%/*}/.temoin-deplace"
    printf '%s' factice > "\${1%/*}/.temoin-remplacement"
    if mv -f "\${1%/*}/.temoin-remplacement" "$1"; then exit 41; fi
    if rm -f "$1"; then
      printf '%s' factice > "$1"
      exit 42
    fi
    test -f "$1"
    rm "\${1%/*}/.temoin-remplacement"
  `,
    chemin,
  );
  expect(fs.readFileSync(chemin, 'utf8')).toBe(contenu);
  expect(fs.statSync(chemin)).toMatchObject({ ino, dev });
});

test.skipIf(!bwrap)('masque /run/user après avoir vérifié un témoin extérieur', () => {
  const { racine, home } = bac();
  const { profil } = preparerSujet(racine, home);
  const runtime = join('/run/user', String(process.getuid!()));
  const crees: string[] = [];
  try {
    for (const dossier of [dirname(runtime), runtime]) {
      try {
        fs.mkdirSync(dossier);
        crees.push(dossier);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new Error(
            `Impossible de créer le témoin extérieur /run/user/<uid> : ${(cause as Error).message}`,
            { cause },
          );
        }
      }
    }
    expect(fs.statSync(runtime).isDirectory(), 'Témoin extérieur /run/user/<uid> absent').toBe(
      true,
    );
    verifierDansBac(
      profil,
      `
      if test -d /run/user; then
        entrees=$(ls -A /run/user) || exit 43
        test -z "$entrees"
      fi
    `,
    );
  } finally {
    for (const dossier of crees.reverse()) fs.rmdirSync(dossier);
  }
});
