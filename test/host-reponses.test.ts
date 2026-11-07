import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { Appairages } from '../src/daemon/host/appairage.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL, ouvrirServeurAppareils } from '../src/daemon/host/serveur.js';
import { AgentManager } from '../src/daemon/pty/manager.js';
import { registerAgentRoutes } from '../src/daemon/routes/agents.js';
import { buildSnapshot } from '../src/daemon/state/snapshot.js';
import { mapHook } from '../src/cli/commands/hook.js';
import { ASK_TEXT_ANSWER } from '../src/shared/question.js';
import { seedTopic } from './helpers/daemon.js';

const nettoyages: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const nettoyer of nettoyages.reverse()) await nettoyer();
  nettoyages.length = 0;
});
const demande = {
  id: 'question-1',
  kind: 'question',
  modeVivant: 'default',
  modeVivantA: '2026-11-07T00:00:00Z',
  question: 'Texte privé de la question',
  options: [{ label: 'Premier', answer: '1' }, { label: 'Second', answer: '2' }, ASK_TEXT_ANSWER],
};
const corps = { pendingId: demande.id, option: 1 };

async function preparer() {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-reponses-'));
  const db = openDb(join(dossier, 'state.db'));
  nettoyages.push(() => {
    db.close();
    rmSync(dossier, { recursive: true, force: true });
  });
  seedTopic(db);
  db.prepare(
    "UPDATE agents SET kind = 'claude', transport = 'pty', permission_mode = 'default', pending = ?, status = 'needs_input' WHERE id = 'ag_1'",
  ).run(JSON.stringify(demande));
  const store = new EventStore(db);
  const pilote = vi.fn();
  // Seul le transport est faux : answer, pendingOf, answerStream et le projecteur sont réels.
  const agents = Object.assign(Object.create(AgentManager.prototype) as AgentManager, {
    deps: { db, store },
    streams: new Map([
      ['ag_1', { id: 'ag_1', runId: 'run_1', queued: [], driver: { answer: pilote } }],
    ]),
  });
  const moteur = { status: async () => ({ state: 'unavailable' }) } as unknown as Parameters<
    typeof buildSnapshot
  >[1];
  const registre = new RegistreAppareils(db);
  const s = await ouvrirServeurAppareils({
    port: 0,
    interdits: [],
    nom: () => 'aid-e2e.ts.net',
    registre,
    appairages: new Appairages(),
    webRoot: null,
    reponses: { db, store, agents },
    etat: () => buildSnapshot(db, moteur),
  });
  if (!s.disponible) throw new Error(s.raison);
  nettoyages.push(() => s.app.close());
  const { appareil, jeton } = registre.emettre({ nom: 'Téléphone test', identite: null });
  const headers = {
    host: 'aid-e2e.ts.net',
    origin: 'https://aid-e2e.ts.net',
    'sec-fetch-site': 'same-origin',
    cookie: `${COOKIE_APPAREIL}=${jeton}`,
  };
  const envoyer = (
    payload: unknown = corps,
    id = 'ag_1',
    entetes: Record<string, string> = headers,
  ) =>
    s.app.inject({
      method: 'POST',
      url: `/api/appareils/agents/${id}/reponse`,
      headers: entetes,
      payload: payload as never,
    });
  const mac = Fastify();
  registerAgentRoutes(mac, { db, store, agents });
  nettoyages.push(() => mac.close());
  const repondreMac = () =>
    mac.inject({
      method: 'POST',
      url: '/api/agents/ag_1/answer',
      payload: { pendingId: demande.id, answer: '1' },
    });
  return { app: s.app, db, store, pilote, registre, appareil, envoyer, headers, repondreMac };
}

test.each(['default', 'plan'])(
  'question en mode %s : answer vient des options serveur',
  async (mode) => {
    const p = await preparer();
    p.db
      .prepare('UPDATE agents SET permission_mode = ?, pending = ?')
      .run(mode, JSON.stringify({ ...demande, modeVivant: mode }));
    expect((await p.envoyer()).statusCode).toBe(200);
    expect(p.pilote).toHaveBeenCalledExactlyOnceWith(demande.id, '2');
    expect(p.db.prepare('SELECT pending FROM agents').get()).toEqual({ pending: null });
  },
);

