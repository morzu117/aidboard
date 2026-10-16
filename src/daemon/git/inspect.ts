import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './exec.js';

export interface RepoInfo {
  root: string;
  baseBranch: string | null;
  hasOrigin: boolean;
  /** branche courante (dépôt sans origin : la base par défaut) */
  currentBranch: string | null;
  isLinkedWorktree: boolean;
  hasCodegraph: boolean;
}

export class NotARepo extends Error {}

export async function inspectRepo(path: string): Promise<RepoInfo> {
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
    hasCodegraph: existsSync(join(real, '.codegraph')),
  };
}

export async function localBranchExists(root: string, branch: string): Promise<boolean> {
  return (await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
}

export async function remoteBranchExists(root: string, branch: string): Promise<boolean> {
  return (await git(root, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).ok;
}
