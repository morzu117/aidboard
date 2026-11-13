import { afterEach, expect, test } from 'vitest';
import WebSocket from 'ws';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import type { TailscaleExec } from '../src/daemon/mesh/tailscale.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

// Chantier 31 (D174, lab M1) : la liste fermée du port des appareils. Toutes les routes du port
// du Mac, relevées par onRoute, appelées sur le port des appareils avec un cookie valide, rendent
// 404, sauf celles de la liste. Une route ajoutée au Mac sans décision fait échouer ce test.

const NOM = 'mac-synthetique.exemple.ts.net';
let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.d.stop();
  t = null;
});

const tailnet: TailscaleExec = async (_bin, args) =>
  args[0] === 'status'
    ? {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: `${NOM}.`, UserID: 1 },
          User: {},
        }),
        code: null,
      }
    : { stdout: '', code: null };

/** D174 : exactement ce que le port des appareils déclare */
const LISTE = [
  'GET /pda-cle.js',
  'POST /api/appareils/moi/pda',
  'GET /api/appareils/push/cle',
  'POST /api/appareils/moi/push',
  'DELETE /api/appareils/moi/push',
  'GET /api/appareils/sujets/:id/livraison',
  'GET /api/appareils/sujets/:id/fichiers/:index/diff',
  'POST /api/appareils/agents/:id/tour',
  'POST /api/appareils/agents/:id/reponse',
  'GET /api/appareils/moi',
  'GET /api/appareils',
  'DELETE /api/appareils/:id',
  'POST /api/appareils/moi/deconnexion',
  'GET /api/state',
  'GET /ws/signal',
  'GET /api/board/projects',
  'GET /api/board/projects/:projectId/cards',
  'GET /api/board/cards/:cardId',
  'POST /appairage/reclamer',
  'GET /appairage/:demandeId',
];

const methodes = (m: string | string[]) => (Array.isArray(m) ? m : [m]).filter((x) => x !== 'HEAD');

async function demarrer() {
  const mac: Array<{ method: string; url: string }> = [];
  t = await startTestDaemon(undefined, {
    tailscaleExec: tailnet,
    onRoute: (r) => methodes(r.method).forEach((method) => mac.push({ method, url: r.url })),
  });
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: true },
  });
  const registre = new RegistreAppareils(t.db);
  const { appareil, jeton } = registre.emettre({ nom: 'Téléphone', identite: null });
  return { mac, registre, appareil, jeton };
}

test('31.8 (D174) : chaque route du Mac rend 404 sur le port des appareils, hors de la liste', async () => {
  const { mac, jeton } = await demarrer();
  // le relevé a bien vu le Mac entier : ses familles de routes y sont
  const urls = new Set(mac.map((r) => r.url));
  for (const u of [
    '/api/state',
    '/api/host',
    '/ws/events',
    '/api/artefacts/etat',
    '/api/host/couper',
  ]) {
    expect(urls.has(u), u).toBe(true);
  }
  expect(mac.length).toBeGreaterThan(80);
  const appareil = t!.d.modeHost.instance()!;
  const ouvertes: string[] = [];
  for (const { method, url } of mac) {
    const cle = `${method} ${url}`;
    // un paramètre vaut 1 : il passe les validations numériques, et rien n'existe sous ce nom
    const sansCorps = method === 'GET' || method === 'DELETE';
    const chemin = url.replace(/:[A-Za-z_]+/g, '1').replace(/\*/g, 'x');
    const r = await appareil.inject({
      method: method as 'GET',
      url: chemin,
      headers: {
        host: NOM,
        origin: `https://${NOM}`,
        'sec-fetch-site': 'same-origin',
        'x-aid-cockpit': '1',
        cookie: `${COOKIE_APPAREIL}=${jeton}`,
        ...(sansCorps ? {} : { 'content-type': 'application/json' }),
      },
      payload: sansCorps ? undefined : '{}',
    });
    if (LISTE.includes(cle)) continue;
    if (r.statusCode !== 404) ouvertes.push(`${cle} → ${r.statusCode}`);
  }
  expect(ouvertes).toEqual([]);
});