test('agent local inconnu : 404 avant le mode', async () => {
  const p = await preparer();
  expect((await p.envoyer(corps, 'inconnu')).statusCode).toBe(404);
  expect(p.pilote).not.toHaveBeenCalled();
});

test.each(['acceptEdits', 'auto', null, 'inconnu'])('mode refusé : %s', async (mode) => {
  const p = await preparer();
  p.db.prepare('UPDATE agents SET permission_mode = ?, pending = NULL').run(mode);
  const r = await p.envoyer();
  expect(r.statusCode).toBe(403);
  expect(r.json()).toEqual({ raison: 'mode' });
  expect(p.pilote).not.toHaveBeenCalled();
});

test.each(['permission', null])('nature refusée : %s', async (kind) => {
  const p = await preparer();
  p.db
    .prepare('UPDATE agents SET pending = ?')
    .run(kind ? JSON.stringify({ ...demande, kind }) : null);
  const r = await p.envoyer({ ...corps, pendingId: 'ancien' });
  expect(r.statusCode).toBe(403);
  expect(r.json()).toEqual({ raison: 'nature' });
  const refus = p.store.since(null).filter((e) => e.type === 'appareil.refus');
  expect(refus).toHaveLength(1);
  expect(refus[0]!.agentId).toBe('ag_1');
  expect(refus[0]!.data).toEqual({
    appareilId: p.appareil.id,
    nom: 'Téléphone test',
    route: '/api/appareils/agents/:id/reponse',
    raison: 'nature',
  });
  expect(p.pilote).not.toHaveBeenCalled();
});

test('demande périmée avant validation de l’option', async () => {
  const p = await preparer();
  const r = await p.envoyer({ pendingId: 'ancien', option: 99 });
  expect(r.statusCode).toBe(409);
  expect(r.json()).toEqual({ raison: 'perimee' });
  expect(p.pilote).not.toHaveBeenCalled();
});

test.each([99, 2])('option refusée : %s (bornes ou texte)', async (option) => {
  const p = await preparer();
  const r = await p.envoyer({ ...corps, option });
  expect(r.statusCode).toBe(400);
  expect(r.json()).toEqual({ raison: 'option' });
  expect(p.pilote).not.toHaveBeenCalled();
});

test.each([
  { ...corps, autre: true },
  { ...corps, answer: '1' },
  { pendingId: demande.id, answer: '1' },
  { ...corps, option: -1 },
  { ...corps, option: 0.5 },
  { ...corps, option: '1' },
  { ...corps, pendingId: null },
])('schéma fermé : %j', async (payload) => {
  const p = await preparer();
  expect((await p.envoyer(payload)).statusCode).toBe(400);
  expect(p.pilote).not.toHaveBeenCalled();
});

