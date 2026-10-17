import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { gitLiveInfo } from '../src/daemon/git/inspect.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-gl-')));

async function setup() {
  t = await startTestDaemon();
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

interface LogCommit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  message: string;
  refs: string[];
  inHead: boolean;
}

test('GET /api/topics/:id/git/log : commits du sujet et fenêtre partagée, inHead correct', async () => {
  const { origin, clone, ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Journal', type: 'feat' },
    })
  ).json<{ topicId: string; actionId: string; slug: string }>();
  await finished(created.actionId);
  const wt = join(ws.worktreesDir, created.slug);

  // main avance pendant que le sujet travaille de son côté.
  commitFile(clone, 'depuis-main.md', 'plus tard\n');
  sh(clone, 'push', '-q', 'origin', 'main');
  commitFile(wt, 'depuis-le-sujet.md', 'en cours\n');
  const topicHead = sh(wt, 'rev-parse', 'HEAD');
  const mainHead = sh(origin, 'rev-parse', 'main');

  const res = await t.d.app.inject({
    url: `/api/topics/${created.topicId}/git/log`,
    headers: t.headers,
  });
  expect(res.statusCode).toBe(200);
  const { commits, live } = res.json<{
    commits: LogCommit[];
    live: { aheadBehind: { ahead: number; behind: number } | null };
  }>();
  // 11.4 : même passage que commits/dirty — alimente la bannière de situation.
  expect(live.aheadBehind).toEqual({ ahead: 1, behind: 1 });

  const byHash = new Map(commits.map((c) => [c.hash, c]));
  expect(byHash.get(topicHead)).toMatchObject({
    message: 'ajout depuis-le-sujet.md',
    inHead: true,
  });
  expect(byHash.get(mainHead)).toMatchObject({
    message: 'ajout depuis-main.md',
    inHead: false,
  });
  for (const commit of commits) {
    expect(typeof commit.hash).toBe('string');
    expect(Array.isArray(commit.parents)).toBe(true);
  }
});

test('GET /api/topics/:id/git/log : 404 si le sujet est inconnu', async () => {
  t = await startTestDaemon();
  const res = await t.d.app.inject({ url: '/api/topics/inconnu/git/log', headers: t.headers });
  expect(res.statusCode).toBe(404);
});

test('gitLiveInfo : onTopicBranch vrai sur la branche du sujet, faux en HEAD détachée', async () => {
  const { clone } = makeOriginAndClone(tmp());
  commitFile(clone, 'suite.md', 'suite\n');

  expect((await gitLiveInfo(clone, 'main', 'main')).onTopicBranch).toBe(true);

  sh(clone, 'checkout', '-q', '--detach', 'HEAD');
  expect((await gitLiveInfo(clone, 'main', 'main')).onTopicBranch).toBe(false);

  sh(clone, 'checkout', '-q', 'main');
  sh(clone, 'checkout', '-q', '-b', 'feat/autre');
  expect((await gitLiveInfo(clone, 'main', 'main')).onTopicBranch).toBe(false);

  // Sans branche de sujet précisée, la question ne se pose pas : pas de signal de dérive.
  expect((await gitLiveInfo(clone, 'main')).onTopicBranch).toBe(true);
});
