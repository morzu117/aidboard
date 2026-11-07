import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { openDb } from '../src/daemon/db.js';
import { Appairages } from '../src/daemon/host/appairage.js';
import { DUREE_ACCES_MS, RegistreAppareils } from '../src/daemon/host/appareils.js';
import {
  COOKIE_APPAREIL,
  cspAppareils,
  masquerAppairage,
  ouvrirServeurAppareils,
  type ServeurAppareils,
} from '../src/daemon/host/serveur.js';

// Chantier 31 (D171, D174) : le port des appareils, seul. Les jetons du Mac sur ce port, et le
// cookie d'appareil sur celui du Mac : test/host-mode.test.ts.

const NOM = 'mac-synthetique.exemple.ts.net';
const ORIGINE = `https://${NOM}`;
let s: ServeurAppareils | null = null;
let occupant: Server | null = null;
afterEach(async () => {
  if (s?.disponible) await s.app.close();
  s = null;
  await new Promise<void>((r) => (occupant ? occupant.close(() => r()) : r()));
  occupant = null;
});

/** un faux build : index.html, un script, une icône */
function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'aid-web-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("app")');
  writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return root;
}

async function ouvrir(
  extra: { webRoot?: string | null; nom?: string | null; logStream?: PassThrough } = {},
) {
  const h = { t: Date.parse('2026-11-07T10:00:00Z') };
  const registre = new RegistreAppareils(
    openDb(join(mkdtempSync(join(tmpdir(), 'aid-hs-')), 'state.db')),
    () => h.t,
  );
  const nom = extra.nom === undefined ? NOM : extra.nom;
  s = await ouvrirServeurAppareils({
    port: 0,
    interdits: [],
    nom: () => nom,
    registre,
    appairages: new Appairages(),
    webRoot: extra.webRoot === undefined ? build() : extra.webRoot,
    logStream: extra.logStream,
  });
  if (!s.disponible) throw new Error(s.raison);
  const { appareil, jeton } = registre.emettre({ nom: 'Téléphone', identite: null });
  return { srv: s, registre, h, appareil, jeton };
}

const api = (jeton: string, over: Record<string, string> = {}) => ({
  host: NOM,
  cookie: `${COOKIE_APPAREIL}=${jeton}`,
  'sec-fetch-site': 'same-origin',
  ...over,
});

test('31.5 (D171) : 421 hors du nom .ts.net, même avec un cookie valide', async () => {
  const { srv, jeton } = await ouvrir();
  for (const host of [
    `127.0.0.1:${srv.port}`,
    `localhost:${srv.port}`,
    `${NOM}:8443`,
    `${NOM}:443`,
    'evil.example',
    `evil.${NOM}`,
    '',
  ]) {
    for (const url of ['/', '/api/appareils/moi']) {
      const r = await srv.app.inject({ url, headers: { ...api(jeton), host } });
      expect(r.statusCode, `${host} ${url}`).toBe(421);
    }
  }
});

test('31.5 (D171) : sans nom Tailscale lu, tout est refusé', async () => {
  const { srv, jeton } = await ouvrir({ nom: null });
  const r = await srv.app.inject({ url: '/api/appareils/moi', headers: api(jeton) });
  expect(r.statusCode).toBe(421);
});

test('31.5 (D171) : 403 sur une Origin étrangère, null, ou en http://', async () => {
  const { srv, jeton } = await ouvrir();
  for (const origin of ['https://evil.example', 'null', `http://${NOM}`, `${ORIGINE}:8443`]) {
    for (const url of ['/', '/api/appareils/moi']) {
      const r = await srv.app.inject({ url, headers: api(jeton, { origin }) });
      expect(r.statusCode, `${origin} ${url}`).toBe(403);
    }
  }
  const ok = await srv.app.inject({
    url: '/api/appareils/moi',
    headers: api(jeton, { origin: ORIGINE }),
  });
  expect(ok.statusCode).toBe(200);
});

test('31.5 (D180) : GET /api/appareils/moi, avec le cookie d’appareil', async () => {
  const { srv, appareil, jeton } = await ouvrir();
  const r = await srv.app.inject({ url: '/api/appareils/moi', headers: api(jeton) });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ id: appareil.id, nom: 'Téléphone', expireA: appareil.expireA });
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.headers['content-security-policy']).toBe(cspAppareils(NOM));
  expect(r.headers['x-content-type-options']).toBe('nosniff');
  expect(r.headers['referrer-policy']).toBe('no-referrer');
});

test('31.5 (D177) : sans cookie, inconnu, révoqué ou expiré : 401 avec la raison', async () => {
  const { srv, registre, h, appareil, jeton } = await ouvrir();
  const sans = await srv.app.inject({
    url: '/api/appareils/moi',
    headers: { host: NOM, 'sec-fetch-site': 'same-origin' },
  });
  expect(sans.statusCode).toBe(401);
  expect(sans.json()).toEqual({ error: 'Non authentifié', raison: 'inconnu' });
  const autre = registre.emettre({ nom: 'B', identite: null });
  registre.revoquer(autre.appareil.id);
  const revoque = await srv.app.inject({ url: '/api/appareils/moi', headers: api(autre.jeton) });
  expect([revoque.statusCode, revoque.json().raison]).toEqual([401, 'revoque']);
  h.t += DUREE_ACCES_MS;
  const expire = await srv.app.inject({ url: '/api/appareils/moi', headers: api(jeton) });
  expect([expire.statusCode, expire.json().raison]).toEqual([401, 'expire']);
  expect(registre.lire(appareil.id)!.etat).toBe('expire');
});

