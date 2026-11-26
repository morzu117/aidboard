import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkspaceQueue } from '../../src/daemon/actions/queue.js';
import type { lancerGate as gateReel, ResultatGate } from '../../src/daemon/boucle/gate.js';
import type { RoleEtape } from '../../src/daemon/boucle/reglages.js';
import { ServiceBoucle } from '../../src/daemon/boucle/service.js';
import { creerReglage } from '../../src/daemon/confirmations/reglage.js';
import { DEFAULT_CONFIG } from '../../src/daemon/config.js';
import { openDb } from '../../src/daemon/db.js';
import { EventStore } from '../../src/daemon/events/store.js';
import { MemoryMirror } from '../../src/daemon/memory/mirror.js';
import { MemoryService } from '../../src/daemon/memory/service.js';
import { MemoryStore } from '../../src/daemon/memory/store.js';
import { resolvePaths } from '../../src/daemon/paths.js';
import { AgentManager } from '../../src/daemon/pty/manager.js';
import { createAuthState } from '../../src/daemon/security.js';
import { buildServer } from '../../src/daemon/server.js';
import { seedTopic } from '../helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from '../helpers/git.js';

const sujet = 'tp_1';
const plan = '## Point exemple\nModifier la note.';
let dossier: string;
let depot: string;
let db: ReturnType<typeof openDb>;
let memory: MemoryService;
let service: ServiceBoucle;
let heure: number;
let issueGate: ResultatGate['issue'];

const lancer = vi.fn(async ({ role, genre }: { role: RoleEtape; genre: 'claude' | 'codex' }) => ({
  sessionId: `session-fictive-${lancer.mock.calls.length}`,
  modele: 'modele-fictif',
  genre,
  role,
}));
const ecrire = vi.fn<(sessionId: string, texte: string) => Promise<void>>(async () => {});
const arreter = vi.fn<(sessionId: string) => Promise<void>>(async () => {});
const lancerGate = vi.fn(
  async ({ tete }: Parameters<typeof gateReel>[0]): Promise<ResultatGate> => {
    heure += 19;
    return {
      tete,
      issue: issueGate,
      codeSortie: issueGate === 'pass' ? 0 : 1,
      dureeMs: 19,
      journal: 'Sortie du gate fictif',
    };
  },
);

function git(...argumentsGit: string[]) {
  return execFileSync('git', argumentsGit, { cwd: depot, encoding: 'utf8' }).trim();
}

function commit(fichier: string, contenu: string) {
  writeFileSync(join(depot, fichier), contenu);
  git('add', fichier);
  git('commit', '-qm', fichier);
  return git('rev-parse', 'HEAD');
}

function ouvrirService() {
  db = openDb(join(dossier, 'state.db'));
  const mirror = new MemoryMirror(join(dossier, 'memory'));
  vi.spyOn(mirror, 'scheduleCommit').mockImplementation(() => {});
  memory = new MemoryService({
    store: new MemoryStore(db),
    mirror,
    events: new EventStore(db),
    queue: new WorkspaceQueue(),
  });
  return new ServiceBoucle({
    db,
    memory,
    agents: { lancer, ecrire, arreter },
    maintenant: () => heure,
    lancerGate,
  });
}

function page(type: 'plan' | 'dev-handoff' | 'review', texte: string) {
  return memory.put(`aid/${type}/s`, texte, { kind: 'create' }, { author: 'test' });
}

async function terminer(sessionId: string, produire: () => Promise<unknown>) {
  await produire();
  await service.traiterEvenementAgent(sessionId, { type: 'turn_end' });
}
const lireBoucle = () => service.lire(sujet);

beforeEach(() => {
  vi.clearAllMocks();
  heure = 1_000;
  issueGate = 'pass';
  dossier = mkdtempSync(join(tmpdir(), 'aid-boucle-service-'));
  const { clone } = makeOriginAndClone(dossier, { name: 'depot-fictif' });
  commitFile(
    clone,
    'agent.yml',
    `project: { namespace: aid }
phases: [plan, dev, review]
capabilities: { dev_agent: claude, review_agent: codex }
gates: { gate: "exit 0" }
boucle: { delais: { plan: 1 } }
`,
  );
  sh(clone, 'push', '-q', 'origin', 'main');
  depot = join(dossier, 'sujet-fictif');
  sh(clone, 'worktree', 'add', '-q', '-b', 'feat/s', depot, 'main');
  service = ouvrirService();
  seedTopic(db);
  db.prepare('DELETE FROM agents').run();
  db.prepare('DELETE FROM runs').run();
  db.prepare('UPDATE workspaces SET root = ?, worktrees_dir = ?').run(clone, dossier);
  db.prepare('UPDATE topics SET worktree = ? WHERE id = ?').run(depot, sujet);
});