test('deux appareils simultanés : une réponse, un deja_tranchee', async () => {
  const p = await preparer();
  const resultats = await Promise.all([p.envoyer(), p.envoyer()]);
  expect(resultats.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(resultats.find((r) => r.statusCode === 409)!.json()).toEqual({ raison: 'deja_tranchee' });
  expect(p.pilote).toHaveBeenCalledTimes(1);
  expect(p.store.since(null).filter((e) => e.type === 'appareil.ecriture')).toHaveLength(1);
});

test('Mac puis appareil : demande déjà tranchée', async () => {
  const p = await preparer();
  expect((await p.repondreMac()).statusCode).toBe(202);
  const r = await p.envoyer();
  expect(r.statusCode).toBe(409);
  expect(r.json()).toEqual({ raison: 'deja_tranchee' });
  expect(p.pilote).toHaveBeenCalledExactlyOnceWith(demande.id, '1');
});

test('Mac et appareil simultanés : un seul gagne', async () => {
  const p = await preparer();
  const resultats = await Promise.all([p.envoyer(), p.repondreMac()]);
  expect(resultats.filter((r) => r.statusCode < 300)).toHaveLength(1);
  expect(resultats.find((r) => r.statusCode === 409)!.json()).toEqual({ raison: 'deja_tranchee' });
  expect(p.pilote).toHaveBeenCalledTimes(1);
});

test('appareil révoqué : 401', async () => {
  const p = await preparer();
  p.registre.revoquer(p.appareil.id);
  expect((await p.envoyer()).statusCode).toBe(401);
  expect(p.pilote).not.toHaveBeenCalled();
});

test('sans Origin : 403', async () => {
  const p = await preparer();
  const headers: Record<string, string> = { ...p.headers };
  delete headers.origin;
  expect((await p.envoyer(corps, 'ag_1', headers)).statusCode).toBe(403);
  expect(p.pilote).not.toHaveBeenCalled();
});

test('journal D191 : uniquement appareil, nom et route avec agentId', async () => {
  const p = await preparer();
  await p.envoyer();
  const evenements = p.store.since(null).filter((e) => e.type === 'appareil.ecriture');
  expect(evenements).toHaveLength(1);
  expect(evenements[0]).toMatchObject({
    agentId: 'ag_1',
    data: {
      appareilId: p.appareil.id,
      nom: 'Téléphone test',
      route: '/api/appareils/agents/:id/reponse',
    },
  });
  expect(Object.keys(evenements[0]!.data).sort()).toEqual(['appareilId', 'nom', 'route']);
});

test('pilote réentrant : consommation avant l’envoi et question suivante conservée', async () => {
  const p = await preparer();
  p.pilote.mockImplementation(() => {
    expect(p.db.prepare('SELECT pending FROM agents').get()).toEqual({ pending: null });
    p.store.append({
      source: 'hook:claude',
      type: 'agent.status',
      agentId: 'ag_1',
      data: {
        status: 'needs_input',
        permission_mode: 'default',
        reason: 'question',
        pending: { ...demande, id: 'question-2' },
      },
    });
  });
  expect((await p.envoyer()).statusCode).toBe(200);
  expect(
    JSON.parse((p.db.prepare('SELECT pending FROM agents').get() as { pending: string }).pending)
      .id,
  ).toBe('question-2');
  const r = await p.envoyer();
  expect(r.statusCode).toBe(409);
  expect(r.json()).toEqual({ raison: 'perimee' });
  expect(p.pilote).toHaveBeenCalledTimes(1);
});

test.each(['acceptEdits', 'auto', 'inconnu', undefined, 'default', 'plan'])(
  'mode vivant du hook %s, mode enregistré default',
  async (mode) => {
    const p = await preparer();
    p.db.prepare("UPDATE agents SET transport = 'pty'").run();
    const e = p.store.append({
      source: 'hook:claude',
      type: 'agent.status',
      agentId: 'ag_1',
      data: { status: 'needs_input', reason: 'question', permission_mode: mode, pending: demande },
    });
    const pending = JSON.parse(
      (p.db.prepare('SELECT pending FROM agents').get() as { pending: string }).pending,
    );
    if (mode !== undefined) expect(pending).toMatchObject({ modeVivant: mode, modeVivantA: e.ts });
    const r = await p.envoyer();
    expect(r.statusCode).toBe(['default', 'plan'].includes(mode ?? '') ? 200 : 403);
    if (r.statusCode === 403) expect(r.json()).toEqual({ raison: 'mode' });
  },
);

test('stream : plan refusé et refus journalisé sans texte', async () => {
  const p = await preparer();
  p.db.prepare("UPDATE agents SET transport = 'stream', permission_mode = 'plan'").run();
  expect((await p.envoyer()).json()).toEqual({ raison: 'mode' });
  const e = p.db
    .prepare("SELECT agent_id, data FROM events WHERE type = 'appareil.refus'")
    .get() as { agent_id: string; data: string };
  expect(e.agent_id).toBe('ag_1');
  expect(JSON.parse(e.data)).toEqual({
    appareilId: p.appareil.id,
    nom: 'Téléphone test',
    route: '/api/appareils/agents/:id/reponse',
    raison: 'mode',
  });
});

test('GET /api/state authentifié masque le chemin et le jeton de la question', async () => {
  const p = await preparer();
  p.db
    .prepare('UPDATE agents SET pending = ?')
    .run(JSON.stringify({ ...demande, question: 'Voir /home/exemple/projet et sk_live_abcdefgh' }));
  const r = await p.app.inject({ url: '/api/state', headers: p.headers });
  expect(r.statusCode).toBe(200);
  expect(r.json().agents[0].question).toEqual({
    pendingId: demande.id,
    texte: 'Voir [masqué] et [masqué]',
    options: ['Premier', 'Second'],
    coupee: false,
  });
});

test.each(['acceptEdits', 'auto', 'inconnu', null])(
  'mode vivant refusé malgré default enregistré : %s',
  async (modeVivant) => {
    const p = await preparer();
    p.db
      .prepare("UPDATE agents SET transport = 'pty', pending = ?")
      .run(JSON.stringify({ ...demande, modeVivant }));
    const r = await p.envoyer();
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ raison: 'mode' });
    expect(p.pilote).not.toHaveBeenCalled();
  },
);