test('31.5 (D171, D165) : Sec-Fetch-Site, et son absence sans l’en-tête du cockpit', async () => {
  const { srv, jeton } = await ouvrir();
  for (const site of ['cross-site', 'same-site', 'none']) {
    const r = await srv.app.inject({
      url: '/api/appareils/moi',
      headers: api(jeton, { 'sec-fetch-site': site }),
    });
    expect(r.statusCode, site).toBe(403);
  }
  const sansSite: Record<string, string> = api(jeton);
  delete sansSite['sec-fetch-site'];
  const absent = await srv.app.inject({ url: '/api/appareils/moi', headers: sansSite });
  expect(absent.statusCode).toBe(403);
  const cockpit = await srv.app.inject({
    url: '/api/appareils/moi',
    headers: { ...sansSite, 'x-aid-cockpit': '1' },
  });
  expect(cockpit.statusCode).toBe(200);
});

test('31.5 (D174) : aucune route du Mac ; ce qui n’est pas déclaré n’existe pas', async () => {
  const { srv, jeton } = await ouvrir();
  for (const url of [
    '/api/state',
    '/api/host',
    '/api/artefacts/etat',
    '/api/topics',
    '/api/appareils',
  ]) {
    const r = await srv.app.inject({ url, headers: api(jeton) });
    expect(r.statusCode, url).toBe(404);
  }
  for (const method of ['POST', 'PUT', 'DELETE'] as const) {
    const r = await srv.app.inject({ method, url: '/api/appareils/moi', headers: api(jeton) });
    expect(r.statusCode, method).toBe(404);
  }
  // le lien d'ouverture du Mac n'y fait rien
  const auth = await srv.app.inject({ url: '/auth?token=x', headers: { host: NOM } });
  expect(auth.headers['set-cookie']).toBeUndefined();
});

test('31.5 (lab DM 91366) : les fichiers servis sont ceux du build, à l’octet près, repli compris', async () => {
  const root = build();
  const { srv } = await ouvrir({ webRoot: root });
  const index = readFileSync(join(root, 'index.html'));
  for (const url of ['/', '/index.html', '/appairer', '/board/un-sujet', '/une/route?x=1']) {
    const r = await srv.app.inject({ url, headers: { host: NOM } });
    expect(r.statusCode, url).toBe(200);
    expect(r.rawPayload.equals(index), url).toBe(true);
    expect(r.headers['set-cookie'], url).toBeUndefined();
  }
  const js = await srv.app.inject({ url: '/assets/app.js', headers: { host: NOM } });
  expect(js.body).toBe('console.log("app")');
  // hors du build, rien : ni fichier voisin, ni remontée
  for (const url of ['/../state.db', '/%2e%2e/index.html', '/assets/absent.js']) {
    const r = await srv.app.inject({ url, headers: { host: NOM } });
    expect(r.rawPayload.equals(index) || r.statusCode === 404, url).toBe(true);
  }
});

test('31.5 : sans build, 404 partout hors de l’API', async () => {
  const { srv } = await ouvrir({ webRoot: null });
  const r = await srv.app.inject({ url: '/', headers: { host: NOM } });
  expect(r.statusCode).toBe(404);
});

test('31.5 (D171) : port occupé, indisponible avec sa raison ; les ports interdits refusés', async () => {
  occupant = createServer();
  const port = await new Promise<number>((r) =>
    occupant!.listen(0, '127.0.0.1', () => r((occupant!.address() as { port: number }).port)),
  );
  const registre = new RegistreAppareils(
    openDb(join(mkdtempSync(join(tmpdir(), 'aid-hs-')), 'state.db')),
  );
  const base = { nom: () => NOM, registre, appairages: new Appairages(), webRoot: null };
  s = await ouvrirServeurAppareils({ ...base, port, interdits: [] });
  expect(s).toEqual({ disponible: false, port, raison: `le port ${port} est occupé` });
  for (const [p, nom] of [
    [4870, 'daemon'],
    [4871, "pont de l'app"],
    [4880, 'artefacts'],
  ] as const) {
    const r = await ouvrirServeurAppareils({
      ...base,
      port: p,
      interdits: [
        { port: 4870, nom: 'daemon' },
        { port: 4871, nom: "pont de l'app" },
        { port: 4880, nom: 'artefacts' },
      ],
    });
    expect(r).toEqual({ disponible: false, port: p, raison: `le port ${p} est réservé (${nom})` });
  }
});

test('31.5 (D171) : le journal ne contient ni le cookie, ni la demande, ni la requête', async () => {
  const flux = new PassThrough();
  let journal = '';
  flux.on('data', (c: Buffer) => (journal += c.toString()));
  const { srv, jeton } = await ouvrir({ logStream: flux });
  await srv.app.inject({
    url: '/api/appareils/moi',
    headers: api(jeton, { 'sec-fetch-site': 'cross-site' }),
  });
  await srv.app.inject({
    url: '/appairage/demande-synthetique-secrete',
    headers: { host: NOM, cookie: `${COOKIE_APPAREIL}=${jeton}` },
  });
  await srv.app.inject({
    url: '/appairer?code=code-synthetique-secret',
    headers: { host: 'evil.example' },
  });
  expect(journal).toContain('refus');
  expect(journal).not.toContain(jeton);
  expect(journal).not.toContain('demande-synthetique-secrete');
  expect(journal).not.toContain('code-synthetique-secret');
});

test('masquerAppairage : la demande masquée, la requête et le fragment retirés', () => {
  expect(masquerAppairage('/appairage/abc')).toBe('/appairage/***');
  expect(masquerAppairage('/appairage/abc?x=1')).toBe('/appairage/***');
  expect(masquerAppairage('/appairer#code')).toBe('/appairer');
  expect(masquerAppairage(undefined)).toBe('');
});
