// 11.2/11.3 : formes partagées daemon/web pour le journal de commits (D24, jamais de
// géométrie de graphe calculée côté serveur — reconstruite côté client à partir de ces champs).

export interface GitLogCommit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  message: string;
  refs: string[];
  inHead: boolean;
}

export interface GitLiveInfo {
  aheadBehind: { ahead: number; behind: number } | null;
  rebaseInProgress: boolean;
  onTopicBranch: boolean;
  // 11.10 (D28) : branche réelle du worktree, null en HEAD détachée — alimente le bandeau de
  // dérive (3.6) sans second appel git.
  headBranch: string | null;
}

export interface GitLogResponse {
  commits: GitLogCommit[];
  // Modifications non commitées (suivies ou non) : affiche le commit WIP en tête de graphe.
  dirty: boolean;
  // 11.4 : même passage que commits/dirty — alimente la bannière de situation (fetch/pousser).
  live: GitLiveInfo;
}

export interface GitFileChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | '?';
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitDetail {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  message: string;
  body: string;
  refs: string[];
  inHead: boolean;
  files: GitFileChange[];
}

// 11.5 : une branche locale avec sa méta — le regroupement (branche du sujet / branches
// liées / autres, design/aid-export-git-flow) se fait côté client à partir de ces champs.
export interface GitBranch {
  name: string;
  hash: string;
  date: string;
  ahead: number;
  behind: number;
  // Chemin du worktree où elle est extraite, null si aucun (ou si c'est celui-ci même).
  worktree: string | null;
  isCurrent: boolean;
  // Sujet A-I-D propriétaire de cette branche dans ce workspace, si ce n'est pas celui-ci.
  topicId: string | null;
  // 15 (review 5) : cible de la libération de `worktree` si on la prend — null = détacher ;
  // absent quand `worktree` est null (branche courante ou non extraite ailleurs).
  liberationVers?: string | null;
}

export interface GitBranchesResponse {
  branches: GitBranch[];
}
