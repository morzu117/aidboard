import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { commitFile, sh } from './helpers/git.js';
import {
  type Ctx,
  finished,
  makeTopic,
  postAction,
  postCreate,
  setupWorkspace,
} from './helpers/topics.js';

let c: Ctx;
afterEach(async () => {
  await c?.t.d.stop();
});

const currentBranch = (wt: string) => sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD');

async function switchTo(topicId: string, body?: Record<string, unknown>) {
  const r = await postAction(c, topicId, 'topic.branch-changer', body);
  return r;
}

test('topic.branch-changer : chemin heureux, le worktree bascule sur la branche visée', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  sh(wt, 'branch', 'autre');

  const run = await switchTo(topicId, { targetBranch: 'autre' });
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(currentBranch(wt)).toBe('autre');
});

test('topic.branch-changer : non commité sans dirtyAction, refus net, rien ne bouge', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  sh(wt, 'branch', 'autre');
  writeFileSync(join(wt, 'brouillon.txt'), 'en cours\n');

  const run = await switchTo(topicId, { targetBranch: 'autre' });
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data).toMatchObject({ outcome: 'needs_human', exitCode: 2 });
  expect(currentBranch(wt)).toBe(branch);
  expect(existsSync(join(wt, 'brouillon.txt'))).toBe(true);
});

test('topic.branch-changer : dirtyAction stash, remise de côté puis bascule', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  sh(wt, 'branch', 'autre');
  writeFileSync(join(wt, 'brouillon.txt'), 'en cours\n');

  const run = await switchTo(topicId, { targetBranch: 'autre', dirtyAction: 'stash' });
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(currentBranch(wt)).toBe('autre');
  expect(existsSync(join(wt, 'brouillon.txt'))).toBe(false);
  expect(sh(wt, 'stash', 'list')).not.toBe('');
});

test('topic.branch-changer : branche déjà extraite dans un autre worktree A-I-D, 409', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');

  const run = await switchTo(un.topicId, { targetBranch: deux.branch });
  expect(run.statusCode).toBe(409);
  expect(currentBranch(un.wt)).toBe(un.branch);
});

test('topic.branch-changer : worktree manquant, 409', async () => {
  c = await setupWorkspace();
  const created = (await postCreate(c, 'Draft')).json<{ actionId: string; topicId: string }>();
  const r = await postAction(c, created.topicId, 'topic.branch-changer', {
    targetBranch: 'autre',
  });
  expect(r.statusCode).toBe(409);
  await finished(c.t, created.actionId);
});

test('branche.creer-ici : nouvelle branche depuis HEAD, topics.branch inchangé', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  commitFile(wt, 'avance.md', 'avance du sujet\n');
  const tip = sh(wt, 'rev-parse', 'HEAD');

  const run = await postAction(c, topicId, 'branche.creer-ici', { targetBranch: 'feat/ici' });
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(currentBranch(wt)).toBe('feat/ici');
  expect(sh(wt, 'rev-parse', 'HEAD')).toBe(tip);
  const row = c.t.db.prepare('SELECT branch FROM topics WHERE id = ?').get(topicId) as {
    branch: string;
  };
  expect(row.branch).toBe(branch);
});

test('branche.creer : nouvelle branche depuis la base du sujet, pas depuis HEAD', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  commitFile(wt, 'avance.md', 'avance du sujet\n');
  const baseTip = sh(wt, 'rev-parse', 'origin/main');

  const run = await postAction(c, topicId, 'branche.creer', { targetBranch: 'feat/depuis-base' });
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(currentBranch(wt)).toBe('feat/depuis-base');
  expect(sh(wt, 'rev-parse', 'HEAD')).toBe(baseTip);
});
