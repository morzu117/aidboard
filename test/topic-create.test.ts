import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

let t: TestDaemon;
afterEach(async () => {
  delete process.env.FAKE_CODEGRAPH_EXIT;
  await t?.d.stop();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-tc-')));
const FAKE = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');

async function setup(opts: { codegraph?: boolean; bin?: string } = {}) {
  t = await startTestDaemon(undefined, { codegraphBin: opts.bin ?? FAKE });
  const repo = makeOriginAndClone(tmp(), { codegraph: opts.codegraph });
  const ws = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: t.headers,
      payload: { path: repo.clone },
    })
  ).json<{ id: string; name: string; worktreesDir: string }>();
  return { ...repo, ws };
}

const create = (ws: { id: string }, title: string, extra: Record<string, unknown> = {}) =>
  t.d.app.inject({
    method: 'POST',
    url: '/api/topics',
    headers: t.headers,
    payload: { workspaceId: ws.id, title, type: 'feat', ...extra },
  });

const finished = (actionId: string) =>
  waitFor(
    () =>
      t.store.since(null).find((e) => e.type === 'action.finished' && e.data.actionId === actionId),
    15_000,
    `fin de ${actionId}`,
  );

test('crée branche et worktree depuis origin/main, sans amont, et le sujet devient actif', async () => {
  const { clone, ws } = await setup();
  const r = await create(ws, 'Ma première fonction');
  expect(r.statusCode).toBe(202);
  const { actionId, slug, branch } = r.json<{ actionId: string; slug: string; branch: string }>();
  expect([slug, branch]).toEqual(['ma-premiere-fonction', 'feat/ma-premiere-fonction']);
  const fin = await finished(actionId);
  expect(fin.data.outcome).toBe('succeeded');

  const wt = join(ws.worktreesDir, slug);
  expect(existsSync(join(wt, 'README.md'))).toBe(true);
  expect(sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
  expect(sh(wt, 'rev-parse', 'HEAD')).toBe(sh(clone, 'rev-parse', 'origin/main'));
  expect(() => sh(wt, 'rev-parse', '--abbrev-ref', '@{u}')).toThrow();

  const topic = t.db.prepare('SELECT state, branch, worktree, index_state FROM topics').get();
  expect(topic).toEqual({ state: 'active', branch, worktree: wt, index_state: 'disabled' });
  expect(t.db.prepare('SELECT mode, state FROM runs').all()).toEqual([
    { mode: 'standard', state: 'open' },
  ]);
  expect(fin.topicId).toBeDefined();
});

test('.worktreeinclude ne copie que les fichiers ignorés par le projet', async () => {
  const { clone, ws } = await setup();
  commitFile(clone, '.gitignore', '.env\n');
  commitFile(clone, '.worktreeinclude', '.env\nnotes.md\n');
  sh(clone, 'push', '-q', 'origin', 'main');
  writeFileSync(join(clone, '.env'), 'SECRET=1\n');
  writeFileSync(join(clone, 'notes.md'), 'brouillon\n');
  const { actionId, slug } = (await create(ws, 'Avec env')).json();
  await finished(actionId);
  const wt = join(ws.worktreesDir, slug);
  expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
  expect(existsSync(join(wt, 'notes.md'))).toBe(false);
});

test('une branche déjà là : needs_human, aucun sujet, et le slug reste utilisable', async () => {
  const { clone, ws } = await setup();
  sh(clone, 'branch', 'feat/deja');
  const a = (await create(ws, 'Déjà')).json<{ actionId: string }>();
  const fin = await finished(a.actionId);
  expect(fin.data).toMatchObject({ outcome: 'needs_human', exitCode: 2 });
  expect((fin.data.tail as string[]).join(' ')).toContain('existe déjà');
  expect(t.db.prepare('SELECT count(*) c FROM topics').get()).toEqual({ c: 0 });
  sh(clone, 'branch', '-D', 'feat/deja');
  const b = (await create(ws, 'Déjà')).json<{ actionId: string }>();
  expect((await finished(b.actionId)).data.outcome).toBe('succeeded');
});

test('sans .codegraph dans le dépôt principal : index disabled, rien n’est lancé', async () => {
  const { ws } = await setup();
  const { actionId } = (await create(ws, 'Sans index')).json();
  await finished(actionId);
  await new Promise((r) => setTimeout(r, 400));
  expect(t.db.prepare('SELECT index_state FROM topics').get()).toEqual({ index_state: 'disabled' });
});

test('avec .codegraph : indexing puis ready, et le worktree a son index', async () => {
  const { ws } = await setup({ codegraph: true });
  const { actionId, slug } = (await create(ws, 'Avec index')).json();
  await finished(actionId);
  expect(t.db.prepare('SELECT index_state FROM topics').get()).toEqual({ index_state: 'indexing' });
  await waitFor(
    () => (t.db.prepare('SELECT index_state s FROM topics').get() as { s: string }).s === 'ready',
    8000,
    'index prêt',
  );
  expect(existsSync(join(ws.worktreesDir, slug, '.codegraph', 'codegraph.db'))).toBe(true);
});

test('indexation en échec : index failed, le sujet reste actif', async () => {
  process.env.FAKE_CODEGRAPH_EXIT = '1';
  const { ws } = await setup({ codegraph: true });
  const { actionId } = (await create(ws, 'Index cassé')).json();
  await finished(actionId);
  await waitFor(
    () => (t.db.prepare('SELECT index_state s FROM topics').get() as { s: string }).s === 'failed',
    8000,
    'index failed',
  );
  expect(t.db.prepare('SELECT state FROM topics').get()).toEqual({ state: 'active' });
});

test('codegraph introuvable : index failed', async () => {
  const { ws } = await setup({ codegraph: true, bin: '/nexiste/pas/codegraph' });
  const { actionId } = (await create(ws, 'Sans binaire')).json();
  await finished(actionId);
  await waitFor(
    () => (t.db.prepare('SELECT index_state s FROM topics').get() as { s: string }).s === 'failed',
    8000,
    'index failed',
  );
});

test('trois créations simultanées dans le même workspace réussissent toutes', async () => {
  const { ws } = await setup();
  const rs = await Promise.all(['Un', 'Deux', 'Trois'].map((n) => create(ws, `Sujet ${n}`)));
  const ids = rs.map((r) => r.json<{ actionId: string }>().actionId);
  const outcomes = await Promise.all(ids.map(async (id) => (await finished(id)).data.outcome));
  expect(outcomes).toEqual(['succeeded', 'succeeded', 'succeeded']);
  expect(t.db.prepare('SELECT count(*) c FROM topics').get()).toEqual({ c: 3 });
});

test('slug déjà pris : 409 ; slug invalide : 422 ; workspace inconnu : 404 ; payload invalide : 400', async () => {
  const { ws } = await setup();
  const { actionId } = (await create(ws, 'Pris')).json();
  await finished(actionId);
  expect((await create(ws, 'Pris')).statusCode).toBe(409);
  expect((await create(ws, 'x', { slug: 'Pas Valide' })).statusCode).toBe(422);
  expect((await create(ws, '!!!')).statusCode).toBe(422);
  expect((await create({ id: 'ws_nope' }, 'x')).statusCode).toBe(404);
  expect((await create(ws, 'x', { type: 'autre' })).statusCode).toBe(400);
});

test('un titre piégé ne touche jamais un shell', async () => {
  const { ws } = await setup();
  const marker = join(tmp(), 'pwned');
  const r = await create(ws, `a $(touch ${marker}) ; \`touch ${marker}\``, { slug: 'piege' });
  await finished(r.json().actionId);
  expect(existsSync(marker)).toBe(false);
  expect(t.db.prepare('SELECT title FROM topics').get()).toMatchObject({
    title: expect.stringContaining('$(touch'),
  });
});

test('le journal d’action est écrit', async () => {
  const { ws } = await setup();
  const { actionId } = (await create(ws, 'Journal')).json();
  await finished(actionId);
  expect(readFileSync(join(t.home, 'logs/actions', `${actionId}.log`), 'utf8')).toContain(
    'worktree',
  );
});
