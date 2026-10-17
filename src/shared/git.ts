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

export interface GitLogResponse {
  commits: GitLogCommit[];
  // Modifications non commitées (suivies ou non) : affiche le commit WIP en tête de graphe.
  dirty: boolean;
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