afterEach(() => {
  db?.close();
  vi.restoreAllMocks();
  if (dossier) rmSync(dossier, { recursive: true, force: true });
});

async function allerAuDev() {
  await service.lancer(sujet);
  expect(lireBoucle()).toMatchObject({
    phase: 'plan',
    etapeCourante: { type: 'plan', issue: null, teteDepart: git('rev-parse', 'HEAD') },
  });
  heure += 30;
  await terminer('session-fictive-1', () => page('plan', plan));
  expect(lireBoucle()).toMatchObject({ phase: 'attente_go', plan });
  await service.go(sujet);
  expect(lireBoucle()).toMatchObject({ phase: 'dev', etapeCourante: { type: 'dev' } });
}

test('enchaîne plan, GO, dev, gate et revue jusqu’à livraison prête sur la tête du dev', async () => {
  await allerAuDev();
  heure += 80;
  await terminer('session-fictive-2', () => {
    commit('note.md', 'Une note.');
    return page('dev-handoff', 'Note ajoutée.');
  });
  const tete = git('rev-parse', 'HEAD');
  expect(lancerGate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ depot, tete, commande: 'exit 0' }),
  );
  expect(lireBoucle()).toMatchObject({ phase: 'revue' });
  heure += 40;
  await terminer('session-fictive-3', () =>
    page(
      'review',
      '```json\n' +
        JSON.stringify({
          tete,
          verdicts: { fichiers: { 'note.md': 'pass' }, points: {} },
          findings: [],
        }) +
        '\n```',
    ),
  );

  expect(lancer.mock.calls.map(([appel]) => [appel.role, appel.genre])).toEqual([
    ['plan', 'claude'],
    ['dev', 'claude'],
    ['review', 'codex'],
  ]);
  expect(ecrire).toHaveBeenCalledWith('session-fictive-2', expect.stringContaining(plan));
  expect(lireBoucle()).toMatchObject({
    phase: 'livraison_prete',
    etapeCourante: null,
    historique: [
      { type: 'plan', issue: 'pass' },
      { type: 'dev', issue: 'pass', teteArrivee: tete },
      { type: 'gate', issue: 'pass', teteArrivee: tete },
      { type: 'revue', issue: 'pass', teteArrivee: tete },
      { type: 'triage', issue: 'pass', route: 'livraison' },
    ],
    mesures: { interventionsHumaines: 1, redevs: 0 },
  });
});

test('le daemon reprend la tentative persistée avec une session perdue et sans nouveau lancement', async () => {
  await service.lancer(sujet);
  const avant = lireBoucle();
  db.close();
  heure += 25;
  service = ouvrirService();
  await service.reprendre();
  await service.reprendre();
  expect(lancer).toHaveBeenCalledTimes(1);
  expect(avant).toMatchObject({ phase: 'plan' });
  expect(lireBoucle()).toMatchObject({
    phase: 'escalade',
    etapeCourante: null,
    historique: [{ type: 'plan', tentative: 1, issue: 'cannot_evaluate' }],
  });
});

test('le tic du daemon arrête la session au délai, sans événement d’agent', async () => {
  await service.lancer(sujet);
  heure += 59_999;
  await service.tic();
  expect(lireBoucle()).toMatchObject({ phase: 'plan' });
  expect(arreter).not.toHaveBeenCalled();
  heure += 2;
  await service.tic();
  expect(arreter).toHaveBeenCalledExactlyOnceWith('session-fictive-1');
  expect(lireBoucle()).toMatchObject({
    phase: 'escalade',
    historique: [{ type: 'plan', issue: 'delai_depasse' }],
  });
});

