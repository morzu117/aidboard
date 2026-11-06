import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { GitTransfert } from '../src/shared/git.js';
import type { StateSnapshot } from '../src/shared/state.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

// Chantier 28 (D148) : GET /api/topics/:id/git/transfert, sur un vrai dépôt temporaire.

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-transfert-')));
const FAKE_CODEGRAPH = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');

async function sujet() {
  t = await startTestDaemon(undefined, { codegraphBin: FAKE_CODEGRAPH });
  const repo = makeOriginAndClone(tmp());
  const ws = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: t.headers,
      payload: { path: repo.clone },
    })
  ).json<{ id: string; worktreesDir: string }>();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Transfert', type: 'feat' },
    })
  ).json<{ actionId: string; slug: string; branch: string }>();
  await waitFor(
    () =>
      t.store
        .since(null)
        .find((e) => e.type === 'action.finished' && e.data.actionId === created.actionId),
    15_000,
    'création du sujet',
  );
  const snap = (
    await t.d.app.inject({ url: '/api/state', headers: t.headers })
  ).json<StateSnapshot>();
  return {
    topicId: snap.topics[0]!.id,
    wt: join(ws.worktreesDir, created.slug),
    branch: created.branch,
  };
}

const lire = async (topicId: string) =>
  (
    await t.d.app.inject({ url: `/api/topics/${topicId}/git/transfert`, headers: t.headers })
  ).json<GitTransfert>();

test('D148 : commits depuis la base, non poussés, fichiers non commités', async () => {
  const { topicId, wt, branch } = await sujet();
  expect(await lire(topicId)).toEqual({
    branche: branch,
    base: 'main',
    commits: [],
    nonPousses: 0,
    dirty: false,
  });

  commitFile(wt, 'a.txt', 'un\n', 'premier');
  commitFile(wt, 'b.txt', 'deux\n', 'second');
  // sans origin/<branche> : tous les commits depuis la base
  expect(await lire(topicId)).toMatchObject({ commits: ['second', 'premier'], nonPousses: 2 });

  sh(wt, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  sh(wt, 'fetch', '-q', 'origin');
  commitFile(wt, 'c.txt', 'trois\n', 'troisième');
  writeFileSync(join(wt, 'a.txt'), 'changé\n');
  expect(await lire(topicId)).toMatchObject({
    commits: ['troisième', 'second', 'premier'],
    nonPousses: 1,
    dirty: true,
  });
});

test('D148 : 20 commits au plus ; sujet inconnu, 404', async () => {
  const { topicId, wt } = await sujet();
  for (let i = 1; i <= 22; i++) commitFile(wt, `f${i}.txt`, `${i}\n`, `commit ${i}`);
  const g = await lire(topicId);
  expect(g.commits).toHaveLength(20);
  expect(g.commits[0]).toBe('commit 22');
  expect(g.nonPousses).toBe(22);
  const r = await t.d.app.inject({
    url: '/api/topics/tp_inconnu/git/transfert',
    headers: t.headers,
  });
  expect(r.statusCode).toBe(404);
});
