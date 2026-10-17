// 11.7 : arbre de fichiers + statut git fusionnés (D29). L'agrégation (dossier marqué dès
// qu'un descendant a un statut) se fait côté serveur ; le repli/dépli et les badges sont
// côté client, à partir de ces champs bruts.
export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'U' | '•' | '';

export interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  status: FileStatus;
  entries?: FileNode[];
}

export interface FilesResponse {
  tree: FileNode[];
  total: number;
  modified: number;
  truncated: boolean;
}

export interface FileContentResponse {
  content: string;
}
