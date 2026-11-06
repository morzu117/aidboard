import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { StateSnapshot } from '../src/shared/state.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';
import { makeOriginAndClone } from './helpers/git.js';

let t: TestDaemon;
afterEach(async () => {
  delete process.env.AID_GH_BIN;
  delete process.env.FAKE_GH_MERGE_REFUSED;
  delete process.env.FAKE_GH_MERGE_LOG;
  delete process.env.FAKE_GH_PR_NUMBER;
  delete process.env.FAKE_GH_HEAD_MOVED;
  await t?.d.stop();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-tm-')));
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

const state = async (all = false) =>
  (
    await t.d.app.inject({ url: `/api/state${all ? '?all=1' : ''}`, headers: t.headers })
  ).json<StateSnapshot>();

async function createWithPr(ws: { id: string }, title: string) {
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title, type: 'feat' },
    })
  ).json<{ actionId: string; slug: string }>();
  await finished(created.actionId);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');
  const opened = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/topic.pr`,
    headers: t.headers,
    payload: { title: 'Ma PR' },
  });
  await finished(opened.json<{ actionId: string }>().actionId);
  return { topicId, slug: created.slug };
}

const merge = (topicId: string, payload: Record<string, unknown>) =>
  t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/topic.merge`,
    headers: t.headers,
    payload,
  });

test('topic.merge : squash avec suppression de branche et message, le sujet passe en merged', async () => {
  const { ws } = await setup();
  const { topicId } = await createWithPr(ws, 'Squash');
  const log = join(tmp(), 'merge.log');
  process.env.FAKE_GH_MERGE_LOG = log;

  const r = await merge(topicId, {
    strategy: 'squash',
    deleteBranch: true,
    message: 'tout en un',
  });
  expect(r.statusCode).toBe(202);
  const fin = await finished(r.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect((await state()).topics).toMatchObject([{ state: 'merged' }]);
  const call = readFileSync(log, 'utf8');
  expect(call).toContain('--squash');
  expect(call).toContain('--delete-branch');
  expect(call).toContain('--subject tout en un');
});

test('topic.merge : merge et rebase passent la bonne option à gh', async () => {
  const { ws } = await setup();
  const log = join(tmp(), 'merge.log');
  process.env.FAKE_GH_MERGE_LOG = log;

  const a = await createWithPr(ws, 'Merge');
  await finished(
    (await merge(a.topicId, { strategy: 'merge' })).json<{ actionId: string }>().actionId,
  );
  const b = await createWithPr(ws, 'Rebase');
  await finished(
    (await merge(b.topicId, { strategy: 'rebase' })).json<{ actionId: string }>().actionId,
  );

  const calls = readFileSync(log, 'utf8').trim().split('\n');
  expect(calls[0]).toContain('--merge');
  expect(calls[1]).toContain('--rebase');
});

test('topic.merge : refus de GitHub remonté tel quel (needs_human)', async () => {
  const { ws } = await setup();
  const { topicId } = await createWithPr(ws, 'Protégé');
  process.env.FAKE_GH_MERGE_REFUSED = '1';

  const r = await merge(topicId, { strategy: 'squash' });
  const fin = await finished(r.json<{ actionId: string }>().actionId);
  expect(fin.data).toMatchObject({ outcome: 'needs_human', exitCode: 2 });
  expect((fin.data.tail as string[]).join(' ')).toContain('protection de branche');
  expect((await state()).topics).toMatchObject([{ state: 'review' }]);
});

test('topic.merge : nettoyage enchaîné quand demandé, sans deadlock de file', async () => {
  const { ws } = await setup();
  const { topicId, slug } = await createWithPr(ws, 'Nettoyage');
  const wt = join(ws.worktreesDir, slug);
  expect(existsSync(wt)).toBe(true);

  const r = await merge(topicId, { strategy: 'squash', cleanupAfter: true });
  await finished(r.json<{ actionId: string }>().actionId);

  await waitFor(
    () =>
      t.store
        .since(null)
        .find(
          (e) =>
            e.type === 'action.finished' &&
            e.topicId === topicId &&
            e.data.action === 'topic.cleanup',
        ),
    15_000,
    'nettoyage enchaîné',
  );
  expect((await state(true)).topics).toMatchObject([{ state: 'archived' }]);
  expect(existsSync(wt)).toBe(false);
});

test('topic.merge : sans PR ouverte, 409 ; sans stratégie, 422 ; déjà fusionné, 409', async () => {
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
  expect((await merge(topicId, { strategy: 'squash' })).statusCode).toBe(409);

  const { topicId: topicId2 } = await createWithPr(ws, 'Avec PR');
  expect((await merge(topicId2, {})).statusCode).toBe(422);
  await finished(
    (await merge(topicId2, { strategy: 'squash' })).json<{ actionId: string }>().actionId,
  );
  expect((await merge(topicId2, { strategy: 'squash' })).statusCode).toBe(409);
});

// Chantier 27 (D123) : le merge vise la tête que l'écran a montrée.
const TETE = '3f2a91c0000000000000000000000000000000aa';

test('D123 : la tête passée part en --match-head-commit ; sans tête, rien ne change', async () => {
  const { ws } = await setup();
  const log = join(tmp(), 'merge.log');
  process.env.FAKE_GH_MERGE_LOG = log;
  const a = await createWithPr(ws, 'Sur une tête');
  const r = await merge(a.topicId, { strategy: 'merge', head: TETE });
  expect(r.statusCode).toBe(202);
  expect((await finished(r.json<{ actionId: string }>().actionId)).data.outcome).toBe('succeeded');
  const b = await createWithPr(ws, 'Sans tête');
  await finished(
    (await merge(b.topicId, { strategy: 'merge' })).json<{ actionId: string }>().actionId,
  );
  const [avec, sans] = readFileSync(log, 'utf8').trim().split('\n');
  expect(avec).toContain(`--match-head-commit ${TETE}`);
  expect(sans).not.toContain('--match-head-commit');
});

test('D123 : tête invalide, 422 ; tête bougée sur GitHub, refus remonté (needs_human)', async () => {
  const { ws } = await setup();
  const { topicId } = await createWithPr(ws, 'Tête bougée');
  for (const head of ['3f2a91c', TETE.toUpperCase(), `${TETE}0`, '--admin'])
    expect((await merge(topicId, { strategy: 'merge', head })).statusCode).toBe(422);

  process.env.FAKE_GH_HEAD_MOVED = '1';
  const r = await merge(topicId, { strategy: 'merge', head: TETE });
  const fin = await finished(r.json<{ actionId: string }>().actionId);
  expect(fin.data).toMatchObject({ outcome: 'needs_human', exitCode: 2 });
  expect((fin.data.tail as string[]).join(' ')).toContain('Head branch was modified');
  expect((await state()).topics).toMatchObject([{ state: 'review' }]);
});
