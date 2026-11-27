import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkspaceQueue } from '../../src/daemon/actions/queue.js';
import * as depotBoucle from '../../src/daemon/boucle/depot.js';
import { ServiceBoucle } from '../../src/daemon/boucle/service.js';
import { DEFAULT_CONFIG } from '../../src/daemon/config.js';
import { openDb } from '../../src/daemon/db.js';
import { EventStore } from '../../src/daemon/events/store.js';
import { MemoryMirror } from '../../src/daemon/memory/mirror.js';
import { MemoryService } from '../../src/daemon/memory/service.js';
import { MemoryStore } from '../../src/daemon/memory/store.js';
import { resolvePaths } from '../../src/daemon/paths.js';
import { AgentManager } from '../../src/daemon/pty/manager.js';
import { ptyPreflight } from '../../src/daemon/pty/native.js';
import { createAuthState } from '../../src/daemon/security.js';
import { seedTopic, waitFor } from '../helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from '../helpers/git.js';
import { poserOrigineBoucle, poserTemoinGitBoucle } from './temoin-git.js';

const sujet = 'tp_1';
let racine: string;
let home: string;
let depot: string;
let db: ReturnType<typeof openDb>;
let evenements: EventStore;
let service: ServiceBoucle | undefined;
let memoire: MemoryService;

beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), 'aid-relecture4-service-'));
  home = join(racine, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('AID_HOME', join(home, 'aid'));
  vi.stubEnv('TMPDIR', racine);

  const { clone } = makeOriginAndClone(racine, { name: 'depot-fictif' });
  commitFile(
    clone,
    'agent.yml',
    'project: { namespace: aid }\nphases: [plan, dev, review]\ngates: { gate: "exit 0" }\n',
  );
  sh(clone, 'push', '-q', 'origin', 'main');
  depot = join(racine, 'sujet-fictif');
  sh(clone, 'worktree', 'add', '-qb', 'feat/s', depot, 'main');
  poserOrigineBoucle(depot);

  db = openDb(join(racine, 'etat.db'));
  seedTopic(db);
  db.prepare('DELETE FROM agents').run();
  db.prepare('UPDATE workspaces SET root = ?, worktrees_dir = ?').run(clone, racine);
  db.prepare('UPDATE topics SET worktree = ? WHERE id = ?').run(depot, sujet);

  evenements = new EventStore(db);
  const miroir = new MemoryMirror(join(racine, 'memoire'));
  vi.spyOn(miroir, 'scheduleCommit').mockImplementation(() => {});
  memoire = new MemoryService({
    store: new MemoryStore(db),
    mirror: miroir,
    events: evenements,
    queue: new WorkspaceQueue(),
  });
});

function ouvrirService() {
  service = new ServiceBoucle({
    db,
    memory: memoire,
    agents: {
      lancer: async ({ genre, role }) => ({ genre, modele: 'fictif', sessionId: role }),
      arreter: async () => {},
      ecrire: async () => {},
    },
  });
  return service;
}

afterEach(async () => {
  try {
    await service?.fermer();
  } finally {
    service = undefined;
    db?.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(racine, { recursive: true, force: true });
  }
});

function poserTemoin(observer?: 'commandes') {
  const temoin = poserTemoinGitBoucle(racine, depot, observer);
  vi.stubEnv('PATH', temoin.chemin);
  return () => temoin.lire().filter(({ commande }) => commande.includes('ls-remote'));
}

function retenirLectureDistante() {
  const bin = mkdtempSync(join(racine, 'attente-git-'));
  const arrivee = join(bin, 'arrivee.json');
  const reponse = join(bin, 'repondre');
  const citer = (valeur: string) => "'" + valeur.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
case " $* " in
  *" ls-remote "*)
    node -e '
      const { existsSync, readdirSync, renameSync, writeFileSync } = require("node:fs");
      const [arrivee, reponse, racine] = process.argv.slice(1);
      const dossiers = readdirSync(racine).filter(nom => nom.startsWith("aid-git-distant-"));
      writeFileSync(arrivee + ".attente", JSON.stringify({ cwd: process.cwd(), dossiers }));
      renameSync(arrivee + ".attente", arrivee);
      const attente = setInterval(() => {
        if (existsSync(reponse)) clearInterval(attente);
      }, 10);
    ' ${citer(arrivee)} ${citer(reponse)} ${citer(racine)} || exit 1
    ;;
