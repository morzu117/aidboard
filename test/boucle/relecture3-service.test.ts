import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkspaceQueue } from '../../src/daemon/actions/queue.js';
import * as depotBoucle from '../../src/daemon/boucle/depot.js';
import { ServiceBoucle } from '../../src/daemon/boucle/service.js';
import { openDb } from '../../src/daemon/db.js';
import { EventStore } from '../../src/daemon/events/store.js';
import { MemoryMirror } from '../../src/daemon/memory/mirror.js';
import { MemoryService } from '../../src/daemon/memory/service.js';
import { MemoryStore } from '../../src/daemon/memory/store.js';
import { seedTopic } from '../helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from '../helpers/git.js';
import { origineBoucle as url, poserOrigineBoucle, poserTemoinGitBoucle } from './temoin-git.js';

const sujet = 'tp_1';
let racine: string;
let home: string;
let depot: string;
let clone: string;
let origineLocale: string;
let db: ReturnType<typeof openDb>;
let service: ServiceBoucle;
let memoire: MemoryService;

beforeEach(() => {
  racine = realpathSync(mkdtempSync(join(tmpdir(), 'aid-relecture3-service-')));
  home = join(racine, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('AID_HOME', join(home, 'aid'));
  const systeme = join(racine, 'gitconfig-systeme');
  writeFileSync(systeme, '');
  vi.stubEnv('GIT_CONFIG_SYSTEM', systeme);
  const origine = makeOriginAndClone(racine, { name: 'depot-fictif' });
  clone = origine.clone;
  origineLocale = origine.origin;
  commitFile(
    clone,
    'agent.yml',
    'project: { namespace: aid }\nphases: [plan, dev, review]\ngates: { gate: "exit 0" }\n',
  );
  sh(clone, 'push', '-q', 'origin', 'main');
  depot = join(racine, 'sujet-fictif');
  sh(clone, 'worktree', 'add', '-qb', 'feat/s', depot, 'main');
  sh(depot, 'branch', 'branche-fictive');
  sh(depot, 'config', 'branch.branche-fictive.remote', 'origin');
  sh(depot, 'config', 'branch.branche-fictive.merge', 'refs/heads/main');
  poserOrigineBoucle(depot);

  db = openDb(join(racine, 'etat.db'));
  const miroir = new MemoryMirror(join(racine, 'memoire'));
  vi.spyOn(miroir, 'scheduleCommit').mockImplementation(() => {});
  memoire = new MemoryService({
    store: new MemoryStore(db),
    mirror: miroir,
    events: new EventStore(db),
    queue: new WorkspaceQueue(),
  });
  let sessions = 0;
  service = new ServiceBoucle({
    db,
    memory: memoire,
    agents: {
      lancer: async ({ genre, role }) => ({
        genre,
        modele: 'fictif',
        sessionId: `${role}-${++sessions}`,
      }),
      arreter: async () => {},
      ecrire: async () => {},
    },
  });
  seedTopic(db);
  db.prepare('UPDATE workspaces SET root = ?, worktrees_dir = ?').run(clone, racine);
  db.prepare('UPDATE topics SET worktree = ? WHERE id = ?').run(depot, sujet);
});

afterEach(async () => {
  try {
    await service?.fermer();
  } finally {
    db?.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(racine, { recursive: true, force: true });
  }
});

function poserTemoinGit(observer?: 'config') {
  const temoin = poserTemoinGitBoucle(racine, depot, observer);
  vi.stubEnv('PATH', temoin.chemin);
  return {
    ...temoin,
    distants: () => temoin.lire().filter(({ commande }) => commande.includes('ls-remote')),
  };
}

function dansDepot(cwd: string, racineDepot: string) {
  const chemin = relative(racineDepot, cwd);
  return chemin !== '..' && !chemin.startsWith(`..${sep}`) && !isAbsolute(chemin);
}

async function lancer() {
  db.prepare('DELETE FROM agents').run();
  await service.lancer(sujet);
}

const finirPlan = () =>
  service.traiterEvenementAgent('plan-1', { type: 'turn_end', texteFinal: 'Ajouter une note.' });

test.each([
  'remote.origin.uploadpack',
  'url.https://exemple.test/autre.insteadOf',
  'core.sshCommand',
  'credential.helper',
])('le premier ls-remote ne voit pas le réglage local %s', async (cle) => {
  const valeur = cle.endsWith('insteadOf') ? url : 'valeur-locale-fictive';
  sh(depot, 'config', '--local', cle, valeur);
  const temoin = poserTemoinGit('config');
  await lancer();
  expect(service.lire(sujet).etapeCourante?.teteDepart).toBe(temoin.tete);
  const appels = temoin.distants();
  expect(appels).toHaveLength(1);
  const appel = appels[0]!;
  expect.soft(dansDepot(appel.cwd, depot)).toBe(false);
  expect.soft(dansDepot(appel.cwd, clone)).toBe(false);
  expect.soft(appel.cwd).toBe('/');
  expect
    .soft(appel.commande.filter((arg) => /^(?:-C|--git-dir|--work-tree)/.test(arg)))
    .toEqual([]);
  expect.soft(appel.commande.slice(appel.commande.indexOf('ls-remote') + 1)).toContain(url);
  expect.soft(appel.retourConfig).toBe(0);
  const ligneLocale = [cle.toLowerCase(), valeur].join('=');
  expect(appel.config.toLowerCase()).not.toContain(ligneLocale.toLowerCase());
});

test('le ls-remote refuse les transports ext et file', async () => {
  const temoin = poserTemoinGit('config');
  await lancer();
  expect(temoin.distants()).toHaveLength(1);
  expect(temoin.distants()[0]!.commande).toEqual(
    expect.arrayContaining(['protocol.ext.allow=never', 'protocol.file.allow=never']),
  );
});

test.each([url, 'ssh://git@exemple.test/x.git', 'git@exemple.test:x.git'])(
  'le lancement accepte et transmet l’URL %s',
  async (adresse) => {
    sh(depot, 'remote', 'set-url', 'origin', adresse);
    const temoin = poserTemoinGit('config');
    await lancer();
    expect.soft(service.lire(sujet).phase).toBe('plan');
    expect(temoin.distants()).toHaveLength(1);
    const { commande } = temoin.distants()[0]!;
    const argumentsDistants = commande.slice(commande.indexOf('ls-remote') + 1);
    expect.soft(argumentsDistants).toContain(adresse);
    expect(argumentsDistants[argumentsDistants.indexOf(adresse) - 1]).toBe('--');
  },
);

test.each([
  ['file', (): string => `file://${join(racine, 'x')}`],
  ['chemin local', (): string => join(racine, 'x')],
  ['ext', (): string => 'ext::sh -c x'],
  ['hôte SSH commençant par un tiret', (): string => 'ssh://-oProxyCommand=x/y'],
  ['hôte SCP commençant par un tiret', (): string => '-oProxyCommand=x:y'],
  ['utilisateur SSH commençant par un tiret', (): string => 'ssh://-x@exemple.test/y.git'],
  ['utilisateur SCP commençant par un tiret', (): string => '-x@exemple.test:y.git'],
] as const)('le lancement refuse %s avant tout ls-remote', async (_nom, adresse) => {
  sh(depot, 'config', '--local', 'remote.origin.url', adresse());
  const temoin = poserTemoinGit('config');
  const [resultat] = await Promise.allSettled([lancer()]);
  expect.soft(resultat).toMatchObject({ status: 'rejected', reason: { status: 409 } });
  expect(temoin.distants()).toEqual([]);
});

test('une session active fait refuser le lancement avant tout ls-remote', async () => {
  const temoin = poserTemoinGit('config');
  await expect(service.lancer(sujet)).rejects.toMatchObject({ status: 409 });
  expect(temoin.distants()).toEqual([]);
});

function pousserAvecSuivi() {
  // Seul le push de la fixture reçoit le chemin du dépôt nu, via une option ponctuelle.
  sh(
    depot,
    '-c',
    `remote.origin.pushurl=${origineLocale}`,
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.file.allow=always',
    'push',
    '-qu',
    'origin',
    'feat/s',
  );
  expect(sh(depot, 'config', 'branch.feat/s.merge')).toBe('refs/heads/feat/s');
}

test.each([
  ['push -u', pousserAvecSuivi],
  ['branch -D', () => sh(depot, 'branch', '-D', 'branche-fictive')],
] as const)('%s entre deux étapes ne provoque pas d’escalade', async (_nom, modifier) => {
  poserTemoinGit();
  await lancer();
  await finirPlan();
  expect(service.lire(sujet).phase).toBe('attente_go');
  modifier();
  const [resultat] = await Promise.allSettled([service.go(sujet)]);
  expect.soft(resultat).toMatchObject({ status: 'fulfilled' });
  expect(service.lire(sujet).phase).toBe('dev');
});

test.each(['origin', '.'])(
  'branch.*.remote et pushRemote vers %s ne provoquent pas d’escalade',
  async (destination) => {
    poserTemoinGit();
    await lancer();
    await finirPlan();
    expect(service.lire(sujet).phase).toBe('attente_go');
    sh(depot, 'config', 'branch.feat/s.remote', destination);
    sh(depot, 'config', 'branch.feat/s.pushRemote', destination);
    const [resultat] = await Promise.allSettled([service.go(sujet)]);
    expect.soft(resultat).toMatchObject({ status: 'fulfilled' });
    expect(service.lire(sujet).phase).toBe('dev');
  },
);

test('un remote supplémentaire et son pushRemote provoquent une escalade scope', async () => {
  poserTemoinGit();
  await lancer();
  await finirPlan();
  expect(service.lire(sujet).phase).toBe('attente_go');
  sh(depot, 'remote', 'add', 'autre', 'https://exemple.test/autre.git');
  sh(depot, 'config', 'branch.feat/s.pushRemote', 'autre');
  await expect(service.go(sujet)).rejects.toMatchObject({ status: 409 });
  expect(service.lire(sujet)).toMatchObject({ phase: 'escalade', escalade: { raison: 'scope' } });
});

test.each(['remote', 'pushRemote'])(
  'branch.*.%s vers un remote déjà présent provoque une escalade scope',
  async (cle) => {
    sh(depot, 'remote', 'add', 'autre', 'https://exemple.test/autre.git');
    poserTemoinGit();
    await lancer();
    await finirPlan();
    expect(service.lire(sujet).phase).toBe('attente_go');
    sh(depot, 'config', `branch.feat/s.${cle}`, 'autre');
    await expect(service.go(sujet)).rejects.toMatchObject({ status: 409 });
    expect(service.lire(sujet)).toMatchObject({ phase: 'escalade', escalade: { raison: 'scope' } });
  },
);

// Ce scénario enchaîne des dizaines de vrais appels git.
test('après livraison et push -u, une nouvelle boucle démarre et la précédente reste livrable', async () => {
  poserTemoinGit();
  await lancer();
  await finirPlan();
  await service.go(sujet);
  commitFile(depot, 'note.md', 'Note fictive.');
  await memoire.put('aid/dev-handoff/s', 'Note ajoutée.', { kind: 'create' }, { author: 'test' });
  await service.traiterEvenementAgent('dev-2', { type: 'turn_end' });
  expect(service.lire(sujet).phase).toBe('revue');
  await service.traiterEvenementAgent('review-3', {
    type: 'turn_end',
    texteFinal: [
      '```json',
      JSON.stringify({
        tete: sh(depot, 'rev-parse', 'HEAD'),
        verdicts: { fichiers: { 'note.md': 'pass' }, points: {} },
        findings: [],
      }),
      '```',
    ].join('\n'),
  });
  const precedente = depotBoucle.lireDerniere(db, sujet);
  expect(precedente?.etat.phase).toBe('livraison_prete');
  pousserAvecSuivi();
  const [resultat] = await Promise.allSettled([service.lancer(sujet)]);
  expect.soft(resultat).toMatchObject({ status: 'fulfilled' });
  expect.soft(service.lire(sujet).phase).toBe('plan');
  expect(depotBoucle.lire(db, precedente!.id)?.etat.phase).toBe('livraison_prete');
}, 20_000);

test('un nouveau lancement ne compare pas la config locale à l’empreinte précédente', async () => {
  const temoin = poserTemoinGit('config');
  await lancer();
  await service.arreter(sujet);
  const precedente = depotBoucle.lireDerniere(db, sujet);
  expect(precedente?.etat.phase).toBe('arretee');
  sh(depot, 'config', '--local', 'credential.helper', 'valeur-locale-fictive');
  const [resultat] = await Promise.allSettled([service.lancer(sujet)]);
  expect.soft(resultat).toMatchObject({ status: 'fulfilled' });
  expect.soft(service.lire(sujet).phase).toBe('plan');
  expect.soft(temoin.distants()).toHaveLength(2);
  expect(depotBoucle.lire(db, precedente!.id)?.etat.phase).toBe('arretee');
});

test.each(['core.hooksPath', 'credential.helper'])(
  'modifier %s entre deux étapes provoque toujours une escalade scope',
  async (cle) => {
    poserTemoinGit();
    await lancer();
    await finirPlan();
    expect(service.lire(sujet).phase).toBe('attente_go');
    sh(depot, 'config', '--local', cle, 'valeur-locale-fictive');
    await expect(service.go(sujet)).rejects.toMatchObject({ status: 409 });
    expect(service.lire(sujet)).toMatchObject({ phase: 'escalade', escalade: { raison: 'scope' } });
  },
);

// Ce scénario enchaîne des dizaines de vrais appels git.
test('le fichier d’exclusions global protège .DS_Store d’une escalade', async () => {
  const exclusions = join(home, 'exclusions');
  writeFileSync(exclusions, '.DS_Store\n');
  writeFileSync(join(home, '.gitconfig'), `[core]\n  excludesFile = ${exclusions}\n`);
  vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
  poserTemoinGit();
  await lancer();
  await finirPlan();
  await service.go(sujet);
  commitFile(depot, 'note.md', 'Note fictive.');
  await memoire.put('aid/dev-handoff/s', 'Note ajoutée.', { kind: 'create' }, { author: 'test' });
  writeFileSync(join(depot, '.DS_Store'), 'Fichier ignoré.');
  await service.traiterEvenementAgent('dev-2', { type: 'turn_end' });
  expect(service.lire(sujet).phase).toBe('revue');
}, 20_000);

test.each([
  ['core', 'hooksPath', '/dev/null'],
  ['credential', 'helper', ''],
])('gitBoucle lit %s.%s global et le neutralise avec -c', async (section, cle, neutre) => {
  const valeur = 'valeur-globale-fictive';
  writeFileSync(join(home, '.gitconfig'), `[${section}]\n  ${cle} = ${valeur}\n`);
  vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
  const temoin = poserTemoinGit('config');
  await lancer();
  await finirPlan();
  const appels = temoin.lire().filter(({ commande }) => commande.includes('status'));
  expect(appels.length).toBeGreaterThan(0);
  const nom = `${section}.${cle.toLowerCase()}`;
  for (const appel of appels) {
    expect.soft(appel.config).toContain(`${nom}=${valeur}`);
    const valeurs = appel.config
      .split('\n')
      .map((ligne) => ligne.split('\t').at(-1))
      .filter((ligne) => ligne?.startsWith(`${nom}=`));
    expect(valeurs.at(-1)).toBe(`${nom}=${neutre}`);
    expect(appel.commande[appel.commande.indexOf(`${section}.${cle}=${neutre}`) - 1]).toBe('-c');
  }
});
