import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

const daemons: TestDaemon[] = [];
afterEach(async () => {
  for (const t of daemons.splice(0)) await t.d.stop();
});

async function boot(): Promise<TestDaemon> {
  const t = await startTestDaemon();
  daemons.push(t);
  return t;
}
const put = (t: TestDaemon, slug: string, text: string) =>
  t.d.app.inject({
    method: 'PUT',
    url: `/api/memory/pages/${slug}`,
    headers: t.headers,
    payload: { text },
  });
const post = (t: TestDaemon, path: string, payload: unknown) =>
  t.d.app.inject({ method: 'POST', url: path, headers: t.headers, payload: payload as never });

test('export d’un scope puis import dans un daemon vide : mêmes pages, mêmes frontmatters', async () => {
  const a = await boot();
  await put(a, 'aid/plan/x', '---\ntags: [plan]\ntitle: X\n---\n\ncorps x');
  await put(a, 'lesson/git/y', '# Y\n\ncorps y');
  await put(a, 'autre/plan/z', 'corps z');
  const dir = mkdtempSync(join(tmpdir(), 'aid-exp-'));
  const exp = await post(a, '/api/memory/export', { dir, scope: 'aid' });
  expect(exp.json()).toEqual({ pages: 2 });
  expect(readFileSync(join(dir, 'aid/plan/x.md'), 'utf8')).toBe(
    '---\ntags:\n  - plan\ntitle: X\n---\n\ncorps x\n',
  );
  expect(existsSync(join(dir, 'autre/plan/z.md'))).toBe(false);

  const b = await boot();
  expect((await post(b, '/api/memory/import', { dir })).json()).toEqual({
    imported: 2,
    skipped: [],
    failed: [],
  });
  const x = await b.d.app.inject({ url: '/api/memory/pages/aid/plan/x', headers: b.headers });
  expect(x.json()).toMatchObject({
    title: 'X',
    frontmatter: { tags: ['plan'], title: 'X' },
    body: 'corps x',
    author: 'import',
    revision: 1,
  });
  expect(existsSync(join(b.home, 'memory', 'lesson', 'git', 'y.md'))).toBe(true);

  // existantes : sautées, rien n'est écrit
  await put(b, 'aid/plan/x', 'ne doit pas passer').then((r) => expect(r.statusCode).toBe(409));
  expect((await post(b, '/api/memory/import', { dir })).json()).toEqual({
    imported: 0,
    skipped: ['aid/plan/x', 'lesson/git/y'],
    failed: [],
  });
  expect(
    (await b.d.app.inject({ url: '/api/memory/pages/aid/plan/x', headers: b.headers })).json()
      .revision,
  ).toBe(1);
});

test('import avec --namespace préfixe les slugs ; namespace invalide : 400', async () => {
  const t = await boot();
  const dir = mkdtempSync(join(tmpdir(), 'aid-imp-'));
  writeFileSync(join(dir, 'une-lecon.md'), '# Leçon\n');
  expect((await post(t, '/api/memory/import', { dir, namespace: 'Bad' })).statusCode).toBe(400);
  expect((await post(t, '/api/memory/import', { dir, namespace: 'lesson' })).json()).toEqual({
    imported: 1,
    skipped: [],
    failed: [],
  });
  expect((await post(t, '/api/memory/import', { dir })).json()).toEqual({
    imported: 0,
    skipped: [],
    failed: ['une-lecon'],
  });
  const list = await t.d.app.inject({
    url: '/api/memory/pages?prefix=lesson/',
    headers: t.headers,
  });
  expect(list.json()).toEqual({ slugs: ['lesson/une-lecon'] });
});
