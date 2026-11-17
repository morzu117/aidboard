import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runMem } from '../src/cli/commands/mem.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { issueRunToken } from '../src/daemon/security.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';
import { sh } from './helpers/git.js';

let t: TestDaemon | undefined;
afterEach(async () => {
  if (!t) return;
  await t.d.stop();
  rmSync(t.home, { recursive: true, force: true });
  t = undefined;
});

async function put(slug: string, text = 'contenu') {
  const response = await t!.d.app.inject({
    method: 'PUT',
    url: `/api/memory/pages/${slug}`,
    headers: t!.headers,
    payload: { text },
  });
  expect(response.statusCode).toBe(201);
}
const purge = (payload: unknown, headers = t!.headers) =>
  t!.d.app.inject({ method: 'POST', url: '/api/memory/purge', headers, payload: payload as never });
const slugs = async () =>
  (
    await t!.d.app.inject({
      method: 'GET',
      url: '/api/memory/pages',
      headers: t!.headers,
    })
  ).json().slugs as string[];

async function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMem(['purge', ...args], resolvePaths(t!.home), {
    stdin: async () => '',
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: {},
  });
  return { code, out, err };
}

test('DM17 : citation entière, même namespace, tous les cycles et aucune autre page', async () => {
  t = await startTestDaemon();
  for (const slug of [
    'a/plan/alpha',
    'a/dev-handoff/alpha',
    'a/review/alpha',
    'b/plan/alpha',
    'a/plan/beta',
    'a/plan/gamma',
    'a/plan/delta',
    'a/plan/epsilon',
    'a/plan/task.v1',
    'a/plan/taskxv1',
    'a/plan/zeta',
    'a/plan/eta',
    'a/plan/theta',
    'a/plan/iota',
    'a/notes/alpha',
    'lesson/conseil',
  ])
    await put(slug);
  await put('a/retro/nuit', 'alpha\n(beta), pré-gamma-post delta-plus epsilon2 task.v1 zeta');
  await put('a/retro/autre', 'eta');
  await put('b/retro/nuit', 'iota');
  await put('a/retro/nuit/note', 'theta');
  const before = await slugs();
  const expected = [
    'a/dev-handoff/alpha',
    'a/plan/alpha',
    'a/plan/beta',
    'a/plan/eta',
    'a/plan/task.v1',
    'a/plan/zeta',
    'a/review/alpha',
  ];
  const preview = await purge({ dryRun: true });
  expect(preview.statusCode).toBe(200);
  expect(preview.json().slugs).toEqual(expected);
  expect(await slugs()).toEqual(before);
  const orphaned = await purge({ orphelines: true, dryRun: false });
  expect(orphaned.json()).toMatchObject({
    dryRun: true,
    tasks: ['a/delta', 'a/epsilon', 'a/gamma', 'a/iota', 'a/taskxv1', 'a/theta', 'b/alpha'],
  });
  expect(await slugs()).toEqual(before);
  const removed = await purge({});
  expect(removed.json().slugs).toEqual(expected);
  expect(await slugs()).toEqual(before.filter((slug) => !expected.includes(slug)));
  for (const slug of expected) expect(existsSync(join(t.home, 'memory', `${slug}.md`))).toBe(false);
  expect((await purge({})).json().slugs).toEqual([]);
});

test('DM17 : CLI aperçu, orphelines et purge ; historique git conservé', async () => {
  t = await startTestDaemon();
  await put('aid/plan/close');
  await put('aid/retro/nuit', 'close');
  await put('aid/review/ouverte');
  const before = await slugs();
  expect(await cli(['--dry-run'])).toEqual({
    code: 0,
    err: [],
    out: ['aid/plan/close', '1 page(s) à purger'],
  });
  expect(await cli(['--orphelines'])).toEqual({
    code: 0,
    err: [],
    out: ['aid/ouverte', '1 tâche(s) orpheline(s)'],
  });
  expect(await cli(['--orphelines', '--dry-run'])).toEqual(await cli(['--orphelines']));
  expect(await slugs()).toEqual(before);
  // Arrêter le daemon force le commit différé avant de tester l'historique de suppression.
  const home = t.home;
  await t.d.stop();
  const root = join(home, 'memory');
  const original = sh(root, 'rev-parse', 'HEAD').trim();
  t = await startTestDaemon(home);
  expect(await cli([])).toEqual({
    code: 0,
    err: [],
    out: ['aid/plan/close', '1 page(s) purgée(s)'],
  });
  expect(await cli([])).toEqual({ code: 0, err: [], out: ['0 page(s) purgée(s)'] });
  await t.d.stop();
  t = undefined;
  try {
    expect(sh(root, 'show', `${original}:aid/plan/close.md`)).toContain('contenu');
    expect(sh(root, 'log', '--format=%s%n%b')).toContain('aid/plan/close supprimée');
    expect(existsSync(join(root, 'aid/plan/close.md'))).toBe(false);
    expect(readFileSync(join(root, 'aid/retro/nuit.md'), 'utf8')).toContain('close');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('DM17 : route réservée admin et corps invalide refusé sans suppression', async () => {
  t = await startTestDaemon();
  await put('a/plan/close');
  await put('a/retro/nuit', 'close');
  seedTopic(t.db);
  const headers = { ...t.headers, authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}` };
  for (const payload of [{}, { dryRun: true }, { orphelines: true }]) {
    expect((await purge(payload, headers)).statusCode).toBe(403);
  }
  expect((await purge({ dryRun: {} })).statusCode).toBe(400);
  expect(await slugs()).toContain('a/plan/close');
});
