import { realpathSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import type { GitBranch } from '../src/shared/git.js';
import { commitFile } from './helpers/git.js';
import { type Ctx, makeTopic, postCreate, setupWorkspace } from './helpers/topics.js';

let c: Ctx;
afterEach(async () => {
  await c?.t.d.stop();
});

const getBranches = async (topicId: string) =>
  c.t.d.app.inject({ url: `/api/topics/${topicId}/git/branches`, headers: c.t.headers });

test('GET /git/branches : branche du sujet (isCurrent), branche liée à un autre sujet', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  commitFile(un.wt, 'avance.md', 'avance\n');

  const r = await getBranches(un.topicId);
  expect(r.statusCode).toBe(200);
  const byName = new Map(r.json<{ branches: GitBranch[] }>().branches.map((b) => [b.name, b]));

  expect(byName.get(un.branch)).toMatchObject({
    isCurrent: true,
    worktree: null,
    topicId: null,
    ahead: 1,
    behind: 0,
  });
  expect(byName.get(deux.branch)).toMatchObject({
    isCurrent: false,
    worktree: realpathSync(deux.wt),
    topicId: deux.topicId,
  });
});

test('GET /git/branches : 404 si le sujet est inconnu', async () => {
  c = await setupWorkspace();
  const r = await c.t.d.app.inject({
    url: '/api/topics/inconnu/git/branches',
    headers: c.t.headers,
  });
  expect(r.statusCode).toBe(404);
});

test('GET /git/branches : 409 si le worktree est introuvable', async () => {
  c = await setupWorkspace();
  const created = (await postCreate(c, 'Draft')).json<{ topicId: string }>();
  const r = await getBranches(created.topicId);
  expect(r.statusCode).toBe(409);
});
