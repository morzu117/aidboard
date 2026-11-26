import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

const sujet = 'tp_1';
let racine: string;
let home: string;
let depot: string;
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

interface AppelGit {
  commande: string[];
  agentSsh: string | null;
  helper: string;
}

function poserTemoinGit() {
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(racine, 'bin');
  const journal = join(racine, 'git.jsonl');
  const agentSsh = join(home, 'socket-fictif');
  const helper = 'assistant-fictif';
  mkdirSync(bin);
  writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = ${helper}\n`);
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const commande = process.argv.slice(2);
let i = 0;
while (commande[i] === '-c') i += 2;
const git = ${JSON.stringify(git)};
const config = spawnSync(git, [...commande.slice(0, i), 'config', '--get', 'credential.helper'], {
  encoding: 'utf8',
});
if (config.error || ![0, 1].includes(config.status)) process.exit(1);
appendFileSync(${JSON.stringify(journal)}, JSON.stringify({
  commande,
  agentSsh: process.env.SSH_AUTH_SOCK ?? null,
  helper: config.stdout.trim(),
}) + '\\n');
const resultat = spawnSync(git, commande, { stdio: 'inherit' });
process.exit(resultat.status ?? 1);
`,
    { mode: 0o755 },
  );
  // Le helper est un nom inerte. Le témoin lit la config, et le remote est un dépôt local.
  // Le PATH des appels de fixture peut être rétabli sans désarmer le témoin.
  const cheminInitial = process.env.PATH;
  const cheminTemoin = [bin, cheminInitial].join(delimiter);
  vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
  vi.stubEnv('SSH_AUTH_SOCK', agentSsh);
  vi.stubEnv('PATH', cheminTemoin);
  return {
    agentSsh,
    helper,
    cheminInitial,
    cheminTemoin,
    lire: (): AppelGit[] =>
      readFileSync(journal, 'utf8')
        .trim()
        .split('\n')
        .map((ligne) => JSON.parse(ligne) as AppelGit),
  };
}

test('le ls-remote de lancement garde le socket SSH et le helper global du faux home', async () => {
  const tete = sh(depot, 'rev-parse', 'HEAD');
  const temoin = poserTemoinGit();
  await service.lancer(sujet);
  expect(service.lire(sujet).etapeCourante?.teteDepart).toBe(tete);
  const appels = temoin.lire().filter(({ commande }) => commande.includes('ls-remote'));
  expect(appels).toHaveLength(1);
  expect(appels[0]).toMatchObject({ agentSsh: temoin.agentSsh, helper: temoin.helper });
});

test('le ls-remote de lancement coupe les hooks et le fsmonitor et refuse protocol.ext', async () => {
  const tete = sh(depot, 'rev-parse', 'HEAD');
  const temoin = poserTemoinGit();
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

test('un second lancement après modification de la config locale escalade avant ls-remote', async () => {
  const tete = sh(depot, 'rev-parse', 'HEAD');
  const temoin = poserTemoinGit();
  await service.lancer(sujet);
  expect(service.lire(sujet).etapeCourante?.teteDepart).toBe(tete);
  await service.arreter(sujet);
  expect(service.lire(sujet).phase).toBe('arretee');
  expect(temoin.lire().filter(({ commande }) => commande.includes('ls-remote'))).toHaveLength(1);

  vi.stubEnv('PATH', temoin.cheminInitial);
  sh(depot, 'config', '--local', 'credential.helper', 'assistant-local-fictif');
  vi.stubEnv('PATH', temoin.cheminTemoin);
  const debutSecondLancement = temoin.lire().length;

  const [second] = await Promise.allSettled([service.lancer(sujet)]);
  if (second?.status === 'rejected') expect(second.reason).toMatchObject({ status: 409 });
  expect.soft(service.lire(sujet)).toMatchObject({
    phase: 'escalade',
    escalade: { raison: 'scope' },
  });
  expect(
    temoin
      .lire()
      .slice(debutSecondLancement)
      .filter(({ commande }) => commande.includes('ls-remote')),
  ).toEqual([]);
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

test('les git du dev, du gate et des preuves perdent le socket SSH et le helper global', async () => {
  const base = sh(depot, 'rev-parse', 'HEAD');
  const temoin = poserTemoinGit();
  await allerAuDev();

  vi.stubEnv('PATH', temoin.cheminInitial);
  mkdirSync(join(depot, 'test'));
  commitFile(
    depot,
    'test/recette.cjs',
    "process.exit(require('node:fs').existsSync('note.md') ? 0 : 1);\n",
    'Recette fictive\n\nAcceptation: 69.9',
  );
  const tete = await preparerFinDev();
  vi.stubEnv('PATH', temoin.cheminTemoin);

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
}, 15_000);

test('une réponse finale de revue avec un fail justifié consigne un fail à la tête relue', async () => {
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
});

test('la fin du plan ignore une modification de mémoire Claude hors du projet du sujet', async () => {
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
