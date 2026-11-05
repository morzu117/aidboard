import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { currentBranch, currentBranchFast, headBranchOnDisk } from '../src/daemon/git/inspect.js';
import type { StateSnapshot } from '../src/shared/state.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';
import { makeOriginAndClone, sh } from './helpers/git.js';

// GET /api/state relit la branche de chaque sujet : HEAD est lu sur le disque, et deux relectures simultanées
// n'écrivent qu'un topic.branch.

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-sb-')));

test('HEAD lu sur le disque : dépôt, worktree lié, HEAD détachée, même réponse que git', async () => {
  const { clone } = makeOriginAndClone(tmp());
  expect(headBranchOnDisk(clone)).toBe('main');
  expect(await currentBranch(clone)).toBe('main');

  const wt = join(tmp(), 'lie');
  sh(clone, 'worktree', 'add', '-q', '-b', 'feat/un-sujet', wt);
  expect(headBranchOnDisk(wt)).toBe('feat/un-sujet');
  expect(await currentBranchFast(wt)).toBe(await currentBranch(wt));

  sh(wt, 'checkout', '-q', '--detach');
  expect(headBranchOnDisk(wt)).toBeNull();
  expect(await currentBranch(wt)).toBeNull();
});

test('forme inhabituelle : undefined, et currentBranchFast repasse par git', async () => {
  const pasGit = tmp();
  expect(headBranchOnDisk(pasGit)).toBeUndefined();
  expect(await currentBranchFast(pasGit)).toBeNull();

  // reftable : HEAD pointe sur refs/heads/.invalid, la vraie branche est ailleurs
  const reftable = tmp();
  mkdirSync(join(reftable, '.git'));
  writeFileSync(join(reftable, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
  expect(headBranchOnDisk(reftable)).toBeUndefined();

  const horsHeads = tmp();
  mkdirSync(join(horsHeads, '.git'));
  writeFileSync(join(horsHeads, '.git', 'HEAD'), 'ref: refs/remotes/origin/main\n');
  expect(headBranchOnDisk(horsHeads)).toBeUndefined();

  const gitdirIllisible = tmp();
  writeFileSync(join(gitdirIllisible, '.git'), 'pas un gitdir\n');
  expect(headBranchOnDisk(gitdirIllisible)).toBeUndefined();
});

test('une branche homonyme d’un tag : même nom sur le disque et par git', async () => {
  const { clone } = makeOriginAndClone(tmp());
  sh(clone, 'tag', 'v1.0');
  sh(clone, 'checkout', '-q', '-b', 'v1.0');
  expect(headBranchOnDisk(clone)).toBe('v1.0');
  expect(await currentBranch(clone)).toBe('v1.0');
});

test('la branche changée hors d’A-I-D est relue par deux GET /api/state simultanés, un seul topic.branch', async () => {
  t = await startTestDaemon();
  const daemon = t;
  const { clone } = makeOriginAndClone(tmp());
  const ws = (
    await daemon.d.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: daemon.headers,
      payload: { path: clone },
    })
  ).json<{ id: string; worktreesDir: string }>();
  const created = (
    await daemon.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: daemon.headers,
      payload: { workspaceId: ws.id, title: 'Dérive', type: 'feat' },
    })
  ).json<{ actionId: string; slug: string; branch: string }>();
  await waitFor(
    () =>
      daemon.store
        .since(null)
        .find((e) => e.type === 'action.finished' && e.data.actionId === created.actionId),
    15_000,
    'sujet créé',
  );
  const state = async () =>
    (
      await daemon.d.app.inject({ url: '/api/state', headers: daemon.headers })
    ).json<StateSnapshot>();
  expect((await state()).topics).toMatchObject([{ branch: created.branch }]);

  sh(join(ws.worktreesDir, created.slug), 'checkout', '-q', '-b', 'autre-nom');
  const [un, deux] = await Promise.all([state(), state()]);
  expect(un.topics).toMatchObject([{ branch: 'autre-nom' }]);
  expect(deux.topics).toMatchObject([{ branch: 'autre-nom' }]);
  expect(daemon.store.since(null).filter((e) => e.type === 'topic.branch')).toHaveLength(1);
});
