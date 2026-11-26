import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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

const sujet = 'tp_1';
const pageRevue = 'aid/review/s';
let dossier: string;
let depot: string;
let commun: string;
let db: ReturnType<typeof openDb>;
let memoire: MemoryService;
let service: ServiceBoucle;

const arreter = vi.fn<(session: string) => Promise<void>>(async () => {});
const ecrire = vi.fn<(session: string, texte: string) => Promise<void>>(async () => {});
const gate = vi.fn<NonNullable<ConstructorParameters<typeof ServiceBoucle>[0]['lancerGate']>>(
  async ({ tete }) => ({ tete, issue: 'pass', codeSortie: 0, dureeMs: 1, journal: '' }),
);

function ouvrirService(maintenant?: () => number) {
  db = openDb(join(dossier, 'etat.db'));
  const miroir = new MemoryMirror(join(dossier, 'memoire'));
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
      arreter,
      ecrire,
    },
    lancerGate: gate,
    maintenant,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dossier = mkdtempSync(join(tmpdir(), 'aid-relecture-service-'));
  const home = join(dossier, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(dossier, 'aid-home'));
  const { clone } = makeOriginAndClone(dossier);
  commun = join(clone, '.git');
  depot = join(dossier, 'sujet-fictif');
  commitFile(
    clone,
    'agent.yml',
    'project: { namespace: aid }\nphases: [plan, dev, review]\ngates: { gate: "exit 0" }\n',
  );
  commitFile(clone, '.gitignore', '.mcp.json\n.npmrc\nnode_modules/\n');
  sh(clone, 'push', '-q', 'origin', 'main');
  sh(clone, 'worktree', 'add', '-qb', 'feat/s', depot, 'main');
  ouvrirService(() => 1_000);
  seedTopic(db);
  db.prepare('DELETE FROM agents').run();
  db.prepare('UPDATE topics SET worktree = ? WHERE id = ?').run(depot, sujet);
});

afterEach(async () => {
  await service?.fermer();
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dossier, { recursive: true, force: true });
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
  await memoire.put('aid/dev-handoff/s', 'Note ajoutée.', { kind: 'create' }, { author: 'dev' });
}

const finirDev = () => service.traiterEvenementAgent('dev', { type: 'turn_end' });

function revueValide() {
  return [
    '```json',
    JSON.stringify({
      tete: sh(depot, 'rev-parse', 'HEAD'),
      verdicts: { fichiers: { 'note.md': 'pass' }, points: {} },
      findings: [],
    }),
    '```',
  ].join('\n');
}

test('une page de revue présente avant la revue ne remplace pas sa réponse finale', async () => {
  await allerAuDev();
  await preparerFinDev();
  await memoire.put(pageRevue, revueValide(), { kind: 'create' }, { author: 'dev-fictif' });
  await finirDev();
  expect(service.lire(sujet).phase).toBe('revue');

  await service.traiterEvenementAgent('review', { type: 'turn_end' });
  expect(service.lire(sujet)).toMatchObject({
    phase: 'revue',
    etapeCourante: { tentative: 1, relance: true },
  });
  expect(ecrire).toHaveBeenLastCalledWith('review', expect.stringContaining('artefact'));
  await service.traiterEvenementAgent('review', { type: 'turn_end' });
  expect(service.lire(sujet)).toMatchObject({
    phase: 'escalade',
    escalade: { raison: 'ambiguity' },
  });
});

test('un tour de revue sans texte final relance immédiatement sans tic', async () => {
  await allerAuDev();
  await preparerFinDev();
  await finirDev();
  const echeance = service.lire(sujet).etapeCourante?.echeance;
  expect(echeance).toBeGreaterThan(1_000);
  ecrire.mockClear();

  await service.traiterEvenementAgent('review', { type: 'turn_end' });

  expect(ecrire).toHaveBeenCalledExactlyOnceWith('review', expect.stringContaining('artefact'));
  expect(service.lire(sujet)).toMatchObject({
    phase: 'revue',
    etapeCourante: { tentative: 1, echeance, relance: true, issue: null },
  });
});

test('la revue juge la réponse finale même si la page change après son écriture', async () => {
  await allerAuDev();
  await preparerFinDev();
  await finirDev();
  expect(service.lire(sujet).phase).toBe('revue');

  const enregistrer = memoire.put.bind(memoire);
  const texteFinal = revueValide();
  let revisionEcrite: number | undefined;
  vi.spyOn(memoire, 'put').mockImplementation(async (...args) => {
    const page = await enregistrer(...args);
    if (args[0] === pageRevue) {
      revisionEcrite = page.revision;
      await enregistrer(
        pageRevue,
        'Révision concurrente fictive.',
        {
          kind: 'replace',
          expectedRevision: page.revision,
        },
        { author: 'autre-acteur-fictif' },
      );
    }
    return page;
  });
  await service.traiterEvenementAgent('review', { type: 'turn_end', texteFinal });

  expect(revisionEcrite).toBeDefined();
  expect(memoire.get(pageRevue)?.revision).toBeGreaterThan(revisionEcrite!);
  expect(service.lire(sujet).phase).toBe('livraison_prete');
});

test.each([
  '.claude/settings.local.json',
  'CLAUDE.local.md',
  '.mcp.json',
  '.codex/config.toml',
  '.npmrc',
  'node_modules/.bin/fictif',
])('le gate escalade scope et nomme le fichier hors commit %s', async (fichier) => {
  await allerAuDev();
  await preparerFinDev();
  const chemin = join(depot, fichier);
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, '# fixture inerte\n');
  await finirDev();
  expect(service.lire(sujet)).toMatchObject({
    phase: 'escalade',
    escalade: {
      raison: 'scope',
      constats: expect.arrayContaining([expect.stringContaining(fichier)]),
    },
  });
  expect(gate).not.toHaveBeenCalled();
});

