import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, test } from 'vitest';
import { openDb, type Db } from '../src/daemon/db.js';
import { AidHttpError } from '../src/daemon/errors.js';
import { registerDaemonRoutes } from '../src/daemon/routes/daemon.js';
import { seedTopic } from './helpers/daemon.js';

let app: FastifyInstance | undefined;
let db: Db | undefined;
afterEach(async () => {
  await app?.close();
  db?.close();
  app = undefined;
  db = undefined;
});

function makeApp(opts: { requestUpdate?: () => void; withAgent?: boolean } = {}): FastifyInstance {
  const home = mkdtempSync(join(tmpdir(), 'aid-dr-'));
  db = openDb(join(home, 'state.db'));
  if (opts.withAgent) seedTopic(db);
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AidHttpError)
      return reply.code(err.status).send({ error: err.message, ...err.extra });
    return reply.code(500).send({ error: (err as Error).message });
  });
  registerDaemonRoutes(app, { db, requestStop: () => {}, requestUpdate: opts.requestUpdate });
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