test('31.8 (D174) : le port des appareils déclare exactement la liste', async () => {
  await demarrer();
  // le port réel est rouvert avec le relevé : on éteint, puis on relève à l'allumage
  const routes: string[] = [];
  const { ouvrirServeurAppareils } = await import('../src/daemon/host/serveur.js');
  const { Appairages } = await import('../src/daemon/host/appairage.js');
  const s = await ouvrirServeurAppareils({
    port: 0,
    interdits: [],
    nom: () => NOM,
    registre: new RegistreAppareils(t!.db),
    appairages: new Appairages(),
    webRoot: null,
    onRoute: (r) => methodes(r.method).forEach((m) => routes.push(`${m} ${r.url}`)),
  });
  if (!s.disponible) throw new Error(s.raison);
  await s.app.close();
  expect([...new Set(routes)].sort()).toEqual([...LISTE].sort());
});

function connecter(port: number, jeton: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/signal`, {
    headers: {
      host: NOM,
      origin: `https://${NOM}`,
      cookie: `${COOKIE_APPAREIL}=${jeton}`,
      'sec-fetch-site': 'same-origin',
    },
  });
  const fin = new Promise<[number, string]>((r) => ws.on('close', (c, m) => r([c, String(m)])));
  const ouvert = new Promise<void>((r, j) => {
    ws.on('open', () => r());
    ws.on('error', j);
  });
  return { ws, fin, ouvert };
}

const surAppareil = (jeton: string, method: 'GET' | 'POST' | 'DELETE', url: string) =>
  t!.d.modeHost.instance()!.inject({
    method,
    url,
    headers: {
      host: NOM,
      origin: `https://${NOM}`,
      'sec-fetch-site': 'same-origin',
      cookie: `${COOKIE_APPAREIL}=${jeton}`,
    },
  });

test('31.8 (D177) : révoquer depuis le Mac ferme les sockets de l’appareil, et lui seul', async () => {
  const { registre, appareil, jeton } = await demarrer();
  const autre = registre.emettre({ nom: 'B', identite: null });
  const port = t!.d.modeHost.portOuvert()!;
  const a = connecter(port, jeton);
  const b = connecter(port, autre.jeton);
  await Promise.all([a.ouvert, b.ouvert]);
  const liste = await t!.d.app.inject({ url: '/api/host/appareils', headers: t!.headers });
  expect(
    liste
      .json()
      .map((x: { nom: string }) => x.nom)
      .sort(),
  ).toEqual(['B', 'Téléphone']);
  expect(liste.body).not.toContain('empreinte');
  const r = await t!.d.app.inject({
    method: 'DELETE',
    url: `/api/host/appareils/${appareil.id}`,
    headers: t!.headers,
  });
  expect(r.statusCode).toBe(200);
  expect(await a.fin).toEqual([4401, 'revoque']);
  expect(b.ws.readyState).toBe(WebSocket.OPEN);
  expect((await surAppareil(jeton, 'GET', '/api/state')).json()).toMatchObject({
    raison: 'revoque',
  });
  expect((await surAppareil(autre.jeton, 'GET', '/api/state')).statusCode).toBe(200);
  // deux fois, ou inconnu : 404
  const encore = await t!.d.app.inject({
    method: 'DELETE',
    url: `/api/host/appareils/${appareil.id}`,
    headers: t!.headers,
  });
  expect(encore.statusCode).toBe(404);
  b.ws.terminate();
});

