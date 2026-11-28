import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { produirePreuves } from '../src/acceptation/preuve.js';
import { lancerGate } from '../src/daemon/boucle/gate.js';
import { environnementGate } from '../src/daemon/boucle/git.js';
import {
  battement,
  bwrapDeTest,
  citer,
  preparerSujet,
  utiliserBac,
  verifierArret,
} from './isolation-acceptation-temoins.js';

vi.mock('node:child_process', { spy: true });

const bwrap = bwrapDeTest();
const bac = utiliserBac();

function preparerGate() {
  const { racine, home } = bac();
  const sujet = preparerSujet(racine, home);
  const { depot, worktree, git, profil } = sujet;
  const reglagesClaude = join(home, '.claude', 'settings.json');
  const hook = join(depot, '.git', 'hooks', 'temoin');
  fs.mkdirSync(join(depot, '.git', 'hooks'), { recursive: true });
  const ecritureHome = join(home, 'hors-sujet');
  fs.mkdirSync(join(home, '.claude'));
  fs.writeFileSync(reglagesClaude, '{}');
  vi.stubEnv('GH_TOKEN', ['valeur', 'de', 'test'].join('-'));
  const script = `
test -d "$HOME" || exit 30
test -f ${citer(reglagesClaude)} || exit 31
test -d ${citer(join(depot, '.git', 'hooks'))} || exit 32
if (touch ${citer(ecritureHome)}); then exit 41; fi
if (touch ${citer(hook)}); then exit 42; fi
if (printf '%s' modifie > ${citer(reglagesClaude)}); then exit 43; fi
if printenv GH_TOKEN >/dev/null; then exit 44; fi
test -n "$TMPDIR" || exit 45
test -d "$TMPDIR" || exit 46
printf '%s' temporaire > "$TMPDIR/temoin" || exit 47
test "$(cat "$TMPDIR/temoin")" = temporaire || exit 48
printf '%s' sujet > temoin-sujet || exit 49
`;
  return {
    ...sujet,
    isolation: { bwrapBin: bwrap!, profil },
    options: {
      depot: worktree,
      tete: git(worktree, 'rev-parse', 'HEAD'),
      delaiMs: 5_000,
      graceMs: 150,
      listerProcessus: async () => [],
    },
    script,
    verifierDehors() {
      expect(fs.existsSync(ecritureHome)).toBe(false);
      expect(fs.existsSync(hook)).toBe(false);
      expect(fs.readFileSync(reglagesClaude, 'utf8')).toBe('{}');
    },
  };
}

test.skipIf(!bwrap)('isole le script écrit et exécuté par le gate', async () => {
  const { options, isolation, script, verifierDehors, worktree } = preparerGate();
  const resultat = await lancerGate({
    ...options,
    commande: `cat > recette.sh <<'RECETTE' || exit 50
${script}
RECETTE
/bin/sh recette.sh`,
    ...{ isolation },
  });
  expect(resultat, resultat.journal).toMatchObject({ issue: 'pass', codeSortie: 0 });
  expect(fs.readFileSync(join(worktree, 'temoin-sujet'), 'utf8')).toBe('sujet');
  verifierDehors();
});

test.skipIf(!bwrap)('isole les deux exécutions de la preuve d’acceptation', async () => {
  const { racine } = bac();
  const { worktree, git, options, isolation, script, verifierDehors } = preparerGate();
  const base = git(worktree, 'rev-parse', 'HEAD');
  fs.mkdirSync(join(worktree, 'test'));
  fs.writeFileSync(
    join(worktree, 'test', 'recette.sh'),
    `${script}\ntest -f livraison || exit 1\n`,
  );
  git(worktree, 'add', 'test/recette.sh');
  git(worktree, 'commit', '-qm', 'Recette', '-m', 'Acceptation: 65.9');
  const commitRecette = git(worktree, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(worktree, 'livraison'), '');
  git(worktree, 'add', 'livraison');
  git(worktree, 'commit', '-qm', 'Livraison');
  const tete = git(worktree, 'rev-parse', 'HEAD');
  const temporaire = fs.mkdtempSync(join(racine, 'preuve-'));
  const env = environnementGate(temporaire);
  // Témoin volontairement injecté après le premier filtrage pour exercer celui du bac.
  env.GH_TOKEN = process.env.GH_TOKEN;
  const acceptation = { base, chemins: ['test/'], lancer: { 'test/': '/bin/sh {fichiers}' } };
  const rapports = await produirePreuves(
    { depot: worktree, ...acceptation },
    5_000,
    env,
    undefined,
    undefined,
    { enGroupe: true, ...{ isolation } },
  );
  expect(rapports).toMatchObject([
    {
      point: '65.9',
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
  expect(fs.readFileSync(join(temporaire, 'temoin'), 'utf8')).toBe('temporaire');
  const resultat = await lancerGate({
    ...options,
    tete,
    commande: ':',
    acceptation,
    ...{ isolation },
  });
  expect(resultat).toMatchObject({ issue: 'pass', fichiersAcceptation: ['test/recette.sh'] });

  verifierDehors();
});

test.skipIf(!bwrap).each(['délai', 'arrêt'] as const)(
  'le %s du gate isolé arrête le petit-fils',
  async (mode) => {
    const { options, isolation, worktree } = preparerGate();
    const controle = new AbortController();
    const consignerGroupe = vi.fn<(pid: number) => undefined>(() => undefined);
    // Le témoin n’est attendu que sur le chemin d’arrêt explicite.
    const resultat = lancerGate({
      ...options,
      commande: battement,
      delaiMs: mode === 'délai' ? 3_000 : 8_000,
      signal: controle.signal,
      consignerGroupe,
      ...{ isolation },
    });
    try {
      if (mode === 'arrêt') {
        await vi.waitFor(
          () => {
            expect(
              fs.readFileSync(join(worktree, 'battements'), 'utf8').trim().split('\n').length,
            ).toBeGreaterThan(2);
          },
          { timeout: 5_000 },
        );
        controle.abort();
      }
      expect(await resultat).toMatchObject({ issue: 'cannot_evaluate', codeSortie: null });
      expect(consignerGroupe).toHaveBeenCalledTimes(1);
      await verifierArret(worktree);
    } finally {
      fs.writeFileSync(join(worktree, 'fin-temoin'), '');
      controle.abort();
      await resultat;
    }
  },
  15_000,
);

test('isolation off : lance la commande par le shell sans bwrap dans l’argv', async () => {
  const { options, worktree } = preparerGate();
  const lancements = vi.mocked(spawn);
  lancements.mockClear();
  const commande = 'printf "%s" lance > temoin-off';
  expect(await lancerGate({ ...options, commande })).toMatchObject({
    issue: 'pass',
    codeSortie: 0,
  });
  expect(lancements.mock.calls.map(([programme, argv]) => [programme, argv])).toContainEqual([
    '/bin/sh',
    ['-c', commande],
  ]);
  expect(
    lancements.mock.calls.some(([programme, argv]) =>
      [programme, ...(Array.isArray(argv) ? argv : [])].some((argument) =>
        /(^|\/)bwrap$/.test(argument),
      ),
    ),
  ).toBe(false);
  expect(fs.readFileSync(join(worktree, 'temoin-off'), 'utf8')).toBe('lance');
});
