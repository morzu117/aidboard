import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import WebSocket from 'ws';
import { openDb } from '../src/daemon/db.js';
import { Appairages } from '../src/daemon/host/appairage.js';
import { DUREE_ACCES_MS, RegistreAppareils } from '../src/daemon/host/appareils.js';
import {
  COOKIE_APPAREIL,
  ouvrirServeurAppareils,
  type ServeurAppareils,
} from '../src/daemon/host/serveur.js';
import { BoardReader } from '../src/daemon/mesh/board.js';
import type { MeshExecResult } from '../src/daemon/mesh/exec.js';

// Chantier 31 (D175, D178, D183) : /ws/signal et le board, sur le port des appareils, en vrai
// réseau local (la poignée de main WebSocket ne passe pas par inject).

const NOM = 'mac-synthetique.exemple.ts.net';
let s: ServeurAppareils | null = null;
const ouverts: WebSocket[] = [];
afterEach(async () => {
  for (const w of ouverts.splice(0)) w.terminate();
  if (s?.disponible) await s.app.close();
  s = null;
});

async function ouvrir(extra: { now?: () => number; board?: BoardReader } = {}) {
  const h = { t: Date.parse('2026-11-07T10:00:00Z') };
  const registre = new RegistreAppareils(
    openDb(join(mkdtempSync(join(tmpdir(), 'aid-sig-')), 'state.db')),
    () => h.t,
  );
  const store = new EventEmitter();
  s = await ouvrirServeurAppareils({
    port: 0,
    interdits: [],
    nom: () => NOM,
    registre,
    appairages: new Appairages(),
    webRoot: null,
    signal: store,
    board: extra.board ?? null,
    now: extra.now,
  });
  if (!s.disponible) throw new Error(s.raison);
  const { appareil, jeton } = registre.emettre({ nom: 'Téléphone', identite: null });
  return { srv: s, registre, store, h, appareil, jeton };
}

type Issue =
  | {
      ouvert: true;
      ws: WebSocket;
      messages: string[];
      fin: Promise<{ code: number; raison: string }>;
    }
  | { ouvert: false; statut: number };

function connecter(port: number, headers: Record<string, string>): Promise<Issue> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/signal`, {
      headers: { host: NOM, ...headers },
    });
    ouverts.push(ws);
    const messages: string[] = [];
    ws.on('message', (m) => messages.push(String(m)));
    const fin = new Promise<{ code: number; raison: string }>((r) =>
      ws.on('close', (code, raison) => r({ code, raison: String(raison) })),
    );
    ws.on('open', () => resolve({ ouvert: true, ws, messages, fin }));
    ws.on('unexpected-response', (_req, res) =>
      resolve({ ouvert: false, statut: res.statusCode ?? 0 }),
    );
    ws.on('error', () => undefined);
  });
}

const valide = (jeton: string) => ({
  origin: `https://${NOM}`,
  cookie: `${COOKIE_APPAREIL}=${jeton}`,
  'sec-fetch-site': 'same-origin',
});
const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('31.7 (D175) : /ws/signal n’envoie que { kind: changed }, une fois par rafale', async () => {
  const { srv, store, jeton } = await ouvrir();
  const c = await connecter(srv.port, valide(jeton));
  if (!c.ouvert) throw new Error(String(c.statut));
  for (let i = 0; i < 5; i++) {
    store.emit('event', {
      seq: i,
      type: 'agent.status',
      data: { message: 'texte-secret-de-l-agent' },
    });
  }
  store.emit('ephemeral', { kind: 'ephemeral', type: 'pty', texte: 'texte-secret-ephemere' });
  await attendre(400);
  expect(c.messages).toEqual(['{"kind":"changed"}']);
  store.emit('event', { seq: 9 });
  await attendre(400);
  expect(c.messages).toEqual(['{"kind":"changed"}', '{"kind":"changed"}']);
  // à la fermeture, plus d'écouteur
  c.ws.close();
  await c.fin;
  await attendre(50);
  expect(store.listenerCount('event')).toBe(0);
  expect(store.listenerCount('ephemeral')).toBe(0);
});

test('31.7 (D183) : Origin absente, null ou étrangère, et cookie absent : refusés', async () => {
  const { srv, jeton } = await ouvrir();
  const { origin: _o, ...sansOrigin } = valide(jeton);
  void _o;
  for (const [nom, headers, statut] of [
    ['sans Origin', sansOrigin, 403],
    ['Origin null', { ...valide(jeton), origin: 'null' }, 403],
    ['Origin étrangère', { ...valide(jeton), origin: 'https://evil.example' }, 403],
    ['Origin en http', { ...valide(jeton), origin: `http://${NOM}` }, 403],
    ['sans cookie', { origin: `https://${NOM}`, 'sec-fetch-site': 'same-origin' }, 401],
    ['cookie inconnu', { ...valide('x'.repeat(43)) }, 401],
  ] as const) {
    const c = await connecter(srv.port, headers);
    expect(c.ouvert ? 'ouvert' : c.statut, nom).toBe(statut);
  }
});

