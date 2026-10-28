import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { GitBranch } from '../src/shared/git.js';
import { commitFile, sh } from './helpers/git.js';
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
    // C6(i) : cible dans un worktree lié (pas la racine) → rien à libérer vers, pas la racine.
    liberationVers: null,
    liberationRacine: false,
  });
});

// C6(i) / C3 : la racine détient la cible et la base est libre → bascule sur la base du
// WORKSPACE (celle du sujet peut diverger, voir plus bas).
test('GET /git/branches : racine détient la cible, base libre → liberationVers = base du workspace', async () => {
  c = await setupWorkspace();
  const { topicId } = await makeTopic(c);
  sh(c.ws.root, 'switch', '-c', 'convoitee');

  const r = await getBranches(topicId);
  const byName = new Map(r.json<{ branches: GitBranch[] }>().branches.map((b) => [b.name, b]));
  expect(byName.get('convoitee')).toMatchObject({ liberationVers: 'main', liberationRacine: true });
});

// C6(i) : la racine ne peut pas basculer sur la base si celle-ci est déjà extraite ailleurs —
// liberationVers devient null, mais liberationRacine reste vrai (c'est toujours la racine).
test('GET /git/branches : racine détient la cible, base extraite ailleurs → liberationVers = null', async () => {
  c = await setupWorkspace();
  const { topicId } = await makeTopic(c);
  sh(c.ws.root, 'switch', '-c', 'convoitee');
  const ailleurs = mkdtempSync(join(tmpdir(), 'aid-base-'));
  sh(c.ws.root, 'worktree', 'add', ailleurs, 'main');
  try {
    const r = await getBranches(topicId);
    const byName = new Map(r.json<{ branches: GitBranch[] }>().branches.map((b) => [b.name, b]));
    expect(byName.get('convoitee')).toMatchObject({ liberationVers: null, liberationRacine: true });
  } finally {
    sh(c.ws.root, 'worktree', 'remove', '--force', ailleurs);
    rmSync(ailleurs, { recursive: true, force: true });
  }
});

// C3 : la route lisait encore row.base (base du SUJET) — si elle diverge de celle du workspace,
// c'est cette dernière qui doit sortir, pas la première.
test('GET /git/branches : base du sujet différente de celle du workspace → base du workspace qui sort', async () => {
  c = await setupWorkspace();
  const { topicId } = await makeTopic(c);
  c.t.db.prepare('UPDATE topics SET base = ? WHERE id = ?').run('autrebase', topicId);
  sh(c.ws.root, 'switch', '-c', 'convoitee');

  const r = await getBranches(topicId);
  const byName = new Map(r.json<{ branches: GitBranch[] }>().branches.map((b) => [b.name, b]));
  expect(byName.get('convoitee')?.liberationVers).toBe('main');
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
