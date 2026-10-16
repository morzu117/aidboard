// Slug de page mémoire : segments séparés par `/`, le premier est le namespace.
// À ne pas confondre avec SLUG_RE (slug de sujet, sans `/`).
export const MEM_SLUG_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/;
export const MEM_SLUG_MAX = 200;
export const MEM_SLUG_RULE =
  'slug de page : segments [a-z0-9._-] séparés par /, au moins deux, 200 caractères au plus';

// Namespace transverse du kernel : les leçons, lues avec tout scope, écrites par la rétro seule.
export const LESSON_NS = 'lesson';

export interface MemoryPage {
  slug: string;
  namespace: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  revision: number;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchHit {
  slug: string;
  title: string;
  snippet: string;
  score: number;
}

export type SearchMode = 'fts' | 'hybrid';

export type PutMode =
  | { kind: 'create' }
  | { kind: 'append' }
  | { kind: 'replace'; expectedRevision: number }
  | { kind: 'force' };

export type ProposalKind = 'tags' | 'duplicate' | 'split';
export type ProposalState = 'open' | 'applied' | 'rejected';

export interface MemoryProposal {
  id: string;
  kind: ProposalKind;
  slug: string;
  payload: unknown;
  rationale: string;
  state: ProposalState;
  createdAt: string;
  decidedAt: string | null;
}

export class RevisionConflict extends Error {
  constructor(
    readonly slug: string,
    readonly revision: number,
  ) {
    super('revision_conflict');
  }
}
