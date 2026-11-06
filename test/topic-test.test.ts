import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { StateSnapshot } from '../src/shared/state.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';
import { makeOriginAndClone } from './helpers/git.js';
import { sh } from './helpers/git.js';

let t: TestDaemon;
afterEach(async () => {
  delete process.env.AID_NPM_BIN;
  delete process.env.FAKE_NPM_EXIT;
  await t?.d.stop();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-tt-')));
const FAKE_CODEGRAPH = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');
const FAKE_NPM = join(import.meta.dirname, 'fixtures/fake-npm.sh');

async function setup() {
  process.env.AID_NPM_BIN = FAKE_NPM;
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

test('topic.test : exécute le faux npm test, succès répercuté tel quel', async () => {
  const { ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Vert', type: 'feat' },
    })
  ).json<{ actionId: string }>();
  await finished(created.actionId);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');

  const run = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/topic.test`,
    headers: t.headers,
  });
  expect(run.statusCode).toBe(202);
  const fin = await finished(run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
});

test('topic.test : un test rouge est un échec normal (failed), pas needs_human', async () => {
  const { ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Rouge', type: 'feat' },
    })
  ).json<{ actionId: string }>();
  await finished(created.actionId);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');

  process.env.FAKE_NPM_EXIT = '1';
  const run = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/topic.test`,
    headers: t.headers,
  });
  const fin = await finished(run.json<{ actionId: string }>().actionId);
  expect(fin.data).toMatchObject({ outcome: 'failed', exitCode: 1 });
});

test('topic.test : worktree manquant, 409', async () => {
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
    url: `/api/topics/${topicId}/actions/topic.test`,
    headers: t.headers,
  });
  expect(run.statusCode).toBe(409);
  await finished(created.actionId);
});

test('D124 : topic.test publie la tête testée, même quand le test est rouge', async () => {
  const { ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Tête testée', type: 'feat' },
    })
  ).json<{ actionId: string; slug: string }>();
  await finished(created.actionId);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');
  const head = sh(join(ws.worktreesDir, created.slug), 'rev-parse', 'HEAD');

  process.env.FAKE_NPM_EXIT = '1';
  const run = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/topic.test`,
    headers: t.headers,
  });
  const id = run.json<{ actionId: string }>().actionId;
  expect((await finished(id)).data.outcome).toBe('failed');
  expect((await state()).actions.find((a) => a.id === id)?.result).toMatchObject({ head });
});
