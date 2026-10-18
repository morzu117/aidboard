import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadSessionToken, SESSION_MAX_AGE_S, writeSessionToken } from '../src/daemon/security.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
});

const host = (d: TestDaemon) => `127.0.0.1:${d.d.port}`;
const asCookie = (d: TestDaemon, token: string) =>
  d.d.app.inject({ url: '/api/state', headers: { host: host(d), cookie: `aid_session=${token}` } });

test('loadSessionToken : créé en 0600 au premier appel, relu tel quel ensuite', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'aid-sess-')), 'session.secret');
  const first = loadSessionToken(file);
  expect(first.length).toBeGreaterThanOrEqual(32);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(loadSessionToken(file)).toBe(first);
});

test('loadSessionToken : un fichier tronqué ou vide est remplacé, pas accepté', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'aid-sess-')), 'session.secret');
  writeFileSync(file, 'court');
  const token = loadSessionToken(file);
  expect(token).not.toBe('court');
  expect(readFileSync(file, 'utf8')).toBe(token);
});

test('writeSessionToken : remet le fichier en 0600 même s’il existait plus ouvert', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'aid-sess-')), 'session.secret');
  writeFileSync(file, 'x', { mode: 0o644 });
  writeSessionToken(file);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test('/?token= pose un cookie persistant portant le jeton de session, jamais le jeton admin', async () => {
  t = await startTestDaemon();
  const r = await t.d.app.inject({
    url: `/?token=${t.d.auth.adminToken}`,
    headers: { host: host(t) },
  });
  expect(r.statusCode).toBe(303);
  const set = String(r.headers['set-cookie']);
  expect(set).toContain(`aid_session=${t.d.auth.sessionToken}`);
  expect(set).not.toContain(t.d.auth.adminToken);
  expect(set).toContain(`Max-Age=${SESSION_MAX_AGE_S}`);
  expect((await asCookie(t, t.d.auth.adminToken)).statusCode).toBe(401);
});

test('la session navigateur survit à un redémarrage du daemon, le jeton admin non', async () => {
  t = await startTestDaemon();
  const { home } = t;
  const session = t.d.auth.sessionToken;
  const admin = t.d.auth.adminToken;
  expect((await asCookie(t, session)).statusCode).toBe(200);
  await t.d.stop();

  t = await startTestDaemon(home);
  expect(t.d.auth.sessionToken).toBe(session);
  expect(t.d.auth.adminToken).not.toBe(admin);
  expect((await asCookie(t, session)).statusCode).toBe(200);
});

test('POST /api/session/reset : l’ancien cookie est refusé, le nouveau secret est écrit et persiste', async () => {
  t = await startTestDaemon();
  const { home } = t;
  const before = t.d.auth.sessionToken;
  const r = await t.d.app.inject({ method: 'POST', url: '/api/session/reset', headers: t.headers });
  expect(r.statusCode).toBe(204);
  const after = t.d.auth.sessionToken;
  expect(after).not.toBe(before);
  expect(readFileSync(join(home, 'session.secret'), 'utf8')).toBe(after);
  expect((await asCookie(t, before)).statusCode).toBe(401);
  expect((await asCookie(t, after)).statusCode).toBe(200);

  await t.d.stop();
  t = await startTestDaemon(home);
  expect(t.d.auth.sessionToken).toBe(after);
});

test('POST /api/session/reset : refusé à un jeton de run', async () => {
  t = await startTestDaemon();
  t.d.auth.runTokens.set('r'.repeat(32), 'run_x');
  const r = await t.d.app.inject({
    method: 'POST',
    url: '/api/session/reset',
    headers: { host: host(t), authorization: `Bearer ${'r'.repeat(32)}` },
  });
  expect(r.statusCode).toBe(403);
});
