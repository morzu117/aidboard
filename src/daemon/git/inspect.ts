import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type {
  GitCommitDetail,
  GitFileChange,
  GitLiveInfo,
  GitLogCommit,
} from '../../shared/git.js';
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

// D16 : avance/retard et rebase en cours ne sont jamais stockés — relus en direct à chaque
// GET /api/state, comme currentBranch l'est déjà pour topic.branch.
export async function gitLiveInfo(
  worktree: string,
  base: string,
  topicBranch?: string,
): Promise<GitLiveInfo> {
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
  const onTopicBranch =
    topicBranch === undefined ? true : (await currentBranch(worktree)) === topicBranch;
  if (!counts.ok) return { aheadBehind: null, rebaseInProgress, onTopicBranch };
  const [behind, ahead] = counts.stdout.split(/\s+/).map(Number);
  return {
    aheadBehind: { ahead: ahead ?? 0, behind: behind ?? 0 },
    rebaseInProgress,
    onTopicBranch,
  };
}

const LOG_FORMAT = '%H%x01%P%x01%an%x01%aI%x01%s%x01%D%x00';

function parseLog(raw: string, inHead: Set<string>): GitLogCommit[] {
  return raw
    .split('\x00')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, parents, author, date, message, refs] = record.split('\x01');
      return {
        hash: hash ?? '',
        parents: (parents ?? '').split(' ').filter(Boolean),
        author: author ?? '',
        date: date ?? '',
        message: message ?? '',
        refs: (refs ?? '').split(', ').filter(Boolean),
        inHead: inHead.has(hash ?? ''),
      };
    });
}

// 11.2 (D24) : commits bruts seulement — hash, parents, auteur, date, résumé, refs, et si le
// commit est atteignable depuis HEAD. Aucune géométrie de voie n'est calculée ici : le graphe
// se reconstruit côté client à partir de ces champs (design/aid-export-git-flow/README.md).
// Deux passes : les commits propres au sujet (origin/<base>..HEAD, jamais tronqués — c'est
// l'historique que le sujet doit voir en entier) puis une fenêtre bornée sur l'ensemble des
// branches locales et distantes visibles, pour les refs décorées sur l'historique partagé.
export async function gitLog(
  worktree: string,
  base: string,
  maxCount = 200,
): Promise<GitLogCommit[]> {
  const [own, shared, reachable] = await Promise.all([
    git(worktree, ['log', '--topo-order', `--format=${LOG_FORMAT}`, `origin/${base}..HEAD`]),
    git(worktree, [
      'log',
      '--topo-order',
      `--max-count=${maxCount}`,
      `--format=${LOG_FORMAT}`,
      '--branches',
      '--remotes',
    ]),
    git(worktree, ['rev-list', 'HEAD']),
  ]);
  const inHead = new Set(reachable.ok ? reachable.stdout.split('\n').filter(Boolean) : []);
  const commits = new Map<string, GitLogCommit>();
  for (const commit of [
    ...parseLog(own.ok ? own.stdout : '', inHead),
    ...parseLog(shared.ok ? shared.stdout : '', inHead),
  ]) {
    if (!commits.has(commit.hash)) commits.set(commit.hash, commit);
  }
  return [...commits.values()];
}

// 11.3 : signale le commit WIP (pointillé) dans le graphe — suivi ou non, peu importe lequel.
export async function hasUncommittedChanges(worktree: string): Promise<boolean> {
  const status = await git(worktree, ['status', '--porcelain']);
  return status.ok && status.stdout.length > 0;
}

const DETAIL_FORMAT = '%H%x01%P%x01%an%x01%aI%x01%s%x01%b%x01%D%x00';

// 11.3 : panneau de détail d'un commit — corps, parents, refs, et fichiers touchés avec leurs
// compteurs. Les renommages ne sont pas détectés (`-M` omis) : un renommage apparaît comme une
// suppression et une addition, plus simple à apparier entre numstat et name-status.
export async function gitCommitDetail(
  worktree: string,
  hash: string,
): Promise<GitCommitDetail | null> {
  const [show, numstat, nameStatus, ancestor] = await Promise.all([
    git(worktree, ['show', '--no-patch', `--format=${DETAIL_FORMAT}`, hash]),
    git(worktree, ['diff-tree', '--no-commit-id', '-r', '--numstat', hash]),
    git(worktree, ['diff-tree', '--no-commit-id', '-r', '--name-status', hash]),
    git(worktree, ['merge-base', '--is-ancestor', hash, 'HEAD']),
  ]);
  if (!show.ok) return null;
  const header = show.stdout.split('\x00')[0] ?? '';
  const [h, parents, author, date, message, body, refs] = header.split('\x01');

  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of numstat.ok ? numstat.stdout.split('\n').filter(Boolean) : []) {
    const [a, d, ...rest] = line.split('\t');
    counts.set(rest.join('\t'), {
      additions: a === '-' ? null : Number(a),
      deletions: d === '-' ? null : Number(d),
    });
  }
  const statusByPath = new Map<string, GitFileChange['status']>();
  for (const line of nameStatus.ok ? nameStatus.stdout.split('\n').filter(Boolean) : []) {
    const [code, ...rest] = line.split('\t');
    const letter = code?.[0] as GitFileChange['status'] | undefined;
    statusByPath.set(
      rest.join('\t'),
      letter && ['A', 'M', 'D', 'R'].includes(letter) ? letter : '?',
    );
  }
  const files: GitFileChange[] = [...counts.entries()].map(([path, c]) => ({
    path,
    status: statusByPath.get(path) ?? '?',
    additions: c.additions,
    deletions: c.deletions,
  }));

  return {
    hash: h || hash,
    parents: (parents ?? '').split(' ').filter(Boolean),
    author: author ?? '',
    date: date ?? '',
    message: message ?? '',
    body: (body ?? '').trim(),
    refs: (refs ?? '').split(', ').filter(Boolean),
    inHead: ancestor.ok,
    files,
  };
}
