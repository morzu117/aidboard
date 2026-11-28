import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { produirePreuves } from '../src/acceptation/preuve.js';
import { creer } from '../src/daemon/boucle/depot.js';
import { lancerGate } from '../src/daemon/boucle/gate.js';
import { environnementGate } from '../src/daemon/boucle/git.js';
import { envelopper } from '../src/daemon/isolation/lanceur.js';
import { seedTopic, startTestDaemon, waitFor } from './helpers/daemon.js';
import { bwrapDeTest, citer, preparerSujet, utiliserBac } from './isolation-acceptation-temoins.js';

const bwrap = bwrapDeTest();
const bac = utiliserBac();

function preparerGate() {
  const { racine, home } = bac();
  const sujet = preparerSujet(racine, home);
  return {
    racine,
    home,
    ...sujet,
    isolation: { bwrapBin: bwrap!, profil: sujet.profil },
    options: { depot: sujet.worktree, delaiMs: 5_000, listerProcessus: async () => [] },
  };
}

function photographier(chemin: string) {
  const { ino, dev } = fs.statSync(chemin);
  return { contenu: fs.readFileSync(chemin, 'utf8'), ino, dev };
}

test.skipIf(!bwrap)(
  'le gate et les preuves masquent les identifiants que le faux agent de boucle lit',
  async () => {
    const { racine, home, depot, worktree, paths, git, isolation, options } = preparerGate();
    const identifiants = ['.claude/.credentials.json', '.claude.json', '.codex/auth.json'].map(
      (relatif) => {
        const chemin = join(home, relatif);
        const contenu = JSON.stringify({ temoin: ['factice', randomUUID()].join(' ') });
        fs.mkdirSync(dirname(chemin), { recursive: true });
        fs.writeFileSync(chemin, contenu);
        return { relatif, chemin, contenu };
      },
    );
    const lectureAgent = identifiants
      .map(
        ({ relatif, contenu }) =>
          `test "$(cat "$HOME"/${citer(relatif)})" = ${citer(contenu)} || exit 31`,
      )
      .join('\n');
    fs.writeFileSync(
      join(racine, 'codex'),
      `#!/bin/sh
${lectureAgent}
touch temoin-agent
`,
      { mode: 0o700 },
    );
    vi.stubEnv('PATH', [racine, process.env.PATH].join(delimiter));
    const { d, db } = await startTestDaemon(paths.home, {
      config: { agents: { transport: 'stream', isolation: 'bwrap' } },
    });
    const base = git(worktree, 'rev-parse', 'HEAD');
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
          tete: base,
          etapes: [],
          redevCap: 2,
          redevs: 0,
          gate: null,
          revue: null,
        },
      });
      const agent = d.agents.spawn({ topicId: 'tp_1', kind: 'codex', roleBoucle: 'dev' });
      expect(agent.isole).toBe(true);
      await waitFor(
        () => fs.existsSync(join(worktree, 'temoin-agent')),
        5_000,
        'lecture du faux agent',
      );
    } finally {
      await d.stop();
    }

    const verifierMasquage = identifiants
      .map(
        ({ chemin, relatif }) => `lu=$(cat ${citer(chemin)}) || exit 42
if test -n "$lu" || ! test ${citer(chemin)} -ef /dev/null; then
  printf '%s\\n' ${citer(`Masquage absent : ${relatif}`)} >&2
  exit 41
fi`,
      )
      .join('\n');
    fs.writeFileSync(join(worktree, 'masquage.sh'), verifierMasquage);
    const resultat = await lancerGate({
      ...options,
      tete: base,
      commande: '/bin/sh masquage.sh',
      isolation,
    });

    fs.mkdirSync(join(worktree, 'test'));
    fs.writeFileSync(
      join(worktree, 'test', 'recette.sh'),
      `${verifierMasquage}\ntest -f livraison || exit 1\n`,
    );
    git(worktree, 'add', 'test/recette.sh');
    git(worktree, 'commit', '-qm', 'Recette', '-m', 'Acceptation: 65.10');
    const commitRecette = git(worktree, 'rev-parse', 'HEAD');
    fs.writeFileSync(join(worktree, 'livraison'), '');
    git(worktree, 'add', 'livraison');
    git(worktree, 'commit', '-qm', 'Livraison');
    const tete = git(worktree, 'rev-parse', 'HEAD');
    const rapports = await produirePreuves(
      { depot: worktree, base, chemins: ['test/'], lancer: { 'test/': '/bin/sh {fichiers}' } },
      5_000,
      environnementGate(fs.mkdtempSync(join(racine, 'aid-preuve-'))),
      undefined,
      undefined,
      { enGroupe: true, isolation },
    );

    expect.soft(resultat, resultat.journal).toMatchObject({ issue: 'pass', codeSortie: 0 });
    expect(rapports).toMatchObject([
      {
        point: '65.10',
        preuve: {
          outcome: 'pass',
          commands: [
            { head: commitRecette, exit: 1 },
            { head: tete, exit: 0 },
          ],
        },
        fautes: [],
      },
    ]);
    for (const { chemin, contenu } of identifiants) {
      expect(fs.readFileSync(chemin, 'utf8')).toBe(contenu);
    }
  },
  25_000,
);