test.each(['default', 'plan'])('stream sans mode vivant : repli %s', async (mode) => {
  const p = await preparer();
  const pending = {
    id: demande.id,
    kind: demande.kind,
    question: demande.question,
    options: demande.options,
  };
  p.db
    .prepare("UPDATE agents SET transport = 'stream', permission_mode = ?, pending = ?")
    .run(mode, JSON.stringify(pending));
  const r = await p.envoyer();
  expect(r.statusCode).toBe(mode === 'default' ? 200 : 403);
  if (mode === 'plan') expect(r.json()).toEqual({ raison: 'mode' });
});

test('sans mode vivant en pty : refus journalisé sans texte', async () => {
  const p = await preparer();
  const pending = {
    id: demande.id,
    kind: demande.kind,
    question: demande.question,
    options: demande.options,
  };
  p.db.prepare("UPDATE agents SET transport = 'pty', pending = ?").run(JSON.stringify(pending));
  expect((await p.envoyer()).json()).toEqual({ raison: 'mode' });
  const refus = p.store.since(null).filter((e) => e.type === 'appareil.refus');
  expect(refus).toHaveLength(1);
  expect(refus[0]).toMatchObject({
    agentId: 'ag_1',
    data: {
      appareilId: p.appareil.id,
      nom: 'Téléphone test',
      route: '/api/appareils/agents/:id/reponse',
      raison: 'mode',
    },
  });
  expect(Object.keys(refus[0]!.data).sort()).toEqual(['appareilId', 'nom', 'raison', 'route']);
});

test('hook vivant projeté puis GET /api/state authentifié : question masquée et coupe visible', async () => {
  const p = await preparer();
  const [evenement] = mapHook('PreToolUse', {
    permission_mode: 'default',
    tool_use_id: 'vivante',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question: 'Lire /tmp/exemple sk_test_abcdefgh puis ' + 'mot '.repeat(50),
          options: [{ label: 'Oui' }],
        },
      ],
    },
  });
  p.store.append({ source: 'hook:claude', agentId: 'ag_1', runId: 'run_1', ...evenement! });
  const pending = JSON.parse(
    (p.db.prepare('SELECT pending FROM agents').get() as { pending: string }).pending,
  );
  expect(pending.modeVivant).toBe('default');
  expect(pending.modeVivantA).toEqual(expect.any(String));
  const r = await p.app.inject({ method: 'GET', url: '/api/state', headers: p.headers });
  expect(r.statusCode).toBe(200);
  const question = r.json().agents[0].question;
  expect(question.coupee).toBe(true);
  expect(question.texte).toContain('[masqué]');
  expect(question.texte).not.toContain('/tmp/exemple');
  expect(question.texte).not.toContain('sk_test_abcdefgh');
  expect(question).not.toHaveProperty('modeVivant');
});

test('GET /api/state : une option coupée suffit à signaler la coupe', async () => {
  const p = await preparer();
  p.db
    .prepare('UPDATE agents SET pending = ?')
    .run(JSON.stringify({ ...demande, options: [{ label: 'mot '.repeat(50), answer: '1' }] }));
  const r = await p.app.inject({ url: '/api/state', headers: p.headers });
  expect(r.statusCode).toBe(200);
  expect(r.json().agents[0].question.coupee).toBe(true);
  expect(r.json().agents[0].question.options[0].length).toBeLessThanOrEqual(140);
});
