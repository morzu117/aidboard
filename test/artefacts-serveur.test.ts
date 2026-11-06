import { createServer, type Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { JetonsArtefacts } from '../src/daemon/artefacts/jetons.js';
import {
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
  expect(r.headers['content-security-policy']).toBe(cspArtefact(DAEMON));
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
  expect(r.headers['content-security-policy']).toBe(cspArtefact(DAEMON));
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
  expect(r.headers['content-security-policy']).toBe(cspArtefact(DAEMON));
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
