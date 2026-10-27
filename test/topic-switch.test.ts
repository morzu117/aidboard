import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// 15 : « Libérer puis prendre » — X est le dossier qui détient déjà la branche visée.
test('topic.branch-changer : liberer, branche à la racine et base libre → racine sur la base', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  sh(c.ws.root, 'switch', '-c', 'convoitee');
  const tipAvant = sh(c.ws.root, 'rev-parse', 'HEAD');

  const run = await switchTo(topicId, { targetBranch: 'convoitee', liberer: true });
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(currentBranch(wt)).toBe('convoitee');
  expect(currentBranch(c.ws.root)).toBe('main');
  // la racine change de branche, pas de commit : la libération ne doit rien déplacer.
  expect(sh(c.ws.root, 'rev-parse', 'HEAD')).toBe(tipAvant);
});

test('topic.branch-changer : liberer, branche dans le worktree d’un autre sujet → détaché au même commit', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  const tipDeux = sh(deux.wt, 'rev-parse', 'HEAD');

  const run = await switchTo(un.topicId, { targetBranch: deux.branch, liberer: true });
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(currentBranch(un.wt)).toBe(deux.branch);
  expect(currentBranch(deux.wt)).toBe('HEAD');
  expect(sh(deux.wt, 'rev-parse', 'HEAD')).toBe(tipDeux);
});

// review (3, 4d) : X sale est désormais un refus synchrone (409) côté route — remplace l'ancien
// needs_human (le script garde sa propre vérification en défense, la route double devant).
test('topic.branch-changer : liberer, X sale → 409 synchrone, rien ne bouge', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  writeFileSync(join(deux.wt, 'brouillon.txt'), 'en cours\n');

  const run = await switchTo(un.topicId, { targetBranch: deux.branch, liberer: true });
  expect(run.statusCode).toBe(409);
  expect(run.json().error).toContain(deux.wt);
  expect(currentBranch(un.wt)).toBe(un.branch);
  expect(currentBranch(deux.wt)).toBe(deux.branch);
  expect(existsSync(join(deux.wt, 'brouillon.txt'))).toBe(true);
});

// review (4a) : la propreté du sujet courant se vérifie avant de toucher à X — un refus ici ne
// doit pas l'avoir libéré entre-temps.
test('topic.branch-changer : liberer, sujet courant sale sans stash → needs_human, X intact', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  writeFileSync(join(un.wt, 'brouillon.txt'), 'en cours\n');

  const run = await switchTo(un.topicId, { targetBranch: deux.branch, liberer: true });
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data).toMatchObject({ outcome: 'needs_human', exitCode: 2 });
  expect(currentBranch(un.wt)).toBe(un.branch);
  expect(currentBranch(deux.wt)).toBe(deux.branch);
  expect(existsSync(join(un.wt, 'brouillon.txt'))).toBe(true);
});

// review (4b) : la racine ne peut pas basculer sur la base si celle-ci est déjà extraite
// ailleurs — seule option alors : détacher, comme pour un worktree lié.
test('topic.branch-changer : liberer, racine détient la cible, base extraite ailleurs → racine détachée', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  sh(c.ws.root, 'switch', '-c', 'convoitee');
  const ailleurs = mkdtempSync(join(tmpdir(), 'aid-base-'));
  sh(c.ws.root, 'worktree', 'add', ailleurs, 'main');

  const run = await switchTo(topicId, { targetBranch: 'convoitee', liberer: true });
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(currentBranch(wt)).toBe('convoitee');
  expect(currentBranch(c.ws.root)).toBe('HEAD');
});

// review (1, 4c) : une fois X libéré, tout échec qui suit doit le dire (préfixe « a été
// libéré »). Provocation retenue : un fichier non lisible fait échouer `git stash push -u`
// lui-même (exit non nul, vérifié empiriquement) — pas le `git switch` suivant. Un fichier non
// suivi qui collisionne avec la branche cible, lui, ne fait jamais échouer le switch dans ce
// scénario : la même mise de côté (`-u`, sans pathspec) l'emporte toujours avant, donc le
// switch qui suit retrouve un arbre propre et réussit — vérifié empiriquement, ce n'est pas une
// omission du script.
test('topic.branch-changer : X libéré, mise de côté du sujet échoue → message nommé', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  writeFileSync(join(un.wt, 'illisible.txt'), 'x');
  chmodSync(join(un.wt, 'illisible.txt'), 0o000);

  try {
    const run = await switchTo(un.topicId, {
      targetBranch: deux.branch,
      liberer: true,
      dirtyAction: 'stash',
    });
    expect(run.statusCode).toBe(202);
    const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
    expect(fin.data.outcome).toBe('failed');
    expect((fin.data.tail as string[]).some((l) => l.includes('a été libéré'))).toBe(true);
    expect(currentBranch(un.wt)).toBe(un.branch);
    expect(currentBranch(deux.wt)).toBe('HEAD');
  } finally {
    chmodSync(join(un.wt, 'illisible.txt'), 0o644);
  }
});

test('topic.branch-changer : liberer, agent actif dans le sujet de X → 409, rien ne bouge', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  const run2 = c.t.db.prepare('SELECT id FROM runs WHERE topic_id = ?').get(deux.topicId) as {
    id: string;
  };
  c.t.db
    .prepare(
      "INSERT INTO agents (id, run_id, kind, role, transport, status, cwd, command, pid, exit_code, issue, created_at, updated_at) VALUES ('ag_1', ?, 'shell', 'free', 'pty', 'starting', ?, '[]', NULL, NULL, NULL, 't', 't')",
    )
    .run(run2.id, deux.wt);

  const run = await switchTo(un.topicId, { targetBranch: deux.branch, liberer: true });
  expect(run.statusCode).toBe(409);
  expect(run.json().error).toContain(deux.slug);
  expect(currentBranch(un.wt)).toBe(un.branch);
  expect(currentBranch(deux.wt)).toBe(deux.branch);
});

test('topic.branch-changer : sans liberer, 409 « déjà extraite » comme avant', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');

  const run = await switchTo(un.topicId, { targetBranch: deux.branch });
  expect(run.statusCode).toBe(409);
  expect(run.json().error).toContain('déjà extraite');
  expect(currentBranch(un.wt)).toBe(un.branch);
  expect(currentBranch(deux.wt)).toBe(deux.branch);
});

test('topic.branch-changer : liberer, dossier disparu du disque (non prunné) → refus', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  rmSync(deux.wt, { recursive: true, force: true });

  const run = await switchTo(un.topicId, { targetBranch: deux.branch, liberer: true });
  expect(run.statusCode).toBe(409);
  expect(currentBranch(un.wt)).toBe(un.branch);
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
