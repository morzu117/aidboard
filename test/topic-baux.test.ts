import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

const scripts = join(import.meta.dirname, '../scripts/git');
function preparer() {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-baux-'));
  const repo = makeOriginAndClone(dossier);
  sh(repo.clone, 'checkout', '-b', 'sujet');
  return { ...repo, dossier, tete: sh(repo.clone, 'rev-parse', 'HEAD') };
}
function lancer(script: string, cwd: string, env: Record<string, string>) {
  return spawnSync('bash', [join(scripts, script)], {
    cwd,
    env: { ...process.env, AID_BRANCH: 'sujet', ...env },
    encoding: 'utf8',
  });
}

test('push : refuse une tête locale périmée sans modifier la distante', () => {
  const { clone, origin, tete } = preparer();
  commitFile(clone, 'suite', 'suite');
  const resultat = lancer('topic-push.sh', clone, { AID_PUSH_TETE: tete, AID_PUSH_DISTANTE: '' });
  expect(resultat.status).toBe(2);
  expect(sh(origin, 'branch', '--list', 'sujet')).toBe('');
});

test('push : premier bail vide accepté, puis refusé si la distante existe', () => {
  const { clone, origin, tete } = preparer();
  const env = { AID_PUSH_TETE: tete, AID_PUSH_DISTANTE: '' };
  expect(lancer('topic-push.sh', clone, env).status).toBe(0);
  expect(sh(origin, 'rev-parse', 'sujet')).toBe(tete);
  commitFile(clone, 'suite', 'suite');
  expect(
    lancer('topic-push.sh', clone, { ...env, AID_PUSH_TETE: sh(clone, 'rev-parse', 'HEAD') })
      .status,
  ).not.toBe(0);
  expect(sh(origin, 'rev-parse', 'sujet')).toBe(tete);
});

test('push : refuse une distante avancée entre la lecture et le push', () => {
  const { clone, origin, dossier, tete } = preparer();
  sh(clone, 'push', 'origin', 'sujet');
  const autre = join(dossier, 'autre');
  sh(dossier, 'clone', '-q', '--branch', 'sujet', origin, autre);
  commitFile(autre, 'autre', 'autre');
  sh(autre, 'push', 'origin', 'sujet');
  const distante = sh(origin, 'rev-parse', 'sujet');
  commitFile(clone, 'suite', 'suite');
  const resultat = lancer('topic-push.sh', clone, {
    AID_PUSH_TETE: sh(clone, 'rev-parse', 'HEAD'),
    AID_PUSH_DISTANTE: tete,
  });
  expect(resultat.status).not.toBe(0);
  expect(resultat.stderr).toContain('stale info');
  expect(sh(origin, 'rev-parse', 'sujet')).toBe(distante);
});

test('push : refuse une tête sans bail distant explicite', () => {
  const { clone, tete } = preparer();
  expect(lancer('topic-push.sh', clone, { AID_PUSH_TETE: tete }).status).toBe(2);
});

test('cleanup : bail périmé ou vide refusé, puis bonne tête supprime branche et worktree', () => {
  const { clone, dossier, tete } = preparer();
  sh(clone, 'checkout', 'main');
  const wt = join(dossier, 'worktree');
  sh(clone, 'worktree', 'add', wt, 'sujet');
  commitFile(wt, 'suite', 'suite');
  const actuelle = sh(wt, 'rev-parse', 'HEAD');
  const env = {
    AID_REPO_ROOT: clone,
    AID_WORKTREE: wt,
    AID_BASE: 'main',
    AID_CONFIRM_UNMERGED: '1',
    AID_CODEGRAPH_BIN: '/bin/true',
  };
  for (const attendue of [tete, '']) {
    expect(lancer('topic-cleanup.sh', wt, { ...env, AID_CLEANUP_TETE: attendue }).status).toBe(2);
    expect(existsSync(wt)).toBe(true);
    expect(sh(clone, 'rev-parse', 'sujet')).toBe(actuelle);
  }
  const fin = lancer('topic-cleanup.sh', wt, { ...env, AID_CLEANUP_TETE: actuelle });
  expect(fin.status, fin.stderr).toBe(0);
  expect(existsSync(wt)).toBe(false);
  expect(sh(clone, 'branch', '--list', 'sujet')).toBe('');
});

test('merge : tête exigée absente ou invalide refusée avant gh', () => {
  const { clone, dossier } = preparer();
  const log = join(dossier, 'gh.log');
  for (const head of [undefined, '', 'invalide']) {
    expect(
      lancer('topic-merge.sh', clone, {
        AID_PR_NUMBER: '1',
        AID_MERGE_STRATEGY: 'squash',
        AID_MERGE_EXIGER_TETE: '1',
        AID_GH_BIN: join(import.meta.dirname, 'fixtures/fake-gh.sh'),
        FAKE_GH_MERGE_LOG: log,
        ...(head !== undefined && { AID_MERGE_HEAD: head }),
      }).status,
    ).toBe(2);
    expect(existsSync(log)).toBe(false);
  }
});
