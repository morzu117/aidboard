import { afterEach, expect, test } from 'vitest';
import { sh } from './helpers/git.js';
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

const gitLog = (topicId: string) =>
  c.t.d.app.inject({ url: `/api/topics/${topicId}/git/log`, headers: c.t.headers });

test('GET .../git/log : onTopicBranch et headBranch refusent de valoir vrai/stale quand le worktree a changé de branche', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  sh(wt, 'branch', 'autre');
  sh(wt, 'checkout', '-q', 'autre');

  const res = await gitLog(topicId);
  expect(res.statusCode).toBe(200);
  const { live } = res.json<{ live: { onTopicBranch: boolean; headBranch: string | null } }>();
  expect(live.onTopicBranch).toBe(false);
  expect(live.headBranch).toBe('autre');
  expect(branch).not.toBe('autre');
});

test('GET .../git/log : onTopicBranch vrai et headBranch égal à la branche du sujet, chemin heureux', async () => {
  c = await setupWorkspace();
  const { branch, topicId } = await makeTopic(c);

  const res = await gitLog(topicId);
  const { live } = res.json<{ live: { onTopicBranch: boolean; headBranch: string | null } }>();
  expect(live.onTopicBranch).toBe(true);
  expect(live.headBranch).toBe(branch);
});

test('sujet.rattacher-branche : topics.branch adopte la branche réelle du worktree', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  sh(wt, 'branch', 'autre');
  sh(wt, 'checkout', '-q', 'autre');

  const run = await postAction(c, topicId, 'sujet.rattacher-branche');
  expect(run.statusCode).toBe(200);
  expect(run.json<{ branch: string }>().branch).toBe('autre');

  const row = c.t.db.prepare('SELECT branch FROM topics WHERE id = ?').get(topicId) as {
    branch: string;
  };
  expect(row.branch).toBe('autre');

  const res = await gitLog(topicId);
  const { live } = res.json<{ live: { onTopicBranch: boolean } }>();
  expect(live.onTopicBranch).toBe(true);
});

test('sujet.rattacher-branche : HEAD détachée, 422, rien ne change en base', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  sh(wt, 'checkout', '-q', '--detach', 'HEAD');

  const run = await postAction(c, topicId, 'sujet.rattacher-branche');
  expect(run.statusCode).toBe(422);

  const row = c.t.db.prepare('SELECT branch FROM topics WHERE id = ?').get(topicId) as {
    branch: string;
  };
  expect(row.branch).toBe(branch);
});

test('branche.revenir : chemin heureux, le worktree revient sur la branche du sujet', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  sh(wt, 'branch', 'autre');
  sh(wt, 'checkout', '-q', 'autre');

  const run = await postAction(c, topicId, 'branche.revenir');
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(currentBranch(wt)).toBe(branch);

  const res = await gitLog(topicId);
  const { live } = res.json<{ live: { onTopicBranch: boolean; headBranch: string | null } }>();
  expect(live.onTopicBranch).toBe(true);
  expect(live.headBranch).toBe(branch);
});

test('branche.revenir : branche du sujet déjà extraite dans un autre worktree A-I-D, 409', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  // Libère un.branch côté un.wt, puis l'extrait ailleurs (deux.wt) : un.wt n'est plus le
  // détenteur de sa propre branche de sujet quand branche.revenir tente d'y revenir.
  sh(un.wt, 'checkout', '-q', '-b', 'autre');
  sh(deux.wt, 'checkout', '-q', un.branch);

  const run = await postAction(c, un.topicId, 'branche.revenir');
  expect(run.statusCode).toBe(409);
  expect(currentBranch(un.wt)).toBe('autre');
});

test('branche.revenir : worktree manquant, 409', async () => {
  c = await setupWorkspace();
  const created = (await postCreate(c, 'Draft')).json<{ actionId: string; topicId: string }>();
  const r = await postAction(c, created.topicId, 'branche.revenir');
  expect(r.statusCode).toBe(409);
  await finished(c.t, created.actionId);
});
