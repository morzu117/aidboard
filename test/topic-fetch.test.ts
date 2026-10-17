import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { StateSnapshot } from '../src/shared/state.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-tf-')));
const FAKE = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');

async function setup() {
  t = await startTestDaemon(undefined, { codegraphBin: FAKE });
  const repo = makeOriginAndClone(tmp());
  const ws = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: t.headers,
      payload: { path: repo.clone },
    })
  ).json<{ id: string; worktreesDir: string }>();
  return { ...repo, ws };
}

const finished = (actionId: string) =>
  waitFor(
    () =>
      t.store.since(null).find((e) => e.type === 'action.finished' && e.data.actionId === actionId),
    15_000,
    `fin de ${actionId}`,
  );

const state = async () =>
  (await t.d.app.inject({ url: '/api/state', headers: t.headers })).json<StateSnapshot>();

test('git.fetch : met à jour origin/<base> localement sans toucher à la branche du sujet', async () => {
  const { clone, ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Fetch', type: 'feat' },
    })
  ).json<{ actionId: string; slug: string }>();
  await finished(created.actionId);
  const wt = join(ws.worktreesDir, created.slug);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');

  const before = sh(wt, 'rev-parse', 'origin/main');

  // un autre contributeur avance origin pendant que le sujet travaille.
  commitFile(clone, 'depuis-origin.md', 'plus tard\n');
  sh(clone, 'push', '-q', 'origin', 'main');
  const onOrigin = sh(clone, 'rev-parse', 'main');
  expect(onOrigin).not.toBe(before);

  const run = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/git.fetch`,
    headers: t.headers,
  });
  expect(run.statusCode).toBe(202);
  const fin = await finished(run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');

  expect(sh(wt, 'rev-parse', 'origin/main')).toBe(onOrigin);
});

test('git.fetch : worktree manquant, 409', async () => {
  const { ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Draft', type: 'feat' },
    })
  ).json<{ actionId: string }>();
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');
  const run = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/git.fetch`,
    headers: t.headers,
  });
  expect(run.statusCode).toBe(409);
  await finished(created.actionId);
});
