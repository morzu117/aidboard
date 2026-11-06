import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { openDb } from '../src/daemon/db.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { AgentManager } from '../src/daemon/pty/manager.js';
import { EventStore } from '../src/daemon/events/store.js';
import { type AuthState, createAuthState, issueRunToken } from '../src/daemon/security.js';
import { buildServer } from '../src/daemon/server.js';

let app: FastifyInstance;
let db: ReturnType<typeof openDb>;
let auth: AuthState;
let port: number;

async function start() {
  auth = createAuthState();
  const webRoot = mkdtempSync(join(tmpdir(), 'aid-web-'));
  writeFileSync(join(webRoot, 'index.html'), '<p>ok</p>');
  db = openDb(join(webRoot, 'state.db'));
  const paths = resolvePaths(webRoot);
  const store = new EventStore(db);
  const config = { ...DEFAULT_CONFIG, port: 0 };
  const agents = new AgentManager({ store, db, paths, config, auth, port: () => 0 });
  app = await buildServer({ config, auth, db, store, agents, paths, webRoot });
  app.post('/api/probe', async () => ({ ok: true }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
}

afterEach(async () => {
  await app?.close();
});

const host = () => `127.0.0.1:${port}`;
const origin = () => `http://127.0.0.1:${port}`;
const cookie = () => ({ cookie: `aid_session=${auth.sessionToken}`, 'x-aid-cockpit': '1' });
// chantier 30 (D165, lab 91283) : le cookie seul, comme le porte une navigation
const cookieSeul = () => ({ cookie: `aid_session=${auth.sessionToken}` });

test('GET /api/state sans cookie ni bearer : 401', async () => {
  await start();
  const r = await app.inject({ url: '/api/state', headers: { host: host() } });
  expect(r.statusCode).toBe(401);
});

test('GET /auth avec le bon token : 303 et cookie HttpOnly SameSite=Strict', async () => {
  await start();
  const r = await app.inject({ url: `/auth?token=${auth.adminToken}`, headers: { host: host() } });
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe('/');
  const set = String(r.headers['set-cookie']);
  expect(set).toContain('aid_session=');
  expect(set).toMatch(/HttpOnly/i);
  expect(set).toMatch(/SameSite=Strict/i);
  expect(set).not.toMatch(/Secure/i);
});

test('GET /auth avec un mauvais token : 401', async () => {
  await start();
  const r = await app.inject({ url: '/auth?token=faux', headers: { host: host() } });
  expect(r.statusCode).toBe(401);
  expect(r.payload).toContain('Lien expiré');
});

test('cookie valide mais Host étranger : 421', async () => {
  await start();
  const r = await app.inject({ url: '/api/state', headers: { host: 'evil.com', ...cookie() } });
  expect(r.statusCode).toBe(421);
});

test('POST avec cookie valide et Origin étrangère : 403', async () => {
  await start();
  const r = await app.inject({
    method: 'POST',
    url: '/api/events',
    headers: { host: host(), origin: 'http://evil.com', ...cookie() },
    payload: {},
  });
  expect(r.statusCode).toBe(403);
});

test('POST avec cookie valide et sans Origin : 403', async () => {
  await start();
  const r = await app.inject({
    method: 'POST',
    url: '/api/probe',
    headers: { host: host(), ...cookie() },
    payload: {},
  });
  expect(r.statusCode).toBe(403);
});

test('POST avec cookie valide et la bonne Origin : accepté', async () => {
  await start();
  const r = await app.inject({
    method: 'POST',
    url: '/api/probe',
    headers: { host: host(), origin: origin(), ...cookie() },
    payload: {},
  });
  expect(r.statusCode).toBe(200);
});

test('appel Bearer admin sans Origin (CLI) : accepté', async () => {
  await start();
  const r = await app.inject({
    method: 'POST',
    url: '/api/probe',
    headers: { host: host(), authorization: `Bearer ${auth.adminToken}` },
    payload: {},
  });
  expect(r.statusCode).toBe(200);
});

function wsOpen(headers: Record<string, string>): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => undefined);
  });
}

test('WebSocket : origine étrangère refusée', async () => {
  await start();
  expect(await wsOpen({ origin: 'http://evil.com', ...cookie() })).toBe(403);
});

test('WebSocket : sans cookie refusé', async () => {
  await start();
  expect(await wsOpen({ origin: origin() })).toBe(401);
});

