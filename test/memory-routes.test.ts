import WebSocket from 'ws';
import { afterEach, expect, test } from 'vitest';
import { issueRunToken } from '../src/daemon/security.js';
import { seedTopic, startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const runHeaders = (runId: string) => ({
  host: t.headers.host!,
  authorization: `Bearer ${issueRunToken(t.d.auth, runId)}`,
});

const put = (slug: string, body: unknown, headers = t.headers) =>
  t.d.app.inject({
    method: 'PUT',
    url: `/api/memory/pages/${slug}`,
    headers,
    payload: body as never,
  });
const get = (slug: string, headers = t.headers) =>
  t.d.app.inject({ method: 'GET', url: `/api/memory/pages/${slug}`, headers });
const del = (slug: string, headers = t.headers) =>
  t.d.app.inject({ method: 'DELETE', url: `/api/memory/pages/${slug}`, headers });

// Un run dont le workspace a le namespace `a` (son nom) et un agent du rôle donné.
function seedRun(role: string, namespace: string | null = null) {
  seedTopic(t.db);
  t.db.prepare("UPDATE agents SET role = ? WHERE id = 'ag_1'").run(role);
  t.db.prepare("UPDATE workspaces SET namespace = ? WHERE id = 'ws_1'").run(namespace);
}

test('admin : création 201, lecture, mise à jour 200, liste, suppression, 404 ensuite', async () => {
  t = await startTestDaemon();
  const c = await put('aid/plan/alpha', { text: '# Alpha\n\ncorps' });
  expect(c.statusCode).toBe(201);
  expect(c.json()).toEqual({ slug: 'aid/plan/alpha', revision: 1 });
  const r = await get('aid/plan/alpha');
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({
    slug: 'aid/plan/alpha',
    title: 'Alpha',
    revision: 1,
    author: 'admin',
  });
  expect((await put('aid/plan/alpha', { text: '## Suite', mode: 'append' })).statusCode).toBe(200);
  expect((await get('aid/plan/alpha')).json().body).toBe('# Alpha\n\ncorps\n\n## Suite');
  await put('aid/review/alpha', { text: 'r' });
  const list = await t.d.app.inject({
    url: '/api/memory/pages?prefix=aid/plan/',
    headers: t.headers,
  });
  expect(list.json()).toEqual({ slugs: ['aid/plan/alpha'] });
  expect((await del('aid/plan/alpha')).statusCode).toBe(200);
  expect((await get('aid/plan/alpha')).statusCode).toBe(404);
  expect((await del('aid/plan/alpha')).statusCode).toBe(404);
});

test('PUT sans mode sur une page existante : 409 avec la révision ; replace exige expectedRevision', async () => {
  t = await startTestDaemon();
  await put('aid/plan/x', { text: 'v1' });
  await put('aid/plan/x', { text: 'v2', mode: 'force' });
  const r = await put('aid/plan/x', { text: 'v3' });
  expect(r.statusCode).toBe(409);
  expect(r.json()).toEqual({ error: 'revision_conflict', revision: 2 });
  expect(
    (await put('aid/plan/x', { text: 'v3', mode: 'replace', expectedRevision: 1 })).statusCode,
  ).toBe(409);
  expect(
    (await put('aid/plan/x', { text: 'v3', mode: 'replace', expectedRevision: 2 })).statusCode,
  ).toBe(200);
  expect((await put('aid/plan/x', { text: 'v4', mode: 'replace' })).statusCode).toBe(400);
  expect((await put('aid/plan/x', { text: 'v4', mode: 'force', extra: 1 })).statusCode).toBe(400);
});

test('slug invalide : 400 qui nomme la règle, en GET comme en PUT', async () => {
  t = await startTestDaemon();
  const r = await get('Plan');
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toContain('segments [a-z0-9._-]');
  expect((await put('aid/Plan', { text: 'x' })).statusCode).toBe(400);
  expect((await put('aid/plan/x', { text: '---\nchaîne\n---\n' })).statusCode).toBe(400);
});

test('token de run : lit tout, écrit dans son namespace, 403 ailleurs', async () => {
  t = await startTestDaemon();
  seedRun('dev');
  const h = runHeaders('run_1');
  await put('autre/plan/x', { text: 'admin' });
  expect((await get('autre/plan/x', h)).statusCode).toBe(200);
  const ok = await put('a/plan/s', { text: '## Plan' }, h);
  expect(ok.statusCode).toBe(201);
  expect((await get('a/plan/s', h)).json().author).toBe('run:run_1');
  const no = await put('autre/plan/x', { text: 'pirate', mode: 'force' }, h);
  expect(no.statusCode).toBe(403);
  expect(no.json()).toEqual({ error: 'forbidden', namespace: 'autre', allowed: 'a' });
  expect((await del('autre/plan/x', h)).statusCode).toBe(403);
  expect((await get('autre/plan/x')).json().body).toBe('admin');
  const search = await t.d.app.inject({ url: '/api/memory/search?q=admin', headers: h });
  expect(search.statusCode).toBe(200);
  expect(search.json()).toMatchObject({ mode: 'fts', hits: [{ slug: 'autre/plan/x' }] });
});

test('le namespace du workspace prime sur son nom pour un token de run', async () => {
  t = await startTestDaemon();
  seedRun('dev', 'projet');
  const h = runHeaders('run_1');
  expect((await put('projet/plan/s', { text: 'x' }, h)).statusCode).toBe(201);
  expect((await put('a/plan/s', { text: 'x' }, h)).statusCode).toBe(403);
});

test('lesson/ : seul un agent du rôle retro y écrit ; token d’un run inconnu : 403', async () => {
  t = await startTestDaemon();
  seedRun('dev');
  expect((await put('lesson/git/x', { text: 'l' }, runHeaders('run_1'))).statusCode).toBe(403);
  t.db.prepare("UPDATE agents SET role = 'retro' WHERE id = 'ag_1'").run();
  expect((await put('lesson/git/x', { text: 'l' }, runHeaders('run_1'))).statusCode).toBe(201);
  expect((await put('a/plan/x', { text: 'l' }, runHeaders('run_absent'))).statusCode).toBe(403);
});

test('reindex, export, import et health : admin seulement', async () => {
  t = await startTestDaemon();
  seedRun('retro');
  const h = runHeaders('run_1');
  for (const url of ['/api/memory/reindex', '/api/memory/export', '/api/memory/import']) {
    const r = await t.d.app.inject({ method: 'POST', url, headers: h, payload: { dir: '/x' } });
    expect(r.statusCode, url).toBe(403);
  }
  expect((await t.d.app.inject({ url: '/api/memory/health', headers: h })).statusCode).toBe(403);
  await put('aid/plan/x', { text: 'x' });
  await put('lesson/l/y', { text: 'y' });
  const health = await t.d.app.inject({ url: '/api/memory/health', headers: t.headers });
  expect(health.json()).toMatchObject({
    pages: { aid: 1, lesson: 1 },
    fts: true,
    vectors: 'off',
    pendingJobs: 0,
    failedJobs: 0,
  });
  const re = await t.d.app.inject({
    method: 'POST',
    url: '/api/memory/reindex',
    headers: t.headers,
  });
  expect(re.json()).toEqual({ pages: 2 });
  expect((await get('aid/plan/x')).json().author).toBe('reindex');
});

test('l’événement memory.page arrive sur /ws/events', async () => {
  t = await startTestDaemon();
  const ws = new WebSocket(`ws://127.0.0.1:${t.d.port}/ws/events`, {
    headers: { ...t.headers, origin: `http://127.0.0.1:${t.d.port}` },
  });
  const got: Array<{ type: string; data: Record<string, unknown> }> = [];
  ws.on('message', (m) => {
    const msg = JSON.parse(String(m)) as {
      kind: string;
      event?: { type: string; data: Record<string, unknown> };
    };
    if (msg.kind === 'event' && msg.event) got.push(msg.event);
  });
  await new Promise<void>((r) => ws.once('open', () => r()));
  await put('aid/plan/x', { text: 'x' });
  const e = await waitFor(() => got.find((x) => x.type === 'memory.page'), 5000, 'memory.page');
  expect(e.data).toEqual({ slug: 'aid/plan/x', revision: 1, author: 'admin', op: 'put' });
  ws.close();
});
