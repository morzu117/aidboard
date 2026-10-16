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
  app = await buildServer({
    config: { ...DEFAULT_CONFIG, port: 0 },
    auth,
    db,
    store: new EventStore(db),
    paths: resolvePaths(webRoot),
    webRoot,
  });
  app.post('/api/probe', async () => ({ ok: true }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
}

afterEach(async () => {
  await app?.close();
});

const host = () => `127.0.0.1:${port}`;
const origin = () => `http://127.0.0.1:${port}`;
const cookie = () => ({ cookie: `aid_session=${auth.adminToken}` });

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
  db.prepare("INSERT INTO workspaces VALUES ('ws_1','a','/a','main','/w','t')").run();
  db.prepare(
    "INSERT INTO topics VALUES ('tp_1','ws_1','s','T','feat','feat/s','main','/w/s','active',NULL,'disabled','t','t')",
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
