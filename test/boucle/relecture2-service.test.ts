import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkspaceQueue } from '../../src/daemon/actions/queue.js';
import * as conducteur from '../../src/daemon/boucle/conducteur.js';
import * as depotBoucle from '../../src/daemon/boucle/depot.js';
import { lancerGate } from '../../src/daemon/boucle/gate.js';
import { ServiceBoucle } from '../../src/daemon/boucle/service.js';
import { openDb } from '../../src/daemon/db.js';
import { EventStore } from '../../src/daemon/events/store.js';
import { MemoryMirror } from '../../src/daemon/memory/mirror.js';
import { MemoryService } from '../../src/daemon/memory/service.js';
import { MemoryStore } from '../../src/daemon/memory/store.js';
import { seedTopic } from '../helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from '../helpers/git.js';
import {
  nommerDepotPourLesPreuves,
  poserOrigineBoucle,
  poserTemoinGitBoucle,
} from './temoin-git.js';

const sujet = 'tp_1';
let racine: string;
let home: string;
let depot: string;
let cheminInitial: string | undefined;
let temoin: ReturnType<typeof poserTemoinGitBoucle>;
let db: ReturnType<typeof openDb>;
let memoire: MemoryService;
let service: ServiceBoucle;

function ouvrirService() {
  db = openDb(join(racine, 'etat.db'));
  const miroir = new MemoryMirror(join(racine, 'memoire'));
  vi.spyOn(miroir, 'scheduleCommit').mockImplementation(() => {});
  memoire = new MemoryService({
    store: new MemoryStore(db),
    mirror: miroir,
    events: new EventStore(db),
    queue: new WorkspaceQueue(),
  });
  service = new ServiceBoucle({
    db,
    memory: memoire,
    agents: {
      lancer: async ({ genre, role }) => ({ genre, modele: 'fictif', sessionId: role }),
      arreter: async () => {},
      ecrire: async () => {},
    },
  });
}

beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), 'aid-relecture-service-'));
  home = join(racine, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(home, 'aid'));
  const { clone } = makeOriginAndClone(racine);
  commitFile(
    clone,
    'agent.yml',
    'project: { namespace: aid }\nphases: [plan, dev, review]\ngates: { gate: "exit 0" }\n',
  );
  sh(clone, 'push', '-q', 'origin', 'main');
  depot = join(racine, 'sujet-fictif');
  sh(clone, 'worktree', 'add', '-qb', 'feat/s', depot, 'main');
  poserOrigineBoucle(depot);
  cheminInitial = process.env.PATH;
  ouvrirService();
  seedTopic(db);
  db.prepare('DELETE FROM agents').run();
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

