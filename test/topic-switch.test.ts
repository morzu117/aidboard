import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // branches-libres : un fichier suivi modifié, pas un non-suivi (qui ne bloque plus).
  commitFile(wt, 'brouillon.txt', 'stable\n');
  writeFileSync(join(wt, 'brouillon.txt'), 'en cours\n');

  const run = await switchTo(topicId, { targetBranch: 'autre' });
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data).toMatchObject({ outcome: 'needs_human', exitCode: 2 });
  expect(currentBranch(wt)).toBe(branch);
  expect(existsSync(join(wt, 'brouillon.txt'))).toBe(true);
});

// branches-libres (b) : des non-suivis dans le worktree du sujet lui-même ne bloquent plus un
// changement de branche direct — échoue sur b22f3fc (needs_human) avant le correctif.
test('topic.branch-changer : sujet n’a que des non-suivis, changement direct réussit, fichier intact', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  sh(wt, 'branch', 'autre');
  writeFileSync(join(wt, 'brouillon.txt'), 'en cours\n');

  const run = await switchTo(topicId, { targetBranch: 'autre' });
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(currentBranch(wt)).toBe('autre');
  expect(existsSync(join(wt, 'brouillon.txt'))).toBe(true);
});

// branches-libres (d) : un non-suivi en conflit avec un fichier de la branche cible reste un
// échec propre — c'est `git switch` lui-même qui refuse, le fichier n'est jamais perdu.
test('topic.branch-changer : non-suivi en conflit avec la branche cible, échec propre, fichier intact', async () => {
  c = await setupWorkspace();
  const { wt, branch, topicId } = await makeTopic(c);
  sh(wt, 'switch', '-c', 'autre');
  commitFile(wt, 'conflit.txt', 'preexistant\n');
  sh(wt, 'switch', branch);
  writeFileSync(join(wt, 'conflit.txt'), 'non suivi\n');

  const run = await switchTo(topicId, { targetBranch: 'autre' });
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('failed');
  expect(currentBranch(wt)).toBe(branch);
  expect(existsSync(join(wt, 'conflit.txt'))).toBe(true);
  expect(readFileSync(join(wt, 'conflit.txt'), 'utf8')).toBe('non suivi\n');
});