test('cumule les durées closes, une relance de dev et les trois interventions humaines', async () => {
  await allerAuDev();
  await service.traiterEvenementAgent('session-fictive-2', {
    type: 'needs_input',
    question: 'Quel format ?',
  });
  expect(lireBoucle()).toMatchObject({
    phase: 'escalade',
    escalade: { question: 'Quel format ?' },
  });
  await service.repondre(sujet, 'Texte');
  expect(ecrire).toHaveBeenLastCalledWith('session-fictive-2', 'Texte');
  expect(lancer).toHaveBeenCalledTimes(2);
  expect(lireBoucle()).toMatchObject({ phase: 'dev', escalade: null });
  issueGate = 'fail';
  heure += 80;
  await terminer('session-fictive-2', () => {
    commit('note.md', 'Une note.');
    return page('dev-handoff', 'Note ajoutée.');
  });
  expect(lireBoucle()).toMatchObject({ phase: 'dev', etapeCourante: { tentative: 2 } });

  heure += 45;
  await service.arreter(sujet);
  expect(arreter).toHaveBeenLastCalledWith('session-fictive-3');
  expect(lireBoucle()).toMatchObject({
    phase: 'arretee',
    etapeCourante: null,
    historique: [
      { type: 'plan', issue: 'pass' },
      { type: 'dev', issue: 'pass' },
      { type: 'gate', issue: 'fail' },
      { type: 'dev', issue: 'skipped' },
    ],
    mesures: {
      tempsParEtapeMs: { plan: 30, dev: 125, gate: 19 },
      interventionsHumaines: 3,
      redevs: 1,
    },
  });
});

test('la porte refuse les quatre POST valides, puis les doublons de lancement et de GO restent refusés', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.structural.engine = 'off';
  const auth = createAuthState();
  const paths = resolvePaths(dossier);
  const store = new EventStore(db);
  const agents = new AgentManager({ db, store, config, auth, paths, port: () => 0 });
  vi.spyOn(agents, 'spawn').mockImplementation(() => {
    throw new Error('Le test utilise le lanceur injecté');
  });
  const injection = { boucle: service };
  const app = await buildServer({
    config,
    auth,
    db,
    store,
    agents,
    paths,
    memory,
    webRoot: null,
    ...injection,
  });
  try {
    const poster = (suffixe: string, payload = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/topics/${sujet}/boucle${suffixe}`,
        headers: { host: `127.0.0.1:${config.port}`, authorization: `Bearer ${auth.adminToken}` },
        payload,
      });
    async function refuserSansConfirmation(suffixe: string, payload = {}) {
      const reglage = creerReglage(db);
      reglage.armer();
      const avant = structuredClone(lireBoucle());
      const resultat = await poster(suffixe, payload);
      expect(resultat.statusCode).toBe(409);
      expect(resultat.json()).toMatchObject({ error: 'confirmation_impossible' });
      expect(lireBoucle()).toEqual(avant);
      reglage.desarmerConfirme();
    }

    await refuserSansConfirmation('');
    const debut = await poster('');
    expect(debut.statusCode).toBeGreaterThanOrEqual(200);
    expect(debut.statusCode).toBeLessThan(300);
    expect(lireBoucle()).toMatchObject({ phase: 'plan' });
    expect((await poster('')).statusCode).toBe(409);
    await terminer('session-fictive-1', () => page('plan', plan));
    await refuserSansConfirmation('/go');
    const go = await poster('/go');
    expect(go.statusCode).toBeGreaterThanOrEqual(200);
    expect(go.statusCode).toBeLessThan(300);
    expect((await poster('/go')).statusCode).toBe(409);
    expect(lancer).toHaveBeenCalledTimes(2);
    expect(lireBoucle()).toMatchObject({ mesures: { interventionsHumaines: 1 } });
    await refuserSansConfirmation('/arreter');
    expect(arreter.mock.calls).not.toContainEqual(['session-fictive-2']);
    await service.traiterEvenementAgent('session-fictive-2', {
      type: 'needs_input',
      question: 'Quel format ?',
    });
    await refuserSansConfirmation('/reponse', { reponse: 'Texte' });
    expect(ecrire.mock.calls).not.toContainEqual(['session-fictive-2', 'Texte']);
  } finally {
    await app.close();
  }
});