test('31.8 (D177) : couper tous les accès ferme tout et annule la demande ; le Mac reste', async () => {
  const { registre, jeton } = await demarrer();
  const autre = registre.emettre({ nom: 'B', identite: null });
  const port = t!.d.modeHost.portOuvert()!;
  const a = connecter(port, jeton);
  const b = connecter(port, autre.jeton);
  await Promise.all([a.ouvert, b.ouvert]);
  await t!.d.app.inject({ method: 'POST', url: '/api/host/appairages', headers: t!.headers });
  const r = await t!.d.app.inject({ method: 'POST', url: '/api/host/couper', headers: t!.headers });
  expect(r.json()).toEqual({ coupes: 2 });
  expect(await a.fin).toEqual([4401, 'revoque']);
  expect(await b.fin).toEqual([4401, 'revoque']);
  expect(
    (await t!.d.app.inject({ url: '/api/host/appairage', headers: t!.headers })).json().demande
      .raison,
  ).toBe('coupee');
  // le Mac reste, et le port des appareils aussi
  expect((await t!.d.app.inject({ url: '/api/state', headers: t!.headers })).statusCode).toBe(200);
  expect(t!.d.modeHost.instance()).not.toBeNull();
});

test('31.8 (D177) : depuis un appareil, la liste, révoquer un autre, se déconnecter', async () => {
  const { registre, appareil, jeton } = await demarrer();
  const autre = registre.emettre({ nom: 'B', identite: 'utilisateur@exemple' });
  const liste = await surAppareil(jeton, 'GET', '/api/appareils');
  expect(liste.statusCode).toBe(200);
  const lignes = liste.json<Array<{ id: string; moi: boolean }>>();
  expect(lignes.find((l) => l.id === appareil.id)!.moi).toBe(true);
  expect(lignes.find((l) => l.id === autre.appareil.id)!.moi).toBe(false);
  // ni l'identité, ni l'empreinte
  expect(liste.body).not.toContain('utilisateur@exemple');
  expect(liste.body).not.toContain('empreinte');
  expect(
    (await surAppareil(jeton, 'DELETE', `/api/appareils/${autre.appareil.id}`)).statusCode,
  ).toBe(200);
  expect(registre.authentifier(autre.jeton)).toEqual({ ok: false, raison: 'revoque' });
  const sortie = await surAppareil(jeton, 'POST', '/api/appareils/moi/deconnexion');
  expect(sortie.json()).toEqual({ ok: true });
  const efface = sortie.cookies.find((c) => c.name === COOKIE_APPAREIL)!;
  expect(efface.value).toBe('');
  expect(registre.authentifier(jeton)).toEqual({ ok: false, raison: 'revoque' });
});

test('31.8 : une écriture d’appareil sans Origin est refusée', async () => {
  const { registre, jeton } = await demarrer();
  const autre = registre.emettre({ nom: 'B', identite: null });
  const r = await t!.d.modeHost.instance()!.inject({
    method: 'DELETE',
    url: `/api/appareils/${autre.appareil.id}`,
    headers: { host: NOM, 'sec-fetch-site': 'same-origin', cookie: `${COOKIE_APPAREIL}=${jeton}` },
  });
  expect(r.statusCode).toBe(403);
  expect(registre.authentifier(autre.jeton).ok).toBe(true);
});

test('31.8 (D172) : éteindre le mode host arrête l’écoute', async () => {
  await demarrer();
  const app = t!.d.modeHost.instance()!;
  const port = t!.d.modeHost.portOuvert()!;
  await t!.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t!.headers,
    payload: { actif: false },
  });
  expect(app.server.listening).toBe(false);
  const refus = await new Promise<string>((r) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/signal`);
    ws.on('error', (e) => r((e as NodeJS.ErrnoException).code ?? 'erreur'));
    ws.on('open', () => r('ouvert'));
  });
  expect(refus).toBe('ECONNREFUSED');
});

test('31.8 : révoquer et couper, admin seulement sur le Mac', async () => {
  const { appareil } = await demarrer();
  const { issueRunToken } = await import('../src/daemon/security.js');
  const run = issueRunToken(t!.d.auth, 'run-synthetique');
  for (const [method, url] of [
    ['GET', '/api/host/appareils'],
    ['DELETE', `/api/host/appareils/${appareil.id}`],
    ['POST', '/api/host/couper'],
  ] as const) {
    const r = await t!.d.app.inject({
      method,
      url,
      headers: { host: t!.headers.host!, authorization: `Bearer ${run}` },
    });
    expect(r.statusCode, url).toBe(403);
  }
});