esac
PATH=${citer(process.env.PATH ?? '')} exec git "$@"
`,
    { mode: 0o755 },
  );
  vi.stubEnv('PATH', [bin, process.env.PATH].join(delimiter));
  return {
    attendre: () =>
      waitFor(
        () => existsSync(arrivee) && (readFileSync(arrivee, 'utf8') || false),
        5_000,
        'entrée dans ls-remote',
      ).then((contenu) => JSON.parse(contenu) as { cwd: string; dossiers: string[] }),
    repondre: () => writeFileSync(reponse, ''),
  };
}

test('une session ordinaire démarrée pendant ls-remote fait refuser la boucle', async () => {
  await ptyPreflight();
  poserTemoin();
  const temoin = retenirLectureDistante();
  const service = ouvrirService();
  const paths = resolvePaths(join(home, 'aid'));
  mkdirSync(paths.logs, { recursive: true });
  vi.stubEnv('SHELL', '/bin/sh');
  const sessions = new AgentManager({
    db,
    store: evenements,
    config: DEFAULT_CONFIG,
    auth: createAuthState(),
    paths,
    port: () => 0,
  });
  const lancement = Promise.allSettled([service.lancer(sujet)]);
  try {
    await temoin.attendre();
    const session = sessions.spawn({ topicId: sujet, kind: 'shell' });
    expect(session).toMatchObject({ role: 'free', status: 'starting' });
    expect(sessions.liveAgents().map(({ id }) => id)).toContain(session.id);
    temoin.repondre();
    const [resultat] = await lancement;
    expect.soft(resultat).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect(depotBoucle.lireDerniere(db, sujet)).toBeUndefined();
  } finally {
    temoin.repondre();
    await lancement;
    try {
      await sessions.stopAll('user', 1_000);
    } finally {
      sessions.dispose();
    }
  }
}, 20_000);

test('ls-remote part de la racine sans créer de dossier temporaire dédié', async () => {
  poserTemoin();
  const temoin = retenirLectureDistante();
  const service = ouvrirService();
  const dossiersVus = new Set<string>();
  const surveillance = watch(racine, (_evenement, nom) => {
    if (nom?.startsWith('aid-git-distant-')) dossiersVus.add(nom);
  });
  const lancement = Promise.allSettled([service.lancer(sujet)]);
  try {
    const appel = await temoin.attendre();
    temoin.repondre();
    const [resultat] = await lancement;
    expect(resultat).toMatchObject({ status: 'fulfilled' });
    expect.soft(appel.cwd).toBe('/');
    expect(new Set([...appel.dossiers, ...dossiersVus]).size).toBe(0);
  } finally {
    temoin.repondre();
    await lancement;
    surveillance.close();
  }
}, 20_000);

test.each([
  ['https://user@exemple.test/x.git', 'https://user@exemple.test/x.git'],
  ['https://exemple.test:8443/x.git', 'https://exemple.test:8443/x.git'],
  ['ssh://git@exemple.test:2222/x.git', 'ssh://git@exemple.test:2222/x.git'],
  ['exemple-alias:equipe/x.git', 'exemple-alias:equipe/x.git'],
  ['HTTPS://exemple.test/x.git', 'https://exemple.test/x.git'],
])('le lancement accepte %s et transmet l’origine après --', async (origine, attendue) => {
  sh(depot, 'config', '--local', 'remote.origin.url', origine);
  const appels = poserTemoin('commandes');
  const service = ouvrirService();
  const [resultat] = await Promise.allSettled([service.lancer(sujet)]);
  expect.soft(resultat).toMatchObject({ status: 'fulfilled' });
  expect.soft(service.lire(sujet).phase).toBe('plan');
  const distants = appels();
  expect(distants).toHaveLength(1);
  const { commande } = distants[0]!;
  const separateur = commande.indexOf('--', commande.indexOf('ls-remote') + 1);
  expect(separateur).toBeGreaterThan(commande.indexOf('ls-remote'));
  expect(commande[separateur + 1]).toBe(attendue);
});

test.each([
  'git://exemple.test/x.git',
  'exemple:/abs/x.git',
  '1234:x.git',
  'C:\\x',
  '-alias:x.git',
  'https://-u@exemple.test/x.git',
  'exemple=x:y.git',
  'exemple x:y.git',
])('le lancement refuse %s avec 409 sans ls-remote', async (origine) => {
  sh(depot, 'config', '--local', 'remote.origin.url', origine);
  const appels = poserTemoin('commandes');
  const service = ouvrirService();
  await expect(service.lancer(sujet)).rejects.toMatchObject({ status: 409 });
  expect(appels()).toEqual([]);
});

test.each([
  { cas: 'conserve les exclusions', modifier: false, phase: 'revue' },
  { cas: 'escalade si la configuration change', modifier: true, phase: 'escalade' },
])(
  'GIT_CONFIG_GLOBAL $cas à la transition dev → revue',
  async ({ modifier, phase }) => {
    const exclusions = join(home, 'exclusions');
    const config = join(home, 'config-git-fictive');
    const contenu = `[core]\n  excludesFile = ${exclusions}\n`;
    writeFileSync(exclusions, '.DS_Store\n');
    writeFileSync(config, contenu);
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    poserTemoin();

    const service = ouvrirService();
    await service.lancer(sujet);
    await service.traiterEvenementAgent('plan', {
      type: 'turn_end',
      texteFinal: 'Ajouter une note.',
    });
    await service.go(sujet);
    expect(service.lire(sujet).phase).toBe('dev');
    commitFile(depot, 'note.md', 'Note fictive.');
    await memoire.put('aid/dev-handoff/s', 'Note ajoutée.', { kind: 'create' }, { author: 'test' });
    if (modifier) {
      // Modifier la config sans introduire d’autre motif d’escalade.
      writeFileSync(config, contenu + '# Configuration modifiée.\n');
    } else {
      writeFileSync(join(depot, '.DS_Store'), 'Fichier ignoré.');
      expect(sh(depot, 'check-ignore', '.DS_Store')).toBe('.DS_Store');
    }
    await service.traiterEvenementAgent('dev', { type: 'turn_end' });
    const etat = service.lire(sujet);
    expect(etat.phase).toBe(phase);
    if (modifier) expect(etat.escalade).toMatchObject({ raison: 'scope' });
  },
  20_000,
);

test.each([
  ['GIT_CONFIG_GLOBAL', '.env'],
  ['GIT_CONFIG_GLOBAL', 'process.env'],
  ['XDG_CONFIG_HOME', '.envrc'],
  ['XDG_CONFIG_HOME', 'process.env'],
] as const)(
  '%s reste celui du démarrage face à une valeur de remplacement dans %s',
  async (variable, remplacement) => {
    const exclusions = join(home, 'exclusions-demarrage');
    writeFileSync(exclusions, '.DS_Store\n');
    const exclusionsRemplacees = join(home, 'exclusions-remplacement');
    writeFileSync(exclusionsRemplacees, 'autre-fichier\n');

    function preparerConfig(nom: string, fichierExclusions: string) {
      const chemin = join(home, nom);
      if (variable === 'GIT_CONFIG_GLOBAL') {
        writeFileSync(chemin, `[core]\n  excludesFile = ${fichierExclusions}\n`);
      } else {
        const dossierGit = join(chemin, 'git');
        mkdirSync(dossierGit, { recursive: true });
        writeFileSync(
          join(dossierGit, 'config'),
          `[core]\n  excludesFile = ${fichierExclusions}\n`,
        );
      }
      return chemin;
    }

    const initial = preparerConfig('demarrage', exclusions);
    const autre = preparerConfig('remplacement', exclusionsRemplacees);
    vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
    vi.stubEnv(variable, initial);
    expect(sh(depot, 'config', '--global', '--get', 'core.excludesFile')).toBe(exclusions);

    if (remplacement !== 'process.env') {
      commitFile(depot, remplacement, `export ${variable}=${JSON.stringify(autre)}\n`);
    }

    const temoin = poserTemoinGitBoucle(racine, depot, 'config');
    vi.stubEnv('PATH', temoin.chemin);
    const service = ouvrirService();
    if (remplacement === 'process.env') {
      vi.stubEnv(variable, autre);
      expect(sh(depot, 'config', '--global', '--get', 'core.excludesFile')).toBe(
        exclusionsRemplacees,
      );
    }
    await service.lancer(sujet);
    await service.traiterEvenementAgent('plan', {
      type: 'turn_end',
      texteFinal: 'Ajouter une note.',
    });
    await service.go(sujet);
    expect(service.lire(sujet).phase).toBe('dev');
    if (remplacement === 'process.env') {
      vi.stubEnv(variable, preparerConfig('remplacement-apres-go', exclusionsRemplacees));
    }
    commitFile(depot, 'note.md', 'Note fictive.');
    await memoire.put('aid/dev-handoff/s', 'Note ajoutée.', { kind: 'create' }, { author: 'test' });
    writeFileSync(join(depot, '.DS_Store'), 'Fichier ignoré au démarrage.');
    await service.traiterEvenementAgent('dev', { type: 'turn_end' });

    const lectures = temoin.lire().filter(({ commande }) => commande.includes('status'));
    expect(lectures.length).toBeGreaterThan(0);
    for (const { config } of lectures) {
      expect.soft(config).toContain(`core.excludesfile=${exclusions}\n`);
      expect.soft(config).not.toContain(`core.excludesfile=${exclusionsRemplacees}\n`);
    }
    expect(service.lire(sujet).phase).toBe('revue');
  },
  20_000,
);
