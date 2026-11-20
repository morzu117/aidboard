import { rmSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { runMem } from '../src/cli/commands/mem.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { runWriteContext } from '../src/daemon/routes/memory.js';
import { issueRunToken } from '../src/daemon/security.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon | undefined;
afterEach(async () => {
  if (!t) return;
  await t.d.stop();
  rmSync(t.home, { recursive: true, force: true });
  t = undefined;
});

async function put(slug: string) {
  const response = await t!.d.app.inject({
    method: 'PUT',
    url: `/api/memory/pages/${slug}`,
    headers: t!.headers,
    payload: { text: '# Mémoire\n\nlecture commune' },
  });
  expect(response.statusCode).toBe(201);
}

const get = (url: string, headers = t!.headers) => t!.d.app.inject({ url, headers });
const rows = () => t!.db.prepare('SELECT * FROM memory_usage ORDER BY rowid').all();

async function cli(args: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMem(['usage', ...args], resolvePaths(t!.home), {
    stdin: async () => '',
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: {},
  });
  return { code, out, err };
}

test('DM18 : uniquement les GET réussis et chaque hit rendu, après scope et limite', async () => {
  t = await startTestDaemon();
  await put('aid/plan/a');
  await put('aid/plan/b');
  await put('autre/plan/c');
  const store = new MemoryStore(t.db);
  store.get('aid/plan/a');
  store.searchFts('lecture', 'all', 10);
  await get('/api/memory/pages');
  expect((await get('/api/memory/pages/aid/absente')).statusCode).toBe(404);
  expect((await get('/api/memory/pages/Invalide')).statusCode).toBe(400);
  expect((await get('/api/memory/search')).statusCode).toBe(400);
  expect((await get('/api/memory/search?q=introuvable')).json().hits).toEqual([]);
  expect(rows()).toEqual([]);

  seedTopic(t.db);
  t.db.prepare("UPDATE agents SET role = 'dev' WHERE id = 'ag_1'").run();
  const runHeaders = { ...t.headers, authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}` };
  const before = new Date().toISOString();
  expect((await get('/api/memory/pages/aid/plan/a', runHeaders)).statusCode).toBe(200);
  const search = await get('/api/memory/search?q=lecture&scope=aid&limit=1', runHeaders);
  expect(search.statusCode).toBe(200);
  expect(search.json().hits).toHaveLength(1);
  expect(search.json().hits[0].slug).toMatch(/^aid\//);
  expect(rows()).toEqual([
    { slug: 'aid/plan/a', op: 'get', role: 'dev', at: expect.any(String) },
    { slug: search.json().hits[0].slug, op: 'search', role: 'dev', at: expect.any(String) },
  ]);
  const all = await get('/api/memory/search?q=lecture');
  const hits = all.json().hits as Array<{ slug: string }>;
  expect(hits).toHaveLength(3);
  expect(rows().slice(2)).toEqual(
    hits.map(({ slug }) => ({ slug, op: 'search', role: null, at: expect.any(String) })),
  );
  for (const row of rows() as Array<{ at: string }>) {
    expect(row.at >= before).toBe(true);
    expect(row.at <= new Date().toISOString()).toBe(true);
  }
  expect((await get('/api/memory/usage', runHeaders)).statusCode).toBe(403);
  expect(rows()).toHaveLength(5);
});

test('DM18 : bilan et CLI texte/JSON, persistance après suppression et redémarrage', async () => {
  t = await startTestDaemon();
  expect(await cli()).toEqual({ code: 0, err: [], out: ['aucune lecture'] });
  expect(await cli(['--json'])).toEqual({ code: 0, err: [], out: ['{"pages":[]}'] });
  await put('aid/plan/a');
  await put('aid/plan/b');
  await put('aid/plan/jamais-lue');
  await get('/api/memory/search?q=lecture&limit=100');
  await get('/api/memory/pages/aid/plan/b');
  await get('/api/memory/pages/aid/plan/b');
  const last = (rows().at(-1) as { at: string }).at;
  const pages = (await get('/api/memory/usage')).json().pages;
  expect(pages).toEqual([
    { slug: 'aid/plan/b', reads: 3, lastReadAt: last },
    { slug: 'aid/plan/a', reads: 1, lastReadAt: expect.any(String) },
    { slug: 'aid/plan/jamais-lue', reads: 1, lastReadAt: expect.any(String) },
  ]);
  expect(await cli(['--json'])).toEqual({ code: 0, err: [], out: [JSON.stringify({ pages })] });
  expect(await cli()).toEqual({
    code: 0,
    err: [],
    out: pages.map(
      (p: { slug: string; reads: number; lastReadAt: string }) =>
        `${p.reads}  ${p.lastReadAt}  ${p.slug}`,
    ),
  });
  const removed = await t.d.app.inject({
    method: 'DELETE',
    url: '/api/memory/pages/aid/plan/b',
    headers: t.headers,
  });
  expect(removed.statusCode).toBe(200);
  const home = t.home;
  await t.d.stop();
  t = await startTestDaemon(home);
  expect((await get('/api/memory/usage')).json()).toEqual({ pages });
  expect(rows()).toHaveLength(5);
  expect((await get('/api/memory/pages/aid/plan/a')).statusCode).toBe(200);
  expect(rows()).toHaveLength(6);
});

test('57.11 : premier agent du run, puis lectures admin sans rôle', async () => {
  t = await startTestDaemon();
  await put('aid/plan/a');
  seedTopic(t.db);
  t.db
    .prepare("UPDATE agents SET role = 'dev', created_at = ? WHERE id = 'ag_1'")
    .run('2026-01-01T00:00:00.000Z');
  t.db
    .prepare(
      `INSERT INTO agents (id, run_id, kind, role, transport, status, cwd, command, created_at, updated_at)
     VALUES ('ag_2', 'run_1', 'shell', 'review', 'pty', 'exited', '/w/s', '[]', ?, ?)`,
    )
    .run('2025-12-31T23:59:59.000Z', '2026-01-01T00:00:01.000Z');
  const runHeaders = { ...t.headers, authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}` };
  for (const headers of [runHeaders, t.headers]) {
    expect((await get('/api/memory/pages/aid/plan/a', headers)).statusCode).toBe(200);
    expect((await get('/api/memory/search?q=lecture', headers)).json().hits).toHaveLength(1);
  }
  expect(rows()).toEqual(
    ['review', null].flatMap((role) =>
      ['get', 'search'].map((op) => ({ slug: 'aid/plan/a', op, role, at: expect.any(String) })),
    ),
  );
  expect(t.db.prepare("PRAGMA index_info('memory_usage_slug')").all()).toEqual([
    expect.objectContaining({ name: 'slug' }),
  ]);
});