test.each(['config', 'hooks/post-checkout', 'info/exclude'])(
  'le gate escalade scope et nomme la modification des métadonnées git %s',
  async (fichier) => {
    await allerAuDev();
    await preparerFinDev();
    if (fichier === 'config') {
      sh(depot, 'config', '--local', 'aid.exemple', 'fictif');
    } else {
      const chemin = join(commun, fichier);
      mkdirSync(dirname(chemin), { recursive: true });
      writeFileSync(chemin, '# fixture inerte\n');
    }
    await finirDev();
    expect(service.lire(sujet)).toMatchObject({
      phase: 'escalade',
      escalade: {
        raison: 'scope',
        constats: expect.arrayContaining([expect.stringContaining(fichier)]),
      },
    });
    expect(gate).not.toHaveBeenCalled();
  },
);

test.each(['plan', 'attente_go'])(
  'un commit pendant %s fait refuser le GO en scope',
  async (moment) => {
    await service.lancer(sujet);
    if (moment === 'attente_go') await finirPlan();
    commitFile(depot, 'note.md', 'Note arrivée avant le GO.');
    if (moment === 'plan') await finirPlan();
    // Le service peut signaler le refus par une erreur HTTP ou par son état persisté.
    const resultat = await Promise.allSettled([service.go(sujet)]);
    expect(service.lire(sujet)).toMatchObject({ phase: 'escalade', escalade: { raison: 'scope' } });
    for (const issue of resultat)
      if (issue.status === 'rejected') expect(issue.reason).toMatchObject({ status: 409 });
    expect(ecrire).not.toHaveBeenCalledWith('dev', expect.anything());
  },
);

function signalAttendu() {
  let declencher!: () => void;
  const promesse = new Promise<void>((resoudre) => {
    declencher = resoudre;
  });
  return { promesse, declencher };
}

test('arreter garde l’étape active jusqu’à la fin effective de l’agent', async () => {
  await service.lancer(sujet);
  const debutArret = signalAttendu();
  const finAgent = signalAttendu();
  arreter.mockImplementationOnce(async () => {
    debutArret.declencher();
    await finAgent.promesse;
  });
  const commande = service.arreter(sujet);
  try {
    await Promise.race([debutArret.promesse, commande]);
    expect(arreter).toHaveBeenCalledExactlyOnceWith('plan');
    expect(service.lire(sujet)).toMatchObject({
      phase: 'plan',
      etapeCourante: { type: 'plan', issue: null },
    });
  } finally {
    finAgent.declencher();
    await commande;
  }

  expect(service.lire(sujet)).toMatchObject({ phase: 'arretee', etapeCourante: null });
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

test('reprendre tue le groupe enregistré dans le worktree avec la bonne heure de départ', async () => {
  await service.lancer(sujet);
  const enfant = spawn('sleep', ['30'], { cwd: depot, stdio: 'ignore', detached: true });
  const sortie = once(enfant, 'exit');
  try {
    await once(enfant, 'spawn');
    const pid = enfant.pid;
    if (!pid || pid <= 1) throw new Error('PID fictif absent');
    const { id } = db.prepare('SELECT id FROM boucles WHERE sujet_id = ?').get(sujet) as {
      id: string;
    };
    const boucle = depotBoucle.lire(db, id)!;
    depotBoucle.enregistrer(db, {
      ...boucle,
      etat: Object.assign(boucle.etat, { groupes: [{ pid, heureDepart: heureDepart(pid) }] }),
    });
    await service.fermer();
    db.close();
    ouvrirService();

    const signaler = vi.spyOn(process, 'kill');
    await service.reprendre();
    expect(
      signaler.mock.calls.filter(([, signal]) => signal !== 0).map(([cible]) => cible),
    ).toContain(-pid);
    await expect.poll(() => enfant.signalCode, { timeout: 1_000 }).not.toBeNull();
  } finally {
    enfant.kill('SIGKILL');
    await sortie;
  }
  expect(service.lire(sujet)).toMatchObject({ phase: 'escalade' });
});

test('le service et le conducteur passent les réglages git neutralisés', async () => {
  const vraiGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(dossier, 'bin');
  const journal = join(dossier, 'git.jsonl');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(journal)}, JSON.stringify(args) + '\\n');
const resultat = spawnSync(${JSON.stringify(vraiGit)}, args, { stdio: 'inherit' });
process.exit(resultat.status ?? 1);
`,
    { mode: 0o755 },
  );
  const cheminInitial = process.env.PATH;
  const chemin = [bin, cheminInitial].join(delimiter);

  vi.stubEnv('PATH', chemin);
  await allerAuDev();
  vi.stubEnv('PATH', cheminInitial);
  await preparerFinDev();
  vi.stubEnv('PATH', chemin);
  await finirDev();
  expect(service.lire(sujet).phase).toBe('revue');

  const appels = readFileSync(journal, 'utf8')
    .trim()
    .split('\n')
    .map((ligne) => JSON.parse(ligne) as string[]);
  expect(appels.some((args) => args.includes('ls-remote'))).toBe(true);
  expect(appels.some((args) => args.includes('diff') && args.includes('--name-only'))).toBe(true);
  for (const args of appels.filter((args) => !args.includes('ls-remote'))) {
    const commande = args.join(' ');
    expect(commande).toContain('-c core.hooksPath=/dev/null');
    expect(commande).toContain('-c core.fsmonitor=false');
    expect(commande).toContain('-c credential.helper=');
    expect(commande).toMatch(/-c core\.sshCommand=\S/);
  }
});
