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

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-tp-')));
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

test('git.pousser : avec avance, pousse la branche du sujet sur origin', async () => {
  const { origin, ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Pousser', type: 'feat' },
    })
  ).json<{ actionId: string; slug: string; branch: string }>();
  await finished(created.actionId);
  const wt = join(ws.worktreesDir, created.slug);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');

  commitFile(wt, 'depuis-le-sujet.md', 'en cours\n');
  const tip = sh(wt, 'rev-parse', 'HEAD');

  const run = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/git.pousser`,
    headers: t.headers,
  });
  expect(run.statusCode).toBe(202);
  const fin = await finished(run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');

  expect(sh(origin, 'rev-parse', created.branch)).toBe(tip);
});

test('git.pousser : sans avance, 422 et rien n’est lancé', async () => {
  const { ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'A jour', type: 'feat' },
    })
  ).json<{ actionId: string }>();
  await finished(created.actionId);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');

  const run = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/git.pousser`,
    headers: t.headers,
  });
  expect(run.statusCode).toBe(422);
});

test('git.pousser : worktree manquant, 409', async () => {
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
    url: `/api/topics/${topicId}/actions/git.pousser`,
    headers: t.headers,
  });
  expect(run.statusCode).toBe(409);
  await finished(created.actionId);
});
