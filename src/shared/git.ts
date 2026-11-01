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
  // re-dev (C5) : `worktree` est la racine du dépôt (realpath) — calculé par la même fonction
  // que liberationVers, évite toute comparaison de chemin côté web.
  liberationRacine?: boolean;
}

export interface GitBranchesResponse {
  branches: GitBranch[];
}

/** Chantier 17 (F.2) : un dépôt Git d'un serveur, relu par le shell du serveur à chaque appel (jamais stocké). */
export interface ServerGitRepo {
  /** Racine du dépôt, dans un dossier autorisé du serveur. */
  root: string;
  /** null en HEAD détachée. */
  branch: string | null;
  /** null dans un dépôt sans commit. */
  head: string | null;
  /** Fichiers modifiés ou non suivis ; null : `git status` n'a pas abouti (délai, échec), compte inconnu. */
  changes: number | null;
  /** Le dépôt a un remote `origin`. */
  origin: boolean;
  /** `origin/<branche>` s'il existe ; null pour une branche jamais poussée. */
  upstream: string | null;
  /**
   * Par rapport à `origin/<branche>` ; branche jamais poussée : avance = commits absents de tout `origin/*`,
   * retard 0. null sans origin ou sans commit.
   */
  aheadBehind: { ahead: number; behind: number } | null;
  /** Opération laissée en cours sur le serveur. */
  operation: 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect' | null;
}

export interface ServerGitStatus {
  serverId: string;
  path: string;
  resolved: string;
  /** null : le dossier n'est pas dans un dépôt Git (ou son dépôt sort des dossiers autorisés). */
  repo: ServerGitRepo | null;
  /** Dossier non Git : dépôts détectés dans les dossiers autorisés (chemins résolus) ; vide sinon. */
  repos: string[];
  readAt: string;
}

/** Même forme que le journal d'un sujet (composants de `OngletGit`), plus l'état du dépôt du serveur. */
export interface ServerGitLog extends GitLogResponse {
  serverId: string;
  path: string;
  scope: 'all' | 'branch';
  repo: ServerGitRepo;
  /** Fenêtre de commits pleine : l'historique continue au-delà. */
  truncated: boolean;
  readAt: string;
}
