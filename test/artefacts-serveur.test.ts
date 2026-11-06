import { createServer, type Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { JetonsArtefacts } from '../src/daemon/artefacts/jetons.js';
import {
  CSP_ENVELOPPE,
  cspArtefact,
  masquerJeton,
  ouvrirServeurArtefacts,
  PORT_PONT_TAURI,
  type ServeurArtefacts,
} from '../src/daemon/artefacts/serveur.js';

// Chantier 30 (D162, D164) : le second port, une autre origine qui ne sert que des jetons.

const DAEMON = 4870;
let s: ServeurArtefacts | null = null;
let occupant: Server | null = null;
afterEach(async () => {
  if (s?.disponible) await s.app.close();
  s = null;
  await new Promise<void>((r) => (occupant ? occupant.close(() => r()) : r()));
  occupant = null;
});

async function ouvrir(jetons = new JetonsArtefacts(), extra = {}) {
  s = await ouvrirServeurArtefacts({ port: 0, portDaemon: () => DAEMON, jetons, ...extra });
  if (!s.disponible) throw new Error(s.raison);
  return s;
}

const SECRET_COOKIE = 'aid_session=valeur-synthetique-du-cookie';

test('D164 : un HTML servi avec la CSP fermée, sandbox, et rien qui pose un cookie', async () => {
  const jetons = new JetonsArtefacts();
  const srv = await ouvrir(jetons);
  const { jeton } = jetons.emettre(Buffer.from('<p>rapport</p>'), 'html');
  const r = await srv.app.inject({
    url: `/a/${jeton}`,
    headers: { host: `127.0.0.1:${srv.port}`, cookie: SECRET_COOKIE },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).toBe('<p>rapport</p>');
  expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(r.headers['content-security-policy']).toBe(cspArtefact(DAEMON, srv.port));
  expect(String(r.headers['content-security-policy'])).toMatch(/^sandbox allow-scripts; /);
  expect(String(r.headers['content-security-policy'])).toContain("connect-src 'none'");
  expect(String(r.headers['content-security-policy'])).toContain(
    'frame-ancestors http://127.0.0.1:4870 http://localhost:4870',
  );
  expect(r.headers['x-content-type-options']).toBe('nosniff');
  expect(r.headers['referrer-policy']).toBe('no-referrer');
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.headers['set-cookie']).toBeUndefined();
});

test('D164 : un SVG en image/svg+xml, sous la même CSP', async () => {
  const jetons = new JetonsArtefacts();
  const srv = await ouvrir(jetons);
  const { jeton } = jetons.emettre(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg');
  const r = await srv.app.inject({
    url: `/a/${jeton}`,
    headers: { host: `localhost:${srv.port}` },
  });
  expect(r.statusCode).toBe(200);
  expect(r.headers['content-type']).toBe('image/svg+xml');
  expect(r.headers['content-security-policy']).toBe(cspArtefact(DAEMON, srv.port));
});

test('D162 : un autre hôte vaut 421 (DNS rebinding), même avec un jeton valide', async () => {
  const jetons = new JetonsArtefacts();
  const srv = await ouvrir(jetons);
  const { jeton } = jetons.emettre(Buffer.from('x'), 'html');
  for (const host of ['evil.example', `evil.example:${srv.port}`, '127.0.0.1:4870', '']) {
    const r = await srv.app.inject({ url: `/a/${jeton}`, headers: { host } });
    expect(r.statusCode, host).toBe(421);
    expect(r.body).not.toContain('x');
  }
});

test('D164 : jeton inconnu ou expiré, 404 sans répéter le jeton', async () => {
  const srv = await ouvrir();
  const r = await srv.app.inject({
    url: '/a/jeton-inconnu-synthetique',
    headers: { host: `127.0.0.1:${srv.port}` },
  });
  expect(r.statusCode).toBe(404);
  expect(r.body).not.toContain('jeton-inconnu-synthetique');
  expect(r.headers['content-security-policy']).toBe(cspArtefact(DAEMON, srv.port));
});

test('D162 : aucune route de l’API, et GET seulement', async () => {
  const jetons = new JetonsArtefacts();
  const srv = await ouvrir(jetons);
  const host = `127.0.0.1:${srv.port}`;
  for (const url of ['/api/state', '/', '/auth?token=x', '/ws/events']) {
    const r = await srv.app.inject({ url, headers: { host, cookie: SECRET_COOKIE } });
    expect(r.statusCode, url).toBe(404);
  }
  const { jeton } = jetons.emettre(Buffer.from('x'), 'html');
  const post = await srv.app.inject({ method: 'POST', url: `/a/${jeton}`, headers: { host } });
  expect(post.statusCode).toBe(405);
});

test('D162 : le journal ne contient ni le cookie ni le jeton', async () => {
  const flux = new PassThrough();
  let journal = '';
  flux.on('data', (c: Buffer) => (journal += c.toString()));
  const jetons = new JetonsArtefacts();
  const srv = await ouvrir(jetons, { logStream: flux });
  const { jeton } = jetons.emettre(Buffer.from('x'), 'html');
  const host = `127.0.0.1:${srv.port}`;
  await srv.app.inject({ url: `/a/${jeton}`, headers: { host, cookie: SECRET_COOKIE } });
  await srv.app.inject({ url: `/a/${jeton}x`, headers: { host, cookie: SECRET_COOKIE } });
  await srv.app.inject({
    url: `/a/${jeton}`,
    headers: { host: 'evil.example', cookie: SECRET_COOKIE },
  });
  expect(journal).toContain('/a/***');
  expect(journal).not.toContain(jeton);
  expect(journal).not.toContain('valeur-synthetique-du-cookie');
});

test('masquerJeton : le chemin seul, requête comprise', () => {
  expect(masquerJeton('/a/abc')).toBe('/a/***');
  expect(masquerJeton('/v/abc?x=1')).toBe('/v/***?x=1');
  expect(masquerJeton('/a/abc?x=1')).toBe('/a/***?x=1');
  expect(masquerJeton(undefined)).toBe('');
});

test('D162 : port occupé, indisponible avec sa raison, sans lever', async () => {
  occupant = createServer();
  const port = await new Promise<number>((r) =>
    occupant!.listen(0, '127.0.0.1', () => r((occupant!.address() as { port: number }).port)),
  );
  s = await ouvrirServeurArtefacts({
    port,
    portDaemon: () => DAEMON,
    jetons: new JetonsArtefacts(),
  });
  expect(s).toEqual({ disponible: false, port, raison: `le port ${port} est occupé` });
});

test('D162 : jamais sur le port du daemon ni sur celui du pont Tauri', async () => {
  for (const port of [DAEMON, PORT_PONT_TAURI]) {
    s = await ouvrirServeurArtefacts({
      port,
      portDaemon: () => DAEMON,
      jetons: new JetonsArtefacts(),
    });
    expect(s.disponible, String(port)).toBe(false);
  }
});

test('30.9 (lab 91283) : frame-ancestors accepte aussi le port des artefacts, pour l’enveloppe', () => {
  expect(cspArtefact(4870, 4880)).toContain(
    'frame-ancestors http://127.0.0.1:4870 http://localhost:4870 http://127.0.0.1:4880 http://localhost:4880',
  );
});

test('30.9 (lab 91283) : l’enveloppe, le cadre sandboxé seul, sans script, qui n’encadre que ce port', async () => {
  const jetons = new JetonsArtefacts();
  const srv = await ouvrir(jetons);
  const { jeton } = jetons.emettre(Buffer.from('<p>x</p>'), 'html');
  const host = `127.0.0.1:${srv.port}`;
  const r = await srv.app.inject({ url: `/v/${jeton}`, headers: { host, cookie: SECRET_COOKIE } });
  expect(r.statusCode).toBe(200);
  expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(r.headers['content-security-policy']).toBe(CSP_ENVELOPPE);
  expect(CSP_ENVELOPPE).toContain("default-src 'none'");
  expect(CSP_ENVELOPPE).toContain("frame-src 'self'");
  expect(CSP_ENVELOPPE).toContain("frame-ancestors 'none'");
  expect(r.headers['set-cookie']).toBeUndefined();
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.body).toContain(
    `<iframe src="/a/${jeton}" sandbox="allow-scripts" referrerpolicy="no-referrer"`,
  );
  expect(r.body).not.toMatch(/<script/i);
  // inconnu : 404 sans le répéter ; les autres verbes : 405
  const inconnu = await srv.app.inject({ url: '/v/jeton-inconnu-synthetique', headers: { host } });
  expect(inconnu.statusCode).toBe(404);
  expect(inconnu.body).not.toContain('jeton-inconnu-synthetique');
  expect(inconnu.headers['content-security-policy']).toBe(cspArtefact(DAEMON, srv.port));
  const post = await srv.app.inject({ method: 'POST', url: `/v/${jeton}`, headers: { host } });
  expect(post.statusCode).toBe(405);
});

// Lab (DM 91283) : le cadre peut encore naviguer vers une autre URL de ce port, et y mettre des
// données dans la ligne de requête. Aucune réponse ne doit les renvoyer, pour qu'aucun autre
// artefact ne puisse les lire.
test('30.9 (lab 91283) : aucune réponse ne renvoie le chemin ni la requête', async () => {
  const jetons = new JetonsArtefacts();
  const srv = await ouvrir(jetons);
  const { jeton } = jetons.emettre(Buffer.from('<p>contenu</p>'), 'html');
  const M = 'fuite-synthetique-7f3a';
  const host = `127.0.0.1:${srv.port}`;
  const urls = [
    `/a/${M}`,
    `/a/${M}?d=${M}`,
    `/a/${jeton}?d=${M}`,
    `/a/${jeton}/${M}`,
    `/v/${M}`,
    `/v/${jeton}?d=${M}`,
    `/${M}`,
    `/${M}?d=${M}`,
    `/api/${M}`,
    `/a/${jeton}#${M}`,
  ];
  for (const url of urls) {
    for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS'] as const) {
      const r = await srv.app.inject({ method, url, headers: { host } });
      expect(r.body, `${method} ${url}`).not.toContain(M);
      expect(JSON.stringify(r.headers), `${method} ${url}`).not.toContain(M);
    }
  }
  // et sur un hôte étranger
  const etranger = await srv.app.inject({
    url: `/a/${M}?d=${M}`,
    headers: { host: `${M}.example` },
  });
  expect(etranger.body).not.toContain(M);
});