test.skipIf(!bwrap)('protège gitdir contre mv et contre rm suivi d’une recréation', () => {
  const { racine, home } = bac();
  const { profil, worktree } = preparerSujet(racine, home);
  const chemin = join(profil.gitDir!, 'gitdir');
  const avant = photographier(chemin);
  const lancement = envelopper(bwrap!, profil, { pty: false }, fs, '/bin/sh', [
    '-ec',
    `
test -f "$1"
remplacement=$(mktemp "$(dirname "$1")/.temoin-gitdir-XXXXXX")
trap 'rm -f "$remplacement" "$remplacement.deplace"' EXIT
printf '%s' factice > "$remplacement"
mv "$remplacement" "$remplacement.deplace"
mv "$remplacement.deplace" "$remplacement"
echec=0
if mv -f "$remplacement" "$1"; then
  echo 'mv a remplacé gitdir' >&2
  echec=41
fi
if rm -f "$1"; then
  printf '%s' factice > "$1"
  echo 'rm a permis de remplacer gitdir' >&2
  echec=42
fi
exit "$echec"
`,
    'verifier-gitdir',
    chemin,
  ]);
  try {
    expect
      .soft(() => execFileSync(lancement.file, lancement.args, { cwd: worktree, timeout: 5_000 }))
      .not.toThrow();
    expect(photographier(chemin)).toEqual(avant);
  } finally {
    lancement.nettoyer?.();
  }
});

test.skipIf(!bwrap)(
  'le script du gate tente les sorties C à F avec des témoins extérieurs',
  async () => {
    const { home, worktree, git, profil, isolation, options } = preparerGate();
    const pointeurs = [
      join(worktree, '.git'),
      ...['commondir', 'gitdir'].map((nom) => join(profil.gitDir!, nom)),
    ];
    const reglages = join(home, '.claude', 'settings.json');
    fs.mkdirSync(dirname(reglages));
    fs.writeFileSync(reglages, '{}');
    const fichiers = [...pointeurs, reglages].map((chemin) => ({
      chemin,
      avant: photographier(chemin),
    }));
    const runtime = join('/run/user', String(process.getuid!()));
    const dossiersCrees: string[] = [];
    const variables = ['GH_TOKEN', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'];
    for (const variable of variables) {
      vi.stubEnv(variable, ['valeur', 'factice'].join('-'));
      expect(process.env[variable]).toBe('valeur-factice');
    }

    try {
      for (const dossier of [dirname(runtime), runtime]) {
        try {
          fs.mkdirSync(dossier);
          dossiersCrees.push(dossier);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw new Error('Impossible de créer le témoin extérieur /run/user/<uid>', { cause });
          }
        }
      }
      const statutRuntime = fs.statSync(runtime);
      expect(statutRuntime.isDirectory()).toBe(true);
      fs.accessSync(runtime, fs.constants.R_OK | fs.constants.X_OK);
      const script = `
echec=0
for fichier in ${fichiers.map(({ chemin }) => citer(chemin)).join(' ')}; do
  if ! test -f "$fichier"; then
    printf 'Témoin absent : %s\\n' "$(basename "$fichier")" >&2
    echec=1
  elif (printf '%s' factice > "$fichier"); then
    printf 'Réécriture permise : %s\\n' "$(basename "$fichier")" >&2
    echec=1
  fi
done
if ls -a ${citer(runtime)} >/dev/null 2>&1 || (cd ${citer(runtime)}) 2>/dev/null; then
  echo 'Témoin /run/user/<uid> accessible' >&2
  echec=1
fi
for variable in ${variables.join(' ')}; do
  if printenv "$variable" >/dev/null; then
    printf 'Variable visible : %s\\n' "$variable" >&2
    echec=1
  fi
done
exit "$echec"
`;
      const resultat = await lancerGate({
        ...options,
        tete: git(worktree, 'rev-parse', 'HEAD'),
        commande: `cat > recette.sh <<'RECETTE' || exit 50
${script}
RECETTE
/bin/sh recette.sh`,
        isolation,
      });
      expect.soft(resultat, resultat.journal).toMatchObject({ issue: 'pass', codeSortie: 0 });
      for (const { chemin, avant } of fichiers) {
        expect(photographier(chemin)).toEqual(avant);
      }
      expect(fs.statSync(runtime)).toMatchObject({
        ino: statutRuntime.ino,
        dev: statutRuntime.dev,
      });
    } finally {
      for (const dossier of dossiersCrees.reverse()) fs.rmdirSync(dossier);
    }
  },
);