test('31.7 (D183) : la révocation ferme la socket en 4401 « revoque »', async () => {
  const { srv, registre, appareil, jeton } = await ouvrir();
  const autre = registre.emettre({ nom: 'B', identite: null });
  const c = await connecter(srv.port, valide(jeton));
  const d = await connecter(srv.port, valide(autre.jeton));
  if (!c.ouvert || !d.ouvert) throw new Error('non ouvert');
  registre.revoquer(appareil.id);
  expect(await c.fin).toEqual({ code: 4401, raison: 'revoque' });
  // l'autre appareil reste connecté
  await attendre(50);
  expect(d.ws.readyState).toBe(WebSocket.OPEN);
  // et l'appareil révoqué ne se reconnecte pas
  const encore = await connecter(srv.port, valide(jeton));
  expect(encore.ouvert ? 'ouvert' : encore.statut).toBe(401);
});

test('31.7 (D183) : couper tous les accès ferme toutes les sockets en 4401', async () => {
  const { srv, registre, jeton } = await ouvrir();
  const autre = registre.emettre({ nom: 'B', identite: null });
  const c = await connecter(srv.port, valide(jeton));
  const d = await connecter(srv.port, valide(autre.jeton));
  if (!c.ouvert || !d.ouvert) throw new Error('non ouvert');
  registre.toutRevoquer();
  expect(await c.fin).toEqual({ code: 4401, raison: 'revoque' });
  expect(await d.fin).toEqual({ code: 4401, raison: 'revoque' });
});

test('31.7 (D183) : l’échéance des 8 h ferme la socket en 4401 « expire »', async () => {
  // l'horloge du port dit qu'il reste 150 ms à l'accès
  const debut = Date.parse('2026-11-07T10:00:00Z');
  const { srv, jeton } = await ouvrir({ now: () => debut + DUREE_ACCES_MS - 150 });
  const c = await connecter(srv.port, valide(jeton));
  if (!c.ouvert) throw new Error(String(c.statut));
  expect(await c.fin).toEqual({ code: 4401, raison: 'expire' });
});

function faux() {
  const lus: string[] = [];
  const mesh = {
    read: async (args: string[]): Promise<MeshExecResult> => {
      lus.push(args.slice(0, 3).join(' '));
      const json = args[1] === 'projects' ? [{ id: 1, name: 'P' }] : [];
      return { ok: true, timedOut: false, stdout: JSON.stringify(json), stderr: '' };
    },
  };
  return { lus, mesh };
}

test('31.7 (D178) : deux appareils, une lecture du board par 60 s ; fresh ignoré', async () => {
  const h = { t: 1_000_000 };
  const { lus, mesh } = faux();
  const board = new BoardReader({
    mesh,
    cell: 'cellule',
    log: () => undefined,
    cacheMs: 60_000,
    now: () => h.t,
  });
  const { srv, registre, jeton } = await ouvrir({ board });
  const autre = registre.emettre({ nom: 'B', identite: null });
  const lire = (j: string, url: string) =>
    srv.app.inject({
      url,
      headers: { host: NOM, cookie: `${COOKIE_APPAREIL}=${j}`, 'sec-fetch-site': 'same-origin' },
    });
  expect((await lire(jeton, '/api/board/projects')).statusCode).toBe(200);
  await lire(autre.jeton, '/api/board/projects?fresh=1');
  h.t += 59_000;
  await lire(jeton, '/api/board/projects?fresh=1');
  expect(lus).toEqual(['board projects list']);
  h.t += 1_000;
  await lire(autre.jeton, '/api/board/projects');
  expect(lus).toEqual(['board projects list', 'board projects list']);
  // la fiche : quatre commandes au plus, partagées
  await lire(jeton, '/api/board/cards/7');
  await lire(autre.jeton, '/api/board/cards/7?fresh=1');
  expect(lus.length).toBe(6);
  expect((await lire(jeton, '/api/board/cards/abc')).statusCode).toBe(400);
  expect((await lire(jeton, '/api/board/projects/0/cards')).statusCode).toBe(400);
});

test('31.7 (D178) : sans mesh, le board répond 404', async () => {
  const { srv, jeton } = await ouvrir();
  const r = await srv.app.inject({
    url: '/api/board/projects',
    headers: { host: NOM, cookie: `${COOKIE_APPAREIL}=${jeton}`, 'sec-fetch-site': 'same-origin' },
  });
  expect(r.statusCode).toBe(404);
});