test('WebSocket : sans Origin refusé même avec un cookie valide', async () => {
  await start();
  expect(await wsOpen({ ...cookie() })).toBe(403);
});

test('WebSocket : cookie et Origin valides acceptés', async () => {
  await start();
  expect(await wsOpen({ origin: origin(), ...cookie() })).toBe('open');
});

test('token de run : refusé sur GET /api/state', async () => {
  await start();
  const t = issueRunToken(auth, 'run_1');
  const r = await app.inject({
    url: '/api/state',
    headers: { host: host(), authorization: `Bearer ${t}` },
  });
  expect(r.statusCode).toBe(403);
});

test('token de run : POST /api/events pour un autre runId refusé, pour le sien accepté', async () => {
  await start();
  const t = issueRunToken(auth, 'run_1');
  const h = { host: host(), authorization: `Bearer ${t}` };
  const autre = await app.inject({
    method: 'POST',
    url: '/api/events',
    headers: h,
    payload: { source: 'hook:claude', type: 'agent.status', data: {}, runId: 'run_2' },
  });
  expect(autre.statusCode).toBe(403);
  db.prepare(
    "INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at) VALUES ('ws_1','a','/a','main','/w','t')",
  ).run();
  db.prepare(
    "INSERT INTO topics VALUES ('tp_1','ws_1','s','T','feat','feat/s','main','/w/s','active',NULL,'disabled','t','t',NULL,NULL,NULL)",
  ).run();
  db.prepare("INSERT INTO runs VALUES ('run_1','tp_1','standard','open','t')").run();
  const sien = await app.inject({
    method: 'POST',
    url: '/api/events',
    headers: h,
    payload: { source: 'hook:claude', type: 'agent.status', data: {}, runId: 'run_1' },
  });
  expect(sien.statusCode).toBe(202);
});

test('la page porte la CSP et aucun en-tête CORS', async () => {
  await start();
  const r = await app.inject({ url: '/', headers: { host: host(), ...cookie() } });
  expect(r.statusCode).toBe(200);
  expect(String(r.headers['content-security-policy'])).toContain("default-src 'self'");
  expect(Object.keys(r.headers).some((k) => k.startsWith('access-control-'))).toBe(false);
});

test('un token de longueur différente ne lève pas', async () => {
  await start();
  const r = await app.inject({
    url: '/api/state',
    headers: { host: host(), authorization: 'Bearer x' },
  });
  expect(r.statusCode).toBe(401);
});

test('la spec ouvre le navigateur sur /?token= : bon token 303 et cookie, mauvais token 401, sans token 401', async () => {
  await start();
  const ok = await app.inject({ url: `/?token=${auth.adminToken}`, headers: { host: host() } });
  expect(ok.statusCode).toBe(303);
  expect(String(ok.headers['set-cookie'])).toContain('aid_session=');
  expect((await app.inject({ url: '/?token=faux', headers: { host: host() } })).statusCode).toBe(
    401,
  );
  expect((await app.inject({ url: '/', headers: { host: host() } })).statusCode).toBe(401);
});

// chantier 30 (D165) : un artefact, sur le second port, peut naviguer son cadre vers l'API.
// Une navigation n'envoie pas d'Origin ; seul Sec-Fetch-Site la distingue du cockpit.
const site = (s: string) => ({ 'sec-fetch-site': s });

test('D165 : GET par cookie inter-site ou same-site sur l’API : 403', async () => {
  await start();
  for (const s of ['cross-site', 'same-site', 'none']) {
    const r = await app.inject({
      url: '/api/state',
      headers: { host: host(), ...cookie(), ...site(s) },
    });
    expect(r.statusCode, s).toBe(403);
    expect(r.json()).toEqual({ error: 'requête inter-site' });
  }
});

test('D165 : GET par cookie same-origin, ou sans Sec-Fetch-Site avec l’en-tête du cockpit : accepté', async () => {
  await start();
  const meme = await app.inject({
    url: '/api/state',
    headers: { host: host(), ...cookie(), ...site('same-origin') },
  });
  expect(meme.statusCode).toBe(200);
  const sans = await app.inject({ url: '/api/state', headers: { host: host(), ...cookie() } });
  expect(sans.statusCode).toBe(200);
});