test('57.11 : à date égale, l’identifiant départage le rôle de lecture et d’écriture', async () => {
  t = await startTestDaemon();
  await put('aid/plan/a');
  seedTopic(t.db);
  t.db.exec(`UPDATE agents SET role = 'dev' WHERE id = 'ag_1';
    INSERT INTO agents (id, run_id, kind, role, transport, status, cwd, command, created_at, updated_at)
    SELECT 'ag_0', run_id, kind, 'retro', transport, status, cwd, command, created_at, updated_at
    FROM agents WHERE id = 'ag_1';`);

  new MemoryStore(t.db).recordUsage(['aid/plan/a'], 'get', 'run_1');
  expect(rows()).toEqual([expect.objectContaining({ role: 'retro' })]);
  // Seul le rôle retro donne accès en écriture à lesson/ hors du namespace du run.
  expect(runWriteContext(t.db, { kind: 'run', runId: 'run_1' }, 'lesson/test')).toMatchObject({
    author: 'run:run_1',
  });
});

test('57.11 : les lectures d’un run sans agent sont journalisées sans rôle', async () => {
  t = await startTestDaemon();
  await put('aid/plan/a');
  seedTopic(t.db);
  t.db.prepare("DELETE FROM agents WHERE run_id = 'run_1'").run();
  const runHeaders = { ...t.headers, authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}` };
  expect((await get('/api/memory/pages/aid/plan/a', runHeaders)).statusCode).toBe(200);
  expect((await get('/api/memory/search?q=lecture', runHeaders)).json().hits).toHaveLength(1);
  expect(rows()).toEqual([
    { slug: 'aid/plan/a', op: 'get', role: null, at: expect.any(String) },
    { slug: 'aid/plan/a', op: 'search', role: null, at: expect.any(String) },
  ]);
});

test('57.11 : un échec du journal est logué sans casser get ni search', async () => {
  t = await startTestDaemon();
  await put('aid/plan/a');
  const log = vi.spyOn(t.d.app.log, 'error').mockImplementation(() => {});
  try {
    t.db.exec(`CREATE TRIGGER refuse_usage BEFORE INSERT ON memory_usage
      BEGIN SELECT RAISE(ABORT, 'journal indisponible'); END`);
    const page = await get('/api/memory/pages/aid/plan/a');
    expect(page.statusCode).toBe(200);
    expect(page.json().slug).toBe('aid/plan/a');
    const search = await get('/api/memory/search?q=lecture');
    expect(search.statusCode).toBe(200);
    expect(search.json().hits.map((hit: { slug: string }) => hit.slug)).toEqual(['aid/plan/a']);
    expect(rows()).toEqual([]);
    expect(log).toHaveBeenCalledTimes(2);
    for (const call of log.mock.calls) {
      expect(call).toEqual([
        { err: expect.objectContaining({ message: 'journal indisponible' }) },
        "mémoire : écriture du journal d'usage impossible",
      ]);
    }
  } finally {
    log.mockRestore();
  }
});
