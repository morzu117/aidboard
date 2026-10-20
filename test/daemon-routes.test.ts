import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, test } from 'vitest';
import { openDb, type Db } from '../src/daemon/db.js';
import { AidHttpError } from '../src/daemon/errors.js';
import { registerDaemonRoutes } from '../src/daemon/routes/daemon.js';
import { seedTopic } from './helpers/daemon.js';
import type { UpdateStatus } from '../src/daemon/updateCheck.js';
import type { InstallMode, UpdateInfo } from '../src/shared/model.js';

let app: FastifyInstance | undefined;
let db: Db | undefined;
afterEach(async () => {
  await app?.close();
  db?.close();
  app = undefined;
  db = undefined;
});

function makeApp(
  opts: {
    requestUpdate?: () => void;
    requestCycle?: () => void;
    withAgent?: boolean;
    updateError?: () => string | null;
    updates?: () => UpdateStatus | null;
    install?: () => { mode: InstallMode; version: string };
  } = {},
): FastifyInstance {
  const home = mkdtempSync(join(tmpdir(), 'aid-dr-'));
  db = openDb(join(home, 'state.db'));
  if (opts.withAgent) seedTopic(db);
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AidHttpError)
      return reply.code(err.status).send({ error: err.message, ...err.extra });
    return reply.code(500).send({ error: (err as Error).message });
  });
  registerDaemonRoutes(app, {
    db,
    requestStop: () => {},
    requestUpdate: opts.requestUpdate,
    requestCycle: opts.requestCycle,
    updateError: opts.updateError,
    updates: opts.updates,
    install: opts.install,
  });
  return app;
}

test('POST /api/daemon/update : 501 quand aucune mise à jour n’est câblée (pas de dépôt résolu)', async () => {
  const a = makeApp();
  const res = await a.inject({ method: 'POST', url: '/api/daemon/update', payload: {} });
  expect(res.statusCode).toBe(501);
});

test('POST /api/daemon/update : refuse (409) si un agent tourne, sans déclencher la mise à jour', async () => {
  let called = false;
  const a = makeApp({ requestUpdate: () => (called = true), withAgent: true });
  const res = await a.inject({ method: 'POST', url: '/api/daemon/update', payload: {} });
  expect(res.statusCode).toBe(409);
  expect((res.json() as { agents: unknown[] }).agents).toHaveLength(1);
  expect(called).toBe(false);
});

test('POST /api/daemon/update : sans agent vivant, se déclenche directement', async () => {
  let called = false;
  const a = makeApp({ requestUpdate: () => (called = true) });
  const res = await a.inject({ method: 'POST', url: '/api/daemon/update', payload: {} });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toEqual({ updating: true, agents: 0 });
  await new Promise((r) => setImmediate(r));
  expect(called).toBe(true);
});

test('GET /api/daemon/update : porte lastError quand la dernière tentative a échoué', async () => {
  const a = makeApp({ updateError: () => 'mise à jour échouée (pull) : divergent' });
  const res = await a.inject({ method: 'GET', url: '/api/daemon/update' });
  expect(res.statusCode).toBe(200);
  expect((res.json() as { lastError: string | null }).lastError).toBe(
    'mise à jour échouée (pull) : divergent',
  );
});

test('GET /api/daemon/update : lastError à null sans échec connu', async () => {
  const a = makeApp();
  const res = await a.inject({ method: 'GET', url: '/api/daemon/update' });
  expect((res.json() as { lastError: string | null }).lastError).toBeNull();
});

test('POST /api/daemon/cycle : 501 quand aucun cycle n’est câblé', async () => {
  const a = makeApp();
  const res = await a.inject({ method: 'POST', url: '/api/daemon/cycle' });
  expect(res.statusCode).toBe(501);
});

test('POST /api/daemon/cycle : se déclenche même avec un agent vivant, sans jamais refuser', async () => {
  let called = false;
  const a = makeApp({ requestCycle: () => (called = true), withAgent: true });
  const res = await a.inject({ method: 'POST', url: '/api/daemon/cycle' });
  expect(res.statusCode).toBe(202);
  await new Promise((r) => setImmediate(r));
  expect(called).toBe(true);
});

test('POST /api/daemon/update : --force déclenche la mise à jour malgré un agent vivant', async () => {
  let called = false;
  const a = makeApp({ requestUpdate: () => (called = true), withAgent: true });
  const res = await a.inject({
    method: 'POST',
    url: '/api/daemon/update',
    payload: { force: true },
  });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toEqual({ updating: true, agents: 1 });
  await new Promise((r) => setImmediate(r));
  expect(called).toBe(true);
});

test('GET /api/daemon/update (13.2) : mode, version, et latest = sha d’origin/main en mode repo', async () => {
  const a = makeApp({
    install: () => ({ mode: 'repo', version: '0.1.0' }),
    updates: () => ({ available: true, localSha: 'aaa', remoteSha: '1234567deadbeef' }),
  });
  const res = await a.inject({ method: 'GET', url: '/api/daemon/update' });
  expect(res.json() as UpdateInfo).toEqual({
    mode: 'repo',
    version: '0.1.0',
    available: true,
    latest: '1234567deadbeef',
    lastError: null,
  });
});

test('GET /api/daemon/update (13.2) : à jour → latest null ; sans câblage → inconnu, jamais disponible', async () => {
  const a = makeApp({
    install: () => ({ mode: 'release', version: '0.2.0' }),
    updates: () => ({ available: false, localSha: 'aaa', remoteSha: 'aaa' }),
  });
  const r1 = (await a.inject({ method: 'GET', url: '/api/daemon/update' })).json() as UpdateInfo;
  expect(r1).toMatchObject({ mode: 'release', version: '0.2.0', available: false, latest: null });
  await a.close();
  const b = makeApp();
  const r2 = (await b.inject({ method: 'GET', url: '/api/daemon/update' })).json() as UpdateInfo;
  expect(r2).toEqual({
    mode: 'inconnu',
    version: '0.0.0',
    available: false,
    latest: null,
    lastError: null,
  });
});
