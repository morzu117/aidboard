import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';
import { makeOriginAndClone } from './helpers/git.js';

// 08.8 — au redémarrage du daemon, le moteur est relancé sur chaque sujet vivant : `sync` si le
// worktree a son index, `init` si le dépôt principal l'a adopté depuis. Faux binaire uniquement.

let t: TestDaemon | undefined;
afterEach(async () => {
  delete process.env.FAKE_CODEGRAPH_EXIT;
  await t?.d.stop();
  t = undefined;
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-rt-')));
const FAKE = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');

const indexState = () =>
  (t!.db.prepare('SELECT index_state s FROM topics').get() as { s: string }).s;

// Un daemon, un workspace, un sujet matérialisé ; rend ce qu'il faut pour redémarrer sur le même home.
async function premierLancement(opts: { codegraph: boolean }) {
  const home = mkdtempSync(join(tmpdir(), 'aid-d-'));
  t = await startTestDaemon(home, { codegraphBin: FAKE });
  const { clone } = makeOriginAndClone(tmp(), { codegraph: opts.codegraph });
  const ws = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: t.headers,
      payload: { path: clone },
    })
  ).json<{ id: string }>();
  const { actionId, topicId } = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Sujet', type: 'feat' },
    })
  ).json<{ actionId: string; topicId: string }>();
  await waitFor(
    () =>
      t!.store
        .since(null)
        .find((e) => e.type === 'action.finished' && e.data.actionId === actionId),
    15_000,
    'création du sujet',
  );
  const worktree = (t.db.prepare('SELECT worktree w FROM topics').get() as { w: string }).w;
  await waitFor(
    () => indexState() === (opts.codegraph ? 'ready' : 'disabled'),
    15_000,
    'état initial',
  );
  return { home, clone, topicId, worktree };
}

async function redemarrer(home: string, extra: Parameters<typeof startTestDaemon>[1] = {}) {
  await t!.d.stop();
  t = await startTestDaemon(home, { codegraphBin: FAKE, ...extra });
}

const etatsDepuis = (n: number) =>
  t!.store
    .since(null)
    .slice(n)
    .filter((e) => e.type === 'topic.state')
    .map((e) => e.data.indexState);

test('worktree déjà indexé : sync au redémarrage, indexing puis ready, marqueur déposé', async () => {
  const { home, worktree } = await premierLancement({ codegraph: true });
  expect(existsSync(join(worktree, '.codegraph', 'synced'))).toBe(false);
  const avant = t!.store.since(null).length;
  await redemarrer(home);
  await waitFor(() => existsSync(join(worktree, '.codegraph', 'synced')), 15_000, 'sync du faux');
  await waitFor(() => etatsDepuis(avant).at(-1) === 'ready', 15_000, 'ready après sync');
  expect(etatsDepuis(avant)).toEqual(['indexing', 'ready']);
  // init n'a pas été relancé : l'index existant est conservé, pas reconstruit
  expect(indexState()).toBe('ready');
});

test('sujet disabled dont le dépôt principal a adopté l’index depuis : init au redémarrage', async () => {
  const { home, clone, worktree } = await premierLancement({ codegraph: false });
  expect(existsSync(join(worktree, '.codegraph'))).toBe(false);
  mkdirSync(join(clone, '.codegraph'));
  writeFileSync(join(clone, '.codegraph', 'codegraph.db'), '');
  const avant = t!.store.since(null).length;
  await redemarrer(home);
  await waitFor(() => indexState() === 'ready', 15_000, 'ready après init tardif');
  expect(etatsDepuis(avant)).toEqual(['indexing', 'ready']);
  expect(existsSync(join(worktree, '.codegraph', 'codegraph.db'))).toBe(true);
  expect(existsSync(join(worktree, '.codegraph', 'synced'))).toBe(false);
});

test('sync en échec : le sujet passe failed, le journal du sujet reste le même fichier', async () => {
  const { home, topicId } = await premierLancement({ codegraph: true });
  process.env.FAKE_CODEGRAPH_EXIT = '1';
  await redemarrer(home);
  await waitFor(() => indexState() === 'failed', 15_000, 'failed après sync');
  expect(existsSync(join(home, 'logs', `${topicId}-index.log`))).toBe(true);
});

test('moteur off au redémarrage : rien ne part, l’état stocké ne bouge pas', async () => {
  const { home, worktree } = await premierLancement({ codegraph: true });
  const avant = t!.store.since(null).length;
  await redemarrer(home, { structuralEngine: 'off' });
  // laisser le temps à un éventuel lancement : le faux met 0,2 s à répondre
  await new Promise((r) => setTimeout(r, 600));
  expect(etatsDepuis(avant)).toEqual([]);
  expect(existsSync(join(worktree, '.codegraph', 'synced'))).toBe(false);
  expect(indexState()).toBe('ready');
});

test('sujet sans dépôt principal indexé et sans index : ignoré ; worktree disparu : ignoré', async () => {
  const { home, worktree } = await premierLancement({ codegraph: false });
  const avant = t!.store.since(null).length;
  await redemarrer(home);
  await new Promise((r) => setTimeout(r, 600));
  expect(etatsDepuis(avant)).toEqual([]);
  expect(indexState()).toBe('disabled');

  // index présent dans le dépôt principal, mais le worktree n'existe plus sur le disque
  const clone = (t!.db.prepare('SELECT root r FROM workspaces').get() as { r: string }).r;
  mkdirSync(join(clone, '.codegraph'));
  writeFileSync(join(clone, '.codegraph', 'codegraph.db'), '');
  rmSync(worktree, { recursive: true, force: true });
  const avant2 = t!.store.since(null).length;
  await redemarrer(home);
  await new Promise((r) => setTimeout(r, 600));
  expect(etatsDepuis(avant2)).toEqual([]);
  expect(indexState()).toBe('disabled');
});
