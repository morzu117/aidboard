import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, test } from 'vitest';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { Appairages } from '../src/daemon/host/appairage.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL, ouvrirServeurAppareils } from '../src/daemon/host/serveur.js';
import { etatPourAppareil } from '../src/daemon/host/masque.js';
import { registerAgentRoutes } from '../src/daemon/routes/agents.js';
import type { AgentManager } from '../src/daemon/pty/manager.js';
import { buildSnapshot } from '../src/daemon/state/snapshot.js';
import type { StructuralService } from '../src/daemon/structural/service.js';
import { seedTopic } from './helpers/daemon.js';

const nettoyages: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const nettoyer of nettoyages.reverse()) await nettoyer();
  nettoyages.length = 0;
});
function preparer() {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-tours-'));
  const db = openDb(join(dossier, 'state.db'));
  nettoyages.push(() => {
    db.close();
    rmSync(dossier, { recursive: true, force: true });
  });
  seedTopic(db);
  db.prepare(
    "UPDATE agents SET kind = 'claude', status = 'idle', status_at = 'tour-1' WHERE id = 'ag_1'",
  ).run();
  const store = new EventStore(db);
  const registre = new RegistreAppareils(db);
  const etat = () =>
    buildSnapshot(db, {
      status: async () => ({ state: 'unavailable' }),
    } as unknown as StructuralService);
  return { db, store, registre, etat };
}
const corps = { tourId: 'tour-1', etat: 'relu' };

test('projecteur : upsert, dernière marque gagnante et date de l’événement', () => {
  const { db, store } = preparer();
  for (const [etat, par, ts] of [
    ['relu', 'mac', 't1'],
    ['a_reprendre', 'appareil-1', 't2'],
  ]) {
    store.append({
      source: 'daemon',
      type: 'tour.marque',
      agentId: 'ag_1',
      ts,
      data: { tourId: 'tour-1', etat, par },
    });
  }
  expect(db.prepare('SELECT * FROM tours_marques').all()).toEqual([
    { agent_id: 'ag_1', tour_id: 'tour-1', etat: 'a_reprendre', par: 'appareil-1', a: 't2' },
  ]);
});

test('route Mac : 200, 404, 409 périmé ou sans tour et 400', async () => {
  const { db, store } = preparer();
  const app = Fastify();
  nettoyages.push(() => app.close());
  registerAgentRoutes(app, { db, store, agents: {} as AgentManager });
  const envoyer = (payload: unknown = corps, id = 'ag_1') =>
    app.inject({ method: 'PUT', url: `/api/agents/${id}/tour`, payload: payload as never });
  const r = await envoyer();
  expect(r.statusCode).toBe(200);
  expect(r.json().marque).toMatchObject({ ...corps, par: 'mac', parNom: 'Mac' });
  expect((await envoyer(corps, 'inconnu')).statusCode).toBe(404);
  const perime = await envoyer({ ...corps, tourId: 'ancien' });
  expect(perime.statusCode).toBe(409);
  expect(perime.json()).toEqual({ raison: 'perimee' });
  for (const payload of [{}, { ...corps, etat: 'autre' }, { ...corps, tourId: '' }])
    expect((await envoyer(payload)).statusCode).toBe(400);
  db.prepare("UPDATE agents SET status = 'working'").run();
  expect((await envoyer()).statusCode).toBe(409);
  expect(store.since(null).filter((e) => e.type === 'appareil.ecriture')).toHaveLength(0);
});

test('route appareil : gardes, journal avec nom, tour périmé et révocation', async () => {
  const p = preparer();
  const s = await ouvrirServeurAppareils({
    port: 0,
    interdits: [],
    nom: () => 'aid-e2e.ts.net',
    registre: p.registre,
    appairages: new Appairages(),
    webRoot: null,
    tours: p,
    etat: p.etat,
  });
  if (!s.disponible) throw new Error(s.raison);
  nettoyages.push(() => s.app.close());
  const { appareil, jeton } = p.registre.emettre({ nom: 'Téléphone test', identite: null });
  const headers = {
    host: 'aid-e2e.ts.net',
    origin: 'https://aid-e2e.ts.net',
    'sec-fetch-site': 'same-origin',
    cookie: `${COOKIE_APPAREIL}=${jeton}`,
  };
  const envoyer = (payload = corps, h: Record<string, string> = headers, id = 'ag_1') =>
    s.app.inject({ method: 'POST', url: `/api/appareils/agents/${id}/tour`, headers: h, payload });
  expect((await envoyer(corps, { ...headers, cookie: '' })).statusCode).toBe(401);
  const sansOrigine: Record<string, string> = { ...headers };
  delete sansOrigine.origin;
  expect((await envoyer(corps, sansOrigine)).statusCode).toBe(403);
  expect((await envoyer(corps, { ...headers, 'sec-fetch-site': 'cross-site' })).statusCode).toBe(
    403,
  );
  expect(p.store.since(null)).toHaveLength(0);
  const r = await envoyer();
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ marque: 'relu' });
  expect((await p.etat()).agents[0]!.marqueTour).toMatchObject({
    par: appareil.id,
    parNom: appareil.nom,
  });
  expect(p.store.since(null).find((e) => e.type === 'appareil.ecriture')).toMatchObject({
    agentId: 'ag_1',
    data: { appareilId: appareil.id, nom: appareil.nom, route: '/api/appareils/agents/:id/tour' },
  });
  const perime = await envoyer({ ...corps, tourId: 'ancien' });
  expect(perime.statusCode).toBe(409);
  expect(perime.json()).toEqual({ raison: 'perimee' });
  expect((await envoyer(corps, headers, 'inconnu')).statusCode).toBe(404);
  expect((await envoyer({ ...corps, etat: 'autre' })).statusCode).toBe(400);
  expect(p.store.since(null).filter((e) => e.type === 'appareil.ecriture')).toHaveLength(1);
  p.registre.revoquer(appareil.id);
  expect((await envoyer()).statusCode).toBe(401);
});

test('snapshot et masque : marque minimale, effacée au nouveau statusAt', async () => {
  const { store, etat } = preparer();
  store.append({
    source: 'daemon',
    type: 'tour.marque',
    agentId: 'ag_1',
    data: { ...corps, par: 'mac' },
  });
  const s = await etat();
  expect(s.agents[0]!.marqueTour).toMatchObject({ ...corps, par: 'mac', parNom: 'Mac' });
  const tour = etatPourAppareil(s).agents[0]!.tour!;
  expect(Object.keys(tour).sort()).toEqual(['id', 'marque', 'resume']);
  expect(tour.marque).toBe('relu');
  store.append({
    source: 'daemon',
    type: 'agent.status',
    agentId: 'ag_1',
    ts: 'tour-2',
    data: { status: 'idle' },
  });
  const nouveau = await etat();
  expect(nouveau.agents[0]!.marqueTour).toBeNull();
  expect(etatPourAppareil(nouveau).agents[0]!.tour).toEqual({
    id: 'tour-2',
    resume: null,
    marque: null,
  });
});
