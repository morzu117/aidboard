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
  delete process.env.AID_GH_BIN;
  delete process.env.FAKE_GH_CHECKS;
  delete process.env.FAKE_GH_PR_NUMBER;
  delete process.env.FAKE_GH_REVIEWS;
  delete process.env.FAKE_GH_STATE;
  await t?.d.stop();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-pf-')));
const FAKE_CODEGRAPH = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');
const FAKE_GH = join(import.meta.dirname, 'fixtures/fake-gh.sh');

async function setup() {
  process.env.AID_GH_BIN = FAKE_GH;
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

const refresh = (topicId: string) =>
  t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/pr.rafraichir`,
    headers: t.headers,
  });

test('pr.rafraichir : reflète les vérifications en cours puis vertes entre deux appels', async () => {
  const { ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Revue', type: 'feat' },
    })
  ).json<{ actionId: string }>();
  await finished(created.actionId);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');

  process.env.FAKE_GH_PR_NUMBER = '9';
  const opened = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/topic.pr`,
    headers: t.headers,
    payload: { title: 'Ma PR' },
  });
  await finished(opened.json<{ actionId: string }>().actionId);

  process.env.FAKE_GH_CHECKS = '[{"name":"build","conclusion":"PENDING"}]';
  const first = await refresh(topicId);
  expect(first.statusCode).toBe(202);
  await finished(first.json<{ actionId: string }>().actionId);
  const after1 = (await state()).actions.find((a) => a.action === 'pr.rafraichir');
  expect(after1?.result).toMatchObject({
    statusCheckRollup: [{ name: 'build', conclusion: 'PENDING' }],
  });

  process.env.FAKE_GH_CHECKS = '[{"name":"build","conclusion":"SUCCESS"}]';
  const second = await refresh(topicId);
  await finished(second.json<{ actionId: string }>().actionId);
  const after2 = (await state()).actions.find(
    (a) => a.action === 'pr.rafraichir' && a.id === second.json<{ actionId: string }>().actionId,
  );
  expect(after2?.result).toMatchObject({
    statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }],
  });
});

test('pr.rafraichir : sans PR ouverte, 409', async () => {
  const { ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Sans PR', type: 'feat' },
    })
  ).json<{ actionId: string }>();
  await finished(created.actionId);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');
  expect((await refresh(topicId)).statusCode).toBe(409);
});

test('D124 : pr.rafraichir lit la tête, l’état, le numéro, les branches et les revues', async () => {
  const { ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Tête', type: 'feat' },
    })
  ).json<{ actionId: string; slug: string; branch: string }>();
  await finished(created.actionId);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');
  process.env.FAKE_GH_PR_NUMBER = '9';
  const opened = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/topic.pr`,
    headers: t.headers,
    payload: { title: 'Ma PR' },
  });
  await finished(opened.json<{ actionId: string }>().actionId);

  process.env.FAKE_GH_REVIEWS = '[{"author":{"login":"codex"},"commit":{"oid":"abc"}}]';
  process.env.FAKE_GH_STATE = 'MERGED';
  const r = await refresh(topicId);
  const id = r.json<{ actionId: string }>().actionId;
  await finished(id);
  expect((await state()).actions.find((a) => a.id === id)?.result).toMatchObject({
    headRefOid: sh(join(ws.worktreesDir, created.slug), 'rev-parse', 'HEAD'),
    state: 'MERGED',
    number: 9,
    baseRefName: 'main',
    headRefName: created.branch,
    reviews: [{ author: { login: 'codex' }, commit: { oid: 'abc' } }],
  });
});