async function configurerIdentifiants() {
  temoin = poserTemoinGitBoucle(racine, depot, 'identifiants');
  vi.stubEnv('PATH', temoin.chemin);
  const agentSsh = join(home, 'socket-fictif');
  const helper = 'assistant-fictif';
  writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = ${helper}\n`);
  vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
  vi.stubEnv('SSH_AUTH_SOCK', agentSsh);
  await service.fermer();
  db.close();
  ouvrirService();
  return { agentSsh, helper };
}

test('le ls-remote de lancement garde le socket SSH et le helper global du faux home', async () => {
  const tete = sh(depot, 'rev-parse', 'HEAD');
  const identifiants = await configurerIdentifiants();
  await service.lancer(sujet);
  expect(service.lire(sujet).etapeCourante?.teteDepart).toBe(tete);
  const appels = temoin.lire().filter(({ commande }) => commande.includes('ls-remote'));
  expect(appels).toHaveLength(1);
  expect(appels[0]).toMatchObject(identifiants);
});

test('le ls-remote de lancement coupe les hooks et le fsmonitor et refuse protocol.ext', async () => {
  const tete = sh(depot, 'rev-parse', 'HEAD');
  await configurerIdentifiants();
  await service.lancer(sujet);
  expect(service.lire(sujet).etapeCourante?.teteDepart).toBe(tete);
  const appels = temoin.lire().filter(({ commande }) => commande.includes('ls-remote'));
  expect(appels).toHaveLength(1);
  expect(appels[0]?.commande).toEqual(
    expect.arrayContaining([
      'core.hooksPath=/dev/null',
      'core.fsmonitor=false',
      'protocol.ext.allow=never',
    ]),
  );
});

const finirPlan = () =>
  service.traiterEvenementAgent('plan', {
    type: 'turn_end',
    texteFinal: 'Ajouter une note.',
  });

async function allerAuDev() {
  await service.lancer(sujet);
  await finirPlan();
  await service.go(sujet);
  expect(service.lire(sujet).phase).toBe('dev');
}

async function preparerFinDev() {
  commitFile(depot, 'note.md', 'Note fictive.');
  await memoire.put(
    'aid/dev-handoff/s',
    'Note ajoutée.',
    { kind: 'create' },
    { author: 'run:fictif' },
  );
  return sh(depot, 'rev-parse', 'HEAD');
}

// Ce scénario enchaîne des dizaines de vrais appels git.
test('les git du dev, du gate et des preuves perdent le socket SSH et le helper global', async () => {
  const base = sh(depot, 'rev-parse', 'HEAD');
  nommerDepotPourLesPreuves(depot);
  await configurerIdentifiants();
  await allerAuDev();

  vi.stubEnv('PATH', cheminInitial);
  mkdirSync(join(depot, 'test'));
  commitFile(
    depot,
    'test/recette.cjs',
    "process.exit(require('node:fs').existsSync('note.md') ? 0 : 1);\n",
    'Recette fictive\n\nAcceptation: 69.9',
  );
  const tete = await preparerFinDev();
  vi.stubEnv('PATH', temoin.chemin);

  const debutDev = temoin.lire().length;
  await service.traiterEvenementAgent('dev', { type: 'turn_end' });
  const appelsDev = temoin.lire().slice(debutDev);
  expect(service.lire(sujet).phase).toBe('revue');
  expect(appelsDev.some(({ commande }) => commande.includes('diff'))).toBe(true);

  const debutGate = temoin.lire().length;
  const gate = await lancerGate({
    depot,
    tete,
    commande: 'exit 0',
    delaiMs: 4_000,
    acceptation: { base, chemins: ['test/'], lancer: { 'test/': 'node {fichiers}' } },
  });
  expect(gate.issue).toBe('pass');
  const appelsGate = temoin.lire().slice(debutGate);
  expect(appelsGate.some(({ commande }) => commande.includes('rev-parse'))).toBe(true);
  expect(
    appelsGate.some(({ commande }) => commande.includes('worktree') && commande.includes('add')),
  ).toBe(true);

  for (const appel of [...appelsDev, ...appelsGate]) {
    expect(appel).toMatchObject({ agentSsh: null, helper: '' });
  }
}, 20_000);

// Ce scénario enchaîne des dizaines de vrais appels git.
test('une réponse finale de revue avec un fail justifié consigne un fail à la tête relue', async () => {
  vi.stubEnv('PATH', poserTemoinGitBoucle(racine, depot).chemin);
  await allerAuDev();
  const tete = await preparerFinDev();
  await service.traiterEvenementAgent('dev', { type: 'turn_end' });
  expect(service.lire(sujet).phase).toBe('revue');
  const reponse = {
    tete,
    verdicts: { fichiers: { 'note.md': 'fail' }, points: {} },
    findings: [
      {
        severite: 'majeure',
        categorie: 'design',
        emplacement: 'note.md:1',
        probleme: 'La note est incomplète.',
        action: 'Préciser la décision.',
      },
    ],
  };
  await service.traiterEvenementAgent('review', {
    type: 'turn_end',
    texteFinal: ['```json', JSON.stringify(reponse), '```'].join('\n'),
  });
  const boucle = lireBoucle();
  expect(boucle.etat.etapes.findLast(({ type }) => type === 'revue')).toMatchObject({
    issue: 'fail',
    teteArrivee: tete,
  });
}, 20_000);

test('la fin du plan ignore une modification de mémoire Claude hors du projet du sujet', async () => {
  vi.stubEnv('PATH', poserTemoinGitBoucle(racine, depot).chemin);
  const autreMemoire = join(home, '.claude', 'projects', '-autre-projet-fictif', 'memory');
  mkdirSync(autreMemoire, { recursive: true });
  const fichier = join(autreMemoire, 'MEMORY.md');
  writeFileSync(fichier, 'Avant.');
  await service.lancer(sujet);
  writeFileSync(fichier, 'Après.');
  await finirPlan();
  expect(service.lire(sujet).phase).toBe('attente_go');
});

function lireBoucle() {
  const { id } = db.prepare('SELECT id FROM boucles WHERE sujet_id = ?').get(sujet) as {
    id: string;
  };
  return depotBoucle.lire(db, id)!;
}

test('le conducteur ne fournit plus de terminaison de revue depuis la page', () => {
  expect(conducteur).not.toHaveProperty('terminerRevue');
});

function heureDepart(pid: number): string {
  if (process.platform === 'linux') {
    const stat = readFileSync(join('/proc', String(pid), 'stat'), 'utf8');
    const heure = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
    if (!heure) throw new Error('Heure de départ du processus fictif absente');
    return heure;
  }
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
}

async function reprendreAvecProcessus(
  cas: 'sans-enregistrement' | 'meme-depart' | 'pid-reutilise',
) {
  vi.stubEnv('PATH', poserTemoinGitBoucle(racine, depot).chemin);
  await service.lancer(sujet);
  const enfant = spawn('sleep', ['30'], {
    // Le groupe valide a quitté le worktree. Le groupe réutilisé a le même cwd que la boucle.
    cwd: cas === 'meme-depart' ? home : depot,
    detached: true,
    stdio: 'ignore',
  });
  const sortie = once(enfant, 'exit');
  try {
    await once(enfant, 'spawn');
    const pid = enfant.pid;
    if (!pid || pid <= 1) throw new Error('PID fictif absent');
    if (cas !== 'sans-enregistrement') {
      const boucle = lireBoucle();
      const depart = heureDepart(pid);
      boucle.etat.groupes = [{ pid, heureDepart: cas === 'meme-depart' ? depart : '0' }];
      depotBoucle.enregistrer(db, boucle);
    }
    await service.fermer();
    db.close();
    ouvrirService();
    const signaler = vi.spyOn(process, 'kill');
    await service.reprendre();
    const cibles = signaler.mock.calls.filter(([, signal]) => signal !== 0).map(([cible]) => cible);
    expect(service.lire(sujet).phase).toBe('escalade');
    if (cas === 'meme-depart') {
      expect(cibles).toContain(-pid);
      await expect.poll(() => enfant.signalCode).not.toBeNull();
    } else {
      expect(cibles).not.toContain(-pid);
      expect(cibles).not.toContain(pid);
      expect(enfant.kill(0)).toBe(true);
    }
  } finally {
    enfant.kill('SIGKILL');
    await sortie;
  }
}

test('la reprise épargne un processus du worktree sans enregistrement', () =>
  reprendreAvecProcessus('sans-enregistrement'));

test('la reprise tue le groupe enregistré quand son chef a la même heure de départ', () =>
  reprendreAvecProcessus('meme-depart'));

test('la reprise épargne le PID enregistré dont l’heure de départ a changé', () =>
  reprendreAvecProcessus('pid-reutilise'));
