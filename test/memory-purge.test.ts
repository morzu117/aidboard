import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { runMem } from '../src/cli/commands/mem.js';
import { MemoryMirror } from '../src/daemon/memory/mirror.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { issueRunToken } from '../src/daemon/security.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';
import { sh } from './helpers/git.js';

let t: TestDaemon | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
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
  expect(removed.json().tasks).toEqual(preview.json().tasks);
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

test('aid mem purge conserve une décision portant le même slug que la tâche purgée', async () => {
  t = await startTestDaemon();
  await put('projet/plan/alpha');
  await put('projet/retro/nuit', 'alpha');
  const { slug } = await t.d.memory.decide(
    { namespace: 'projet', slug: 'alpha', title: 'Choix', raison: 'Motif', remplace: [] },
    { author: 'admin' },
  );
  expect(await cli([])).toEqual({
    code: 0,
    err: [],
    out: ['projet/plan/alpha', '1 page(s) purgée(s)'],
  });
  expect(await slugs()).toEqual([slug, 'projet/retro/nuit']);
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

test('DM17 : lesson ne figure ni dans les cycles ni dans les orphelines et reste intact', async () => {
  t = await startTestDaemon();
  await put('lesson/review/x');
  await put('lesson/retro/y', 'x');
  await put('lesson/plan/ouverte');
  const before = await slugs();
  for (const options of [{ dryRun: true }, { orphelines: true }, {}]) {
    const response = await purge(options);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tasks: [], slugs: [] });
    expect(await slugs()).toEqual(before);
  }
});

test.each([
  ['task_alpha', false],
  ['alphaZ', false],
  ['Xalpha', false],
  ['alphaX', false],
  ['alpha_suffix', false],
  ['alpha.', true],
  ['(alpha)', true],
])('DM17 : borne de citation %s → %s', async (citation, closed) => {
  t = await startTestDaemon();
  await put('a/plan/alpha');
  await put('a/retro/nuit', citation);
  expect((await purge({ dryRun: true })).json().slugs).toEqual(closed ? ['a/plan/alpha'] : []);
  expect((await purge({ orphelines: true })).json().slugs).toEqual(closed ? [] : ['a/plan/alpha']);
});

test('DM17 : une citation uniquement dans le frontmatter clôt la tâche', async () => {
  t = await startTestDaemon();
  await put('a/plan/alpha');
  await put('a/retro/nuit', '---\ntasks: [alpha]\n---\nBilan sans citation dans le corps.');
  expect((await purge({})).json().slugs).toEqual(['a/plan/alpha']);
  expect(await slugs()).toEqual(['a/retro/nuit']);
});

test('DM17 : la route ne retourne que les pages retirées malgré une disparition', async () => {
  t = await startTestDaemon();
  await put('a/plan/alpha');
  await put('a/review/alpha');
  await put('a/review/beta');
  await put('a/retro/nuit', 'alpha beta');
  expect(
    [...t.d.memory.store.all()]
      .filter(({ slug }) => !slug.includes('/retro/'))
      .map(({ slug }) => slug),
  ).toEqual(['a/plan/alpha', 'a/review/alpha', 'a/review/beta']);
  const remove = MemoryMirror.prototype.remove;
  vi.spyOn(MemoryMirror.prototype, 'remove').mockImplementation(async function (
    this: MemoryMirror,
    slug,
  ) {
    if (slug === 'a/plan/alpha') {
      // Simuler des disparitions externes après l'instantané.
      t!.d.memory.store.remove('a/review/alpha');
      rmSync(join(t!.home, 'memory/a/review/alpha.md'));
      t!.d.memory.store.remove('a/review/beta');
      rmSync(join(t!.home, 'memory/a/review/beta.md'));
    }
    await remove.call(this, slug);
  });
  const response = await purge({});
  expect(response.statusCode).toBe(200);
  expect(response.json().slugs).toEqual(['a/plan/alpha']);
  expect(response.json().tasks).toEqual(['a/alpha']);
  expect(await slugs()).toEqual(['a/retro/nuit']);
});

test('DM17 : les purges et les écritures partagent une file, instantané compris', async () => {
  t = await startTestDaemon();
  await put('a/plan/alpha');
  await put('a/review/alpha');
  await put('a/retro/nuit', 'alpha');
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const remove = MemoryMirror.prototype.remove;
  vi.spyOn(MemoryMirror.prototype, 'remove').mockImplementation(async function (
    this: MemoryMirror,
    slug,
  ) {
    if (slug === 'a/plan/alpha' || slug === 'a/review/alpha') {
      entered();
      await blocked;
    }
    await remove.call(this, slug);
  });
  const memory = t.d.memory;
  const first = memory.purge({});
  await started;
  let writeResolved = false;
  const write = memory
    .put('a/review/alpha', 'nouvelle page', { kind: 'force' }, { author: 'admin' })
    .then(() => {
      writeResolved = true;
    });
  const second = memory.purge({});
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writeResolved).toBe(false);
    expect(memory.get('a/review/alpha')?.body).toBe('contenu');
  } finally {
    release();
    await Promise.allSettled([first, write, second]);
  }
  expect((await first).slugs).toEqual(['a/plan/alpha', 'a/review/alpha']);
  await write;
  expect((await second).slugs).toEqual(['a/review/alpha']);
  expect(memory.get('a/review/alpha')).toBeUndefined();
});

test('62.4 : la purge rattache le fait à la tâche jusqu’au dernier point', async () => {
  t = await startTestDaemon();
  const pages = ['exemple/fait/tache.v2.regle', 'exemple/plan/tache.v2'];
  const sansPoint = 'exemple/fait/sanspoint';
  for (const slug of [...pages, sansPoint]) await put(slug);

  expect((await purge({})).json()).toMatchObject({ tasks: [], slugs: [] });
  expect((await purge({ orphelines: true })).json()).toMatchObject({
    tasks: ['exemple/tache.v2'],
    slugs: pages,
  });
  expect(await cli(['--orphelines'])).toEqual({
    code: 0,
    out: ['exemple/tache.v2', '1 tâche(s) orpheline(s)'],
    err: [],
  });
  expect(await slugs()).toEqual([sansPoint, ...pages]);

  const retro = 'exemple/retro/nuit';
  await put(retro, 'Rétro du cycle tache.v2');
  expect(await cli(['--dry-run'])).toEqual({
    code: 0,
    out: [...pages, '2 page(s) à purger'],
    err: [],
  });
  expect(await slugs()).toEqual([sansPoint, ...pages, retro]);
  expect((await purge({})).json()).toMatchObject({ tasks: ['exemple/tache.v2'], slugs: pages });
  expect(await slugs()).toEqual([sansPoint, retro]);
});