test('D165 : POST par cookie, bonne Origin mais inter-site : 403', async () => {
  await start();
  const r = await app.inject({
    method: 'POST',
    url: '/api/probe',
    headers: { host: host(), origin: origin(), ...cookie(), ...site('same-site') },
    payload: {},
  });
  expect(r.statusCode).toBe(403);
});

test('D165 : un bearer n’est pas touché par Sec-Fetch-Site', async () => {
  await start();
  const r = await app.inject({
    url: '/api/state',
    headers: { host: host(), authorization: `Bearer ${auth.adminToken}`, ...site('cross-site') },
  });
  expect(r.statusCode).toBe(200);
});

test('D165 : Origin: null (document sandboxé) refusée', async () => {
  await start();
  for (const method of ['GET', 'POST'] as const) {
    const r = await app.inject({
      method,
      url: method === 'GET' ? '/api/state' : '/api/probe',
      headers: { host: host(), origin: 'null', ...cookie() },
      ...(method === 'POST' ? { payload: {} } : {}),
    });
    expect(r.statusCode, method).toBe(403);
  }
});

test('D165 : WebSocket inter-site refusé, même avec cookie et bonne Origin', async () => {
  await start();
  expect(await wsOpen({ origin: origin(), ...cookie(), ...site('same-site') })).toBe(403);
  expect(await wsOpen({ origin: origin(), ...cookie(), ...site('same-origin') })).toBe('open');
});

test('D165 : la page elle-même reste servie à une navigation de premier niveau', async () => {
  await start();
  const ok = await app.inject({
    url: `/?token=${auth.adminToken}`,
    headers: { host: host(), ...site('none') },
  });
  expect(ok.statusCode).toBe(303);
  const page = await app.inject({
    url: '/',
    headers: { host: host(), ...cookie(), ...site('none') },
  });
  expect(page.statusCode).toBe(200);
});

test('D166 : aucune page du port principal ne s’affiche dans un cadre', async () => {
  await start();
  const r = await app.inject({ url: '/', headers: { host: host(), ...cookie() } });
  expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
});

test('D165 (lab 91283) : par cookie, sans Sec-Fetch-Site ni l’en-tête du cockpit, /api/ vaut 403', async () => {
  await start();
  for (const method of ['GET', 'POST'] as const) {
    const r = await app.inject({
      method,
      url: method === 'GET' ? '/api/state' : '/api/probe',
      headers: { host: host(), origin: origin(), ...cookieSeul() },
      ...(method === 'POST' && { payload: {} }),
    });
    expect(r.statusCode, method).toBe(403);
    expect(r.json()).toEqual({ error: 'requête sans provenance' });
  }
  // une autre valeur que 1 n'est pas la marque du cockpit
  const faux = await app.inject({
    url: '/api/state',
    headers: { host: host(), ...cookieSeul(), 'x-aid-cockpit': 'oui' },
  });
  expect(faux.statusCode).toBe(403);
  // la page elle-même reste une navigation ordinaire
  const page = await app.inject({ url: '/', headers: { host: host(), ...cookieSeul() } });
  expect(page.statusCode).not.toBe(403);
});

test('D165 (lab 91283) : en bearer, l’absence de Sec-Fetch-Site et de l’en-tête ne refuse rien', async () => {
  await start();
  const r = await app.inject({
    url: '/api/state',
    headers: { host: host(), authorization: `Bearer ${auth.adminToken}` },
  });
  expect(r.statusCode).toBe(200);
});

test('D165 (lab 91283) : la marque du cockpit ne couvre pas une requête inter-site', async () => {
  await start();
  const r = await app.inject({
    url: '/api/state',
    headers: { host: host(), ...cookie(), ...site('cross-site') },
  });
  expect(r.statusCode).toBe(403);
});

test('D165 (lab 91283) : /ws/ par cookie exige l’Origin exacte du cockpit, ni null ni absente', async () => {
  await start();
  const ws = (h: Record<string, string>) =>
    app.inject({ url: '/ws/events', headers: { host: host(), ...cookie(), ...h } });
  expect((await ws({})).statusCode).toBe(403);
  expect((await ws({ origin: 'null' })).statusCode).toBe(403);
  expect((await ws({ origin: 'http://127.0.0.1:1' })).statusCode).toBe(403);
  expect((await ws({ origin: `http://localhost:${port}0` })).statusCode).toBe(403);
});
