import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { commitFile, sh } from './helpers/git.js';
import { type Ctx, finished, makeTopic, postAction, setupWorkspace } from './helpers/topics.js';

let c: Ctx;
const spawned: number[] = [];
afterEach(async () => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // déjà mort
    }
  }
  await c?.t.d.stop();
});

const hasBranch = (branch: string) => sh(c.clone, 'branch', '--list', branch) !== '';
const topicState = (id: string) =>
  (c.t.db.prepare('SELECT state FROM topics WHERE id = ?').get(id) as { state: string }).state;

async function cleanup(topicId: string, body?: Record<string, unknown>) {
  const r = await postAction(c, topicId, 'topic.cleanup', body);
  expect(r.statusCode).toBe(202);
  return finished(c.t, r.json().actionId);
}

test('un fichier suivi modifié : refusé, worktree et branche intacts', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  writeFileSync(join(wt, 'README.md'), 'modifié\n');
  const fin = await cleanup(topicId);
  expect(fin.data).toMatchObject({ outcome: 'needs_human', exitCode: 2 });
  expect((fin.data.tail as string[]).join('\n')).toContain('non commitées');
  expect(existsSync(wt)).toBe(true);
  expect(hasBranch(branch)).toBe(true);
  expect(topicState(topicId)).toBe('active');
});

test('un fichier non suivi : refusé de la même façon', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  writeFileSync(join(wt, 'brouillon.txt'), 'à garder\n');
  const fin = await cleanup(topicId);
  expect(fin.data.outcome).toBe('needs_human');
  expect(existsSync(join(wt, 'brouillon.txt'))).toBe(true);
  expect(hasBranch(branch)).toBe(true);
});

test('un commit local non fusionné : refusé avec son compte, intact', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  commitFile(wt, 'a.txt', 'a');
  const fin = await cleanup(topicId);
  expect(fin.data).toMatchObject({ outcome: 'needs_human', result: { unmergedCommits: 1 } });
  expect(existsSync(wt)).toBe(true);
  expect(hasBranch(branch)).toBe(true);
});

test('la confirmation doit répéter le nombre exact de commits', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  commitFile(wt, 'a.txt', 'a');
  expect((await cleanup(topicId, { confirmUnmerged: 2 })).data.outcome).toBe('needs_human');
  expect(existsSync(wt)).toBe(true);
  const ok = await cleanup(topicId, { confirmUnmerged: 1 });
  expect(ok.data.outcome).toBe('succeeded');
  expect(existsSync(wt)).toBe(false);
  expect(hasBranch(branch)).toBe(false);
  expect(topicState(topicId)).toBe('archived');
});

test('une confirmation périmée (un commit de plus depuis) est refusée', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  commitFile(wt, 'a.txt', 'a');
  commitFile(wt, 'b.txt', 'b');
  expect((await cleanup(topicId, { confirmUnmerged: 1 })).data.outcome).toBe('needs_human');
  expect(existsSync(wt)).toBe(true);
});

test('une branche identique à origin/main : supprimée sans confirmation, sujet archivé', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  const fin = await cleanup(topicId);
  expect(fin.data).toMatchObject({ outcome: 'succeeded', result: { removed: true } });
  expect(existsSync(wt)).toBe(false);
  expect(hasBranch(branch)).toBe(false);
  expect(topicState(topicId)).toBe('archived');
});

test('un agent vivant : 409, rien n’est lancé', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  const run = c.t.db.prepare('SELECT id FROM runs WHERE topic_id = ?').get(topicId) as {
    id: string;
  };
  c.t.db
    .prepare(
      "INSERT INTO agents VALUES ('ag_1', ?, 'shell', 'free', 'pty', 'starting', ?, '[]', NULL, NULL, NULL, 't', 't')",
    )
    .run(run.id, wt);
  const r = await postAction(c, topicId, 'topic.cleanup');
  expect(r.statusCode).toBe(409);
  expect(r.json().agents).toHaveLength(1);
  expect(
    c.t.store
      .since(null)
      .some((e) => e.type === 'action.started' && e.data.action === 'topic.cleanup'),
  ).toBe(false);
  expect(existsSync(wt)).toBe(true);
});

