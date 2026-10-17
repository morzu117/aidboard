import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { isValidNamespace } from '../memory/slug.js';
import type { StructuralService } from '../structural/service.js';
import { git } from './exec.js';

export interface RepoInfo {
  root: string;
  baseBranch: string | null;
  hasOrigin: boolean;
  /** branche courante (dépôt sans origin : la base par défaut) */
  currentBranch: string | null;
  isLinkedWorktree: boolean;
  hasStructuralIndex: boolean;
}

export class NotARepo extends Error {}

export async function inspectRepo(path: string, structural: StructuralService): Promise<RepoInfo> {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new NotARepo(`chemin introuvable : ${path}`);
  }
  const top = await git(real, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new NotARepo(`${real} n'est pas un dépôt git`);
  if (realpathSync(top.stdout) !== real) {
    throw new NotARepo(`${real} n'est pas la racine du dépôt (${top.stdout})`);
  }
  const dir = await git(real, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = await git(real, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const origin = await git(real, ['remote', 'get-url', 'origin']);
  const head = await git(real, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const current = await git(real, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return {
    root: real,
    baseBranch: head.ok ? head.stdout.replace(/^origin\//, '') : null,
    hasOrigin: origin.ok,
    currentBranch: current.ok ? current.stdout : null,
    isLinkedWorktree: dir.stdout !== common.stdout,
    hasStructuralIndex: structural.detect(real),
  };
}

export async function localBranchExists(root: string, branch: string): Promise<boolean> {
  return (await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
}

// `project.namespace` d'un agent.yml à la racine (DM2) ; absent ou invalide → undefined.
export function readProjectNamespace(root: string): string | undefined {
  const file = join(root, 'agent.yml');
  if (!existsSync(file)) return undefined;
  try {
    const doc = parse(readFileSync(file, 'utf8')) as { project?: { namespace?: unknown } } | null;
    const ns = doc?.project?.namespace;
    return typeof ns === 'string' && isValidNamespace(ns) ? ns : undefined;
  } catch {
    return undefined;
  }
}

export async function remoteBranchExists(root: string, branch: string): Promise<boolean> {
  return (await git(root, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).ok;
}

// null en détached HEAD : pas une branche, rien à rapprocher de topic.branch.
export async function currentBranch(root: string): Promise<string | null> {
  const r = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.ok ? r.stdout : null;
}

export interface GitLiveInfo {
  aheadBehind: { ahead: number; behind: number } | null;
  rebaseInProgress: boolean;
}

// D16 : avance/retard et rebase en cours ne sont jamais stockés — relus en direct à chaque
// GET /api/state, comme currentBranch l'est déjà pour topic.branch.
export async function gitLiveInfo(worktree: string, base: string): Promise<GitLiveInfo> {
  const gitDir = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const rebaseInProgress =
    gitDir.ok &&
    (existsSync(join(gitDir.stdout, 'rebase-merge')) ||
      existsSync(join(gitDir.stdout, 'rebase-apply')));

  // HEAD plutôt que la branche : en rebase, HEAD est détaché, la branche ne résout plus rien.
  const counts = await git(worktree, [
    'rev-list',
    '--left-right',
    '--count',
    `origin/${base}...HEAD`,
  ]);
  if (!counts.ok) return { aheadBehind: null, rebaseInProgress };
  const [behind, ahead] = counts.stdout.split(/\s+/).map(Number);
  return { aheadBehind: { ahead: ahead ?? 0, behind: behind ?? 0 }, rebaseInProgress };
}