test('topic.branch-changer : dirtyAction stash, remise de côté puis bascule', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  sh(wt, 'branch', 'autre');
  // branches-libres : un fichier suivi modifié, pas un non-suivi (qui ne bloque plus).
  commitFile(wt, 'brouillon.txt', 'stable\n');
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

// branches-libres (a) : la racine à libérer n'a que des non-suivis — ils ne doivent plus
// bloquer la libération, et doivent survivre au basculement. Échoue sur b22f3fc (409).
test('topic.branch-changer : liberer, racine n’a que des non-suivis, libération et changement réussissent, fichier intact', async () => {
  c = await setupWorkspace();
  const { wt, topicId } = await makeTopic(c);
  sh(c.ws.root, 'switch', '-c', 'convoitee');
  writeFileSync(join(c.ws.root, 'brouillon.txt'), 'en cours\n');

  const run = await switchTo(topicId, { targetBranch: 'convoitee', liberer: true });
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(currentBranch(wt)).toBe('convoitee');
  expect(currentBranch(c.ws.root)).toBe('main');
  expect(existsSync(join(c.ws.root, 'brouillon.txt'))).toBe(true);
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
  // branches-libres : un fichier suivi modifié, pas un non-suivi (qui ne bloque plus).
  commitFile(deux.wt, 'brouillon.txt', 'stable\n');
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
  // branches-libres : un fichier suivi modifié, pas un non-suivi (qui ne bloque plus).
  commitFile(un.wt, 'brouillon.txt', 'stable\n');
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

  try {
    const run = await switchTo(topicId, { targetBranch: 'convoitee', liberer: true });
    expect(run.statusCode).toBe(202);
    const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
    expect(fin.data.outcome).toBe('succeeded');
    expect(currentBranch(wt)).toBe('convoitee');
    expect(currentBranch(c.ws.root)).toBe('HEAD');
  } finally {
    // C10 : worktree de test retiré — un `prune` oublié ici fausserait les tests suivants.
    sh(c.ws.root, 'worktree', 'remove', '--force', ailleurs);
    rmSync(ailleurs, { recursive: true, force: true });
  }
});

// C6(iii)/(iv) : shim `git` placé en tête de PATH, qui ne fait échouer qu'une commande précise
// et délègue tout le reste au vrai git — déterministe, indépendant des permissions (chmod 000
// n'a aucun effet sous root, cas fréquent en CI).
function installGitShim(failArgs: string): { dir: string; restore: () => void } {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const dir = mkdtempSync(join(tmpdir(), 'aid-git-shim-'));
  writeFileSync(
    join(dir, 'git'),
    [
      '#!/usr/bin/env bash',
      `if [ "$*" = ${JSON.stringify(failArgs)} ]; then`,
      '  echo "git: échec simulé (test shim)" >&2',
      '  exit 1',
      'fi',
      `exec ${JSON.stringify(realGit)} "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'git'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  return {
    dir,
    restore: () => {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// review (1, 4c) : une fois X libéré, tout échec qui suit doit le dire (préfixe « a été
// libéré »). C6(iv) : remplace l'ancienne provocation par chmod 000 (sans effet sous root) par
// le shim — fait échouer `git stash push` lui-même, pas le `git switch` suivant.
test('topic.branch-changer : X libéré, mise de côté du sujet échoue → message nommé', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  // branches-libres : un fichier suivi modifié, pas un non-suivi (qui ne bloque plus).
  commitFile(un.wt, 'brouillon.txt', 'stable\n');
  writeFileSync(join(un.wt, 'brouillon.txt'), 'en cours\n');

  const shim = installGitShim(`stash push -u -m aid/branche/${deux.branch}`);
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
    shim.restore();
  }
});

// C6(iii) : le switch du sujet échoue sous X déjà libéré — le stash doit être restitué
// (B1 : `git stash pop <sha>` échoue toujours, c'est du code mort sur 66aae1d, ce test y échoue).
test('topic.branch-changer : X libéré, le switch du sujet échoue → stash restitué, message nommé', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  // branches-libres : un fichier suivi modifié, pas un non-suivi (qui ne bloque plus) — sinon
  // rien n'est stashé et ce test n'exerce plus la restitution qu'il prétend couvrir.
  commitFile(un.wt, 'brouillon.txt', 'stable\n');
  writeFileSync(join(un.wt, 'brouillon.txt'), 'en cours\n');

  const shim = installGitShim(`switch ${deux.branch}`);
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
    expect(existsSync(join(un.wt, 'brouillon.txt'))).toBe(true);
    expect(sh(un.wt, 'stash', 'list')).toBe('');
  } finally {
    shim.restore();
  }
});

// C6(ii) : marqueur d'opération en cours dans X (hors modification non commitée) → même refus
// synchrone 409 que X sale, vérifié via la route.
test('topic.branch-changer : liberer, marqueur REVERT_HEAD dans X → 409 synchrone, rien ne bouge', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  const gitDir = sh(deux.wt, 'rev-parse', '--path-format=absolute', '--git-dir');
  writeFileSync(join(gitDir, 'REVERT_HEAD'), `${sh(deux.wt, 'rev-parse', 'HEAD')}\n`);

  const run = await switchTo(un.topicId, { targetBranch: deux.branch, liberer: true });
  expect(run.statusCode).toBe(409);
  expect(run.json().error).toContain(deux.wt);
  expect(currentBranch(un.wt)).toBe(un.branch);
  expect(currentBranch(deux.wt)).toBe(deux.branch);
});

// C6(ii) : le script lui-même refuse aussi un marqueur d'opération en cours dans X, appelé
// directement (sans passer par la route, qui ne fait que doubler cette défense).
test('topic-switch.sh (appel direct) : marqueur BISECT_LOG dans X → die_human, rien ne bouge', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const deux = await makeTopic(c, 'Second');
  const gitDir = sh(deux.wt, 'rev-parse', '--path-format=absolute', '--git-dir');
  writeFileSync(join(gitDir, 'BISECT_LOG'), 'test\n');

  const script = join(import.meta.dirname, '..', 'scripts', 'git', 'topic-switch.sh');
  let threw = false;
  try {
    execFileSync('bash', [script], {
      cwd: un.wt,
      env: {
        ...process.env,
        AID_REPO_ROOT: c.ws.root,
        AID_BRANCH: un.branch,
        AID_WORKTREE: un.wt,
        AID_TARGET_BRANCH: deux.branch,
        AID_LIBERER: '1',
        AID_LIBERER_DOSSIER: deux.wt,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    threw = true;
    const e = err as { status: number | null; stderr: Buffer };
    expect(e.status).toBe(2);
    expect(e.stderr.toString()).toContain('modifications non commitées');
  }
  expect(threw).toBe(true);
  expect(currentBranch(un.wt)).toBe(un.branch);
  expect(currentBranch(deux.wt)).toBe(deux.branch);
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

// branches-libres : un nom invalide pour git est déjà refusé proprement par le script (git
// switch -c échoue lui-même) — échec nommé, pas un 500 ni un état incohérent.
test('branche.creer : nom invalide pour git, échec nommé', async () => {
  c = await setupWorkspace();
  const { topicId } = await makeTopic(c);

  const run = await postAction(c, topicId, 'branche.creer', { targetBranch: 'a b' });
  expect(run.statusCode).toBe(202);
  const fin = await finished(c.t, run.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('failed');
  expect((fin.data.tail as string[]).some((l) => l.includes('not a valid branch name'))).toBe(true);
});