test('le démon d’index du worktree est arrêté quand c’est bien un codegraph', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  mkdirSync(join(wt, '.codegraph'));
  const child = spawn('bash', ['-c', 'exec -a codegraph-fake sleep 300'], {
    detached: true,
    stdio: 'ignore',
  });
  spawned.push(child.pid!);
  writeFileSync(join(wt, '.codegraph', 'daemon.pid'), String(child.pid));
  await new Promise((r) => setTimeout(r, 150));
  expect((await cleanup(topicId)).data.outcome).toBe('succeeded');
  await new Promise((r) => setTimeout(r, 200));
  expect(() => process.kill(child.pid!, 0)).toThrow();
});

test('un pid périmé réutilisé par un autre programme n’est jamais tué', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  mkdirSync(join(wt, '.codegraph'));
  const innocent = spawn('sleep', ['301'], { detached: true, stdio: 'ignore' });
  spawned.push(innocent.pid!);
  writeFileSync(join(wt, '.codegraph', 'daemon.pid'), String(innocent.pid));
  expect((await cleanup(topicId)).data.outcome).toBe('succeeded');
  expect(() => process.kill(innocent.pid!, 0)).not.toThrow();
});

test('un .codegraph non ignoré par git ne bloque pas le nettoyage', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  mkdirSync(join(wt, '.codegraph'));
  writeFileSync(join(wt, '.codegraph', 'codegraph.db'), 'x');
  expect((await cleanup(topicId)).data.outcome).toBe('succeeded');
  expect(existsSync(wt)).toBe(false);
});

test('un worktree effacé à la main : la branche propre est supprimée, le sujet archivé', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  rmSync(wt, { recursive: true, force: true });
  const fin = await cleanup(topicId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(hasBranch(branch)).toBe(false);
  expect(topicState(topicId)).toBe('archived');
});

test('un worktree effacé à la main garde le contrôle des commits non fusionnés', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  commitFile(wt, 'a.txt', 'a');
  rmSync(wt, { recursive: true, force: true });
  expect((await cleanup(topicId)).data.outcome).toBe('needs_human');
  expect(hasBranch(branch)).toBe(true);
});

test('nettoyer un sujet ne touche pas aux autres', async () => {
  c = await setupWorkspace();
  const a = await makeTopic(c, 'Premier');
  const b = await makeTopic(c, 'Second');
  await cleanup(a.topicId);
  expect(existsSync(b.wt)).toBe(true);
  expect(hasBranch(b.branch)).toBe(true);
  expect(topicState(b.topicId)).toBe('active');
});

test('sujet inconnu : 404 ; action inconnue : 404 ; sujet déjà archivé : 409', async () => {
  c = await setupWorkspace();
  const { topicId } = await makeTopic(c);
  expect((await postAction(c, 'tp_nope', 'topic.cleanup')).statusCode).toBe(404);
  expect((await postAction(c, topicId, 'topic.explose')).statusCode).toBe(404);
  await cleanup(topicId);
  expect((await postAction(c, topicId, 'topic.cleanup')).statusCode).toBe(409);
});

test('dépôt sans origin : sujet créé depuis la branche locale, nettoyage comparé à elle', async () => {
  c = await setupWorkspace({ local: true });
  const { wt, branch, topicId } = await makeTopic(c);
  expect(sh(wt, 'rev-parse', 'HEAD')).toBe(sh(c.clone, 'rev-parse', 'main'));
  commitFile(wt, 'a.txt', 'a');
  const refus = await cleanup(topicId);
  expect(refus.data).toMatchObject({ outcome: 'needs_human', result: { unmergedCommits: 1 } });
  // fusionné dans main en local : plus rien à confirmer
  sh(c.clone, 'merge', '-q', '--ff-only', branch);
  const ok = await cleanup(topicId);
  expect(ok.data.outcome).toBe('succeeded');
  expect(existsSync(wt)).toBe(false);
  expect(hasBranch(branch)).toBe(false);
});
