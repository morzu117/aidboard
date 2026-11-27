import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkspaceQueue } from '../../src/daemon/actions/queue.js';
import { ServiceBoucle, TAILLE_MAX_REPONSE_BOUCLE } from '../../src/daemon/boucle/service.js';
import { openDb } from '../../src/daemon/db.js';
import { EventStore } from '../../src/daemon/events/store.js';
import { MemoryMirror } from '../../src/daemon/memory/mirror.js';
import { MemoryService } from '../../src/daemon/memory/service.js';
import { MemoryStore } from '../../src/daemon/memory/store.js';
import { seedTopic } from '../helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from '../helpers/git.js';
import { poserOrigineBoucle, poserTemoinGitBoucle } from './temoin-git.js';

const sujet = 'tp_1';
const plan = 'Ajouter une note.';
let dossier: string;
let depot: string;
let home: string;
let db: ReturnType<typeof openDb>;
let memory: MemoryService;
let boucle: ServiceBoucle;
const ecrire = vi.fn<(sessionId: string, texte: string) => Promise<void>>(async () => {});

beforeEach(() => {
  ecrire.mockClear();
  dossier = mkdtempSync(join(tmpdir(), 'aid-boucle-pages-'));
  home = join(dossier, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(dossier, 'aid-home'));
  ({ clone: depot } = makeOriginAndClone(dossier));
  commitFile(
    depot,
    'agent.yml',
    'project: { namespace: aid }\nphases: [plan, dev, review]\ngates: { gate: "exit 0" }\n',
  );
  sh(depot, 'push', '-q', 'origin', 'main');
  poserOrigineBoucle(depot);
  vi.stubEnv('PATH', poserTemoinGitBoucle(dossier, depot).chemin);
  db = openDb(join(dossier, 'state.db'));
  seedTopic(db);
  db.prepare('DELETE FROM agents').run();
  db.prepare('UPDATE topics SET worktree = ? WHERE id = ?').run(depot, sujet);
  const mirror = new MemoryMirror(join(dossier, 'memory'));
  vi.spyOn(mirror, 'scheduleCommit').mockImplementation(() => {});
  memory = new MemoryService({
    store: new MemoryStore(db),
    mirror,
    events: new EventStore(db),
    queue: new WorkspaceQueue(),
  });
  boucle = new ServiceBoucle({
    db,
    memory,
    agents: {
      lancer: async ({ genre, role }) => ({ genre, modele: 'fictif', sessionId: role }),
      ecrire,
      arreter: async () => {},
    },
    lancerGate: async ({ tete }) => ({
      tete,
      issue: 'pass',
      codeSortie: 0,
      dureeMs: 1,
      journal: '',
    }),
  });
});

afterEach(async () => {
  await boucle?.fermer();
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (dossier) rmSync(dossier, { recursive: true, force: true });
});

const finirPlan = () =>
  boucle.traiterEvenementAgent('plan', { type: 'turn_end', texteFinal: plan });

test('le daemon enregistre la réponse finale du plan avant l’attente du GO', async () => {
  await boucle.lancer(sujet);
  await finirPlan();
  expect(memory.get('aid/plan/s')).toMatchObject({ author: 'plan', body: plan });
  expect(boucle.lire(sujet)).toMatchObject({ phase: 'attente_go', plan });
});

test('le daemon enregistre et valide le bloc JSON de la revue', async () => {
  await boucle.lancer(sujet);
  await finirPlan();
  await boucle.go(sujet);
  commitFile(depot, 'note.md', 'Note.');
  await memory.put('aid/dev-handoff/s', 'Note ajoutée.', { kind: 'create' }, { author: 'dev' });
  await boucle.traiterEvenementAgent('dev', { type: 'turn_end' });
  expect(boucle.lire(sujet).phase).toBe('revue');
  const tete = sh(depot, 'rev-parse', 'HEAD');
  const texteFinal = [
    '```json',
    JSON.stringify({
      tete,
      verdicts: { fichiers: { 'note.md': 'pass' }, points: {} },
      findings: [],
    }),
    '```',
  ].join('\n');
  await boucle.traiterEvenementAgent('review', { type: 'turn_end', texteFinal });
  expect(memory.get('aid/review/s')).toMatchObject({ author: 'review', body: texteFinal });
  expect(boucle.lire(sujet).phase).toBe('livraison_prete');
});

test('une réponse au-delà de 256 Kio relance la même session sans créer de page', async () => {
  await boucle.lancer(sujet);
  await boucle.traiterEvenementAgent('plan', {
    type: 'turn_end',
    texteFinal: 'é'.repeat(TAILLE_MAX_REPONSE_BOUCLE / 2 + 1),
  });
  expect(memory.get('aid/plan/s')).toBeUndefined();
  expect(boucle.lire(sujet)).toMatchObject({
    phase: 'plan',
    etapeCourante: { tentative: 1, relance: true },
  });
  expect(ecrire).toHaveBeenLastCalledWith(
    'plan',
    expect.stringContaining('artefact attendu manque'),
  );
});

test('la projection d’une escalade d’empreinte rend le chemin du home relatif', async () => {
  await boucle.lancer(sujet);
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), '{"exemple":"contenu-fictif-non-public"}');
  await finirPlan();
  const projection = boucle.lire(sujet);
  expect(projection).toMatchObject({
    phase: 'escalade',
    escalade: { raison: 'scope', constats: ['~/.claude/settings.json'] },
  });
  expect(JSON.stringify(projection)).not.toContain(home);
  expect(JSON.stringify(projection)).not.toContain('contenu-fictif-non-public');
});
