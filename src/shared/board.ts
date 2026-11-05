// Modèle partagé du board swarph en lecture seule (chantier 24). Le daemon parse la sortie JSON de
// `swarph board … --json`, l'interface affiche ces formes-ci. Le format n'est pas un contrat versionné
// (le bloc 14 du lab n'est pas livré) : tout est défensif (D96). Un champ inconnu est ignoré, un champ
// absent ou d'un type inattendu devient `null`, et rien ne lève d'exception.

export type BoardErrorKind =
  | 'forbidden'
  | 'unreachable'
  | 'credential'
  | 'timeout'
  | 'too-old'
  | 'absent'
  | 'format'
  | 'unknown';

/** Réponse de chaque route `/api/board/…` (D95) : toujours 200, un résultat discriminé. */
export type BoardResult<T> =
  | { ok: true; data: T; readAt: string; schemaVersion: string | null }
  | { ok: false; kind: BoardErrorKind; readAt: string };

export interface BoardProject {
  id: number;
  slug: string | null;
  title: string | null;
  status: string | null;
  author: string;
}

export interface BoardCardSummary {
  id: number;
  projectId: number | null;
  title: string | null;
  stage: string | null;
  /** un pair, jamais une personne */
  assignee: string | null;
  dueAt: string | null;
  openObligations: number;
}

export interface BoardStageEntry {
  stage: string | null;
  at: string | null;
  /** auteur affiché : le pair, ou « gateway (ligne N) » pour une entrée dérivée */
  by: string;
}

export interface BoardCard extends BoardCardSummary {
  body: string | null;
  author: string;
  createdAt: string | null;
  updatedAt: string | null;
  stageHistory: BoardStageEntry[];
  links: Record<string, string>;
}

export interface BoardStep {
  step: string | null;
  mandatory: boolean | null;
  /** texte complet, jamais abrégé : il explique le blocage */
  state: string | null;
  holder: string | null;
  due: string | null;
  row: number | null;
}

export interface BoardGraph {
  steps: BoardStep[];
  missing: string[];
  unconfirmed: string[];
  stageImplied: string | null;
}

export interface BoardObligation {
  id: number;
  step: string | null;
  holder: string | null;
  /** état officiel : il fait foi (#1456) */
  status: string | null;
  /** indicatif seulement, peut contredire `status` */
  state: string | null;
  closed: boolean;
  closedAt: string | null;
  closeOutcome: string | null;
  closeEvidence: string | null;
  fallbackPolicy: unknown;
  needsExtra: unknown;
}

export interface BoardObligations {
  obligations: BoardObligation[];
  truncated: boolean;
  asOf: string | null;
}

export interface BoardMessage {
  id: number;
  author: string;
  createdAt: string | null;
  content: string | null;
}

export interface BoardThread {
  messages: BoardMessage[];
  /** le nombre de messages a atteint la limite demandée : le fil peut être plus long */
  capped: boolean;
}

/** La fiche d'une carte : quatre lectures indépendantes, une partie en échec n'empêche pas les autres. */
export interface BoardCardSheet {
  card: BoardResult<BoardCard>;
  graph: BoardResult<BoardGraph>;
  thread: BoardResult<BoardThread>;
  obligations: BoardResult<BoardObligations>;
}

export interface Parsed<T> {
  value: T;
  schemaVersion: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : null;
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');

const UNKNOWN_AUTHOR = 'inconnu';

/** L'auteur affiché est la colonne que le gateway désigne, jamais un champ `claimed_*`. */
export const trustedAuthor = (obj: unknown): string => {
  if (!isObj(obj)) return UNKNOWN_AUTHOR;
  const column = str(obj.trusted_author_column);
  if (column === null || column.startsWith('claimed_')) return UNKNOWN_AUTHOR;
  const value = str(obj[column]);
  return value === null || value === '' ? UNKNOWN_AUTHOR : value;
};

/** Certaines colonnes sont du JSON dans une chaîne (`fallback_policy`, `needs_extra`). */
export const decodeJsonString = (s: unknown): unknown => {
  if (typeof s !== 'string') return s ?? null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
};

const schemaVersionOf = (root: unknown): string | null => {
  if (!isObj(root)) return null;
  const v = root.schema_version;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
};

const parsed = <T>(root: unknown, value: T): Parsed<T> => ({
  value,
  schemaVersion: schemaVersionOf(root),
});

const parseProject = (p: unknown): BoardProject | null => {
  if (!isObj(p)) return null;
  const id = int(p.id);
  if (id === null) return null;
  return {
    id,
    slug: str(p.slug),
    title: str(p.title),
    status: str(p.status),
    author: trustedAuthor(p),
  };
};

const countOpen = (v: unknown): number => arr(v).length;

const parseSummary = (c: Obj, id: number): BoardCardSummary => ({
  id,
  projectId: int(c.project_id),
  title: str(c.title),
  stage: str(c.stage),
  assignee: str(c.assignee),
  dueAt: str(c.due_at),
  openObligations: countOpen(c.open_obligations),
});

// Depuis le 4 novembre, le gateway écrit lui-même des entrées dérivées d'une ligne du graphe :
// `by: "gateway"`, `derived: true`, `row: <id>`. Ce n'est pas une personne.
const parseStageEntry = (e: unknown): BoardStageEntry | null => {
  if (!isObj(e)) return null;
  const by = str(e.by);
  const row = int(e.row);
  const derived = e.derived === true && by === 'gateway';
  return {
    stage: str(e.stage),
    at: str(e.at),
    by: derived
      ? row === null
        ? 'gateway'
        : `gateway (ligne ${row})`
      : by === null || by === ''
        ? UNKNOWN_AUTHOR
        : by,
  };
};

const parseLinks = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
};

const parseStep = (s: unknown): BoardStep | null => {
  if (!isObj(s)) return null;
  return {
    step: str(s.step),
    mandatory: bool(s.mandatory),
    state: str(s.state),
    holder: str(s.holder),
    due: str(s.due),
    row: int(s.row),
  };
};

// swarph-cli connaît `open`, `fallback_fired`, `closed` et `withdrawn` ; `fallback_fired` reste ouverte.
const CLOSED_STATUSES = new Set(['closed', 'withdrawn']);

const parseObligation = (o: unknown): BoardObligation | null => {
  if (!isObj(o)) return null;
  const id = int(o.id);
  if (id === null) return null;
  const status = str(o.status);
  const closedAt = str(o.closed_at);
  return {
    id,
    step: str(o.step),
    holder: str(o.holder),
    status,
    state: str(o.state),
    // status fait foi (#1456) : closed_at ne décide que sans status
    closed: status !== null ? CLOSED_STATUSES.has(status) : closedAt !== null,
    closedAt,
    closeOutcome: str(o.close_outcome),
    closeEvidence: str(o.close_evidence),
    fallbackPolicy: decodeJsonString(o.fallback_policy),
    needsExtra: decodeJsonString(o.needs_extra),
  };
};

const parseMessage = (m: unknown): BoardMessage | null => {
  if (!isObj(m)) return null;
  const id = int(m.id);
  if (id === null) return null;
  return {
    id,
    author: trustedAuthor(m),
    createdAt: str(m.created_at),
    content: str(m.content),
  };
};

const compact = <T>(items: (T | null)[]): T[] => items.filter((x): x is T => x !== null);

/** `board projects list --json` : `{projects}`. */
export const parseProjects = (json: unknown): Parsed<BoardProject[]> | null => {
  if (!isObj(json) || !Array.isArray(json.projects)) return null;
  return parsed(json, compact(json.projects.map(parseProject)));
};

/** `board cards list --project <id> --json` : `{cards, due}`. */
export const parseCards = (json: unknown): Parsed<BoardCardSummary[]> | null => {
  if (!isObj(json) || !Array.isArray(json.cards)) return null;
  const cards = json.cards.map((c) => {
    if (!isObj(c)) return null;
    const id = int(c.id);
    return id === null ? null : parseSummary(c, id);
  });
  return parsed(json, compact(cards));
};

/** `board cards show <id> --json` : la carte elle-même. */
export const parseCard = (json: unknown): Parsed<BoardCard> | null => {
  if (!isObj(json)) return null;
  const id = int(json.id);
  if (id === null) return null;
  return parsed(json, {
    ...parseSummary(json, id),
    body: str(json.body),
    author: trustedAuthor(json),
    createdAt: str(json.created_at),
    updatedAt: str(json.updated_at),
    stageHistory: compact(arr(json.stage_history).map(parseStageEntry)),
    links: parseLinks(json.links),
  });
};

/** `board cards graph <id> --json` : `{steps, missing, flow, gate, stage_implied}`. */
export const parseGraph = (json: unknown): Parsed<BoardGraph> | null => {
  if (!isObj(json) || !Array.isArray(json.steps)) return null;
  const flow = isObj(json.flow) ? json.flow : {};
  return parsed(json, {
    steps: compact(json.steps.map(parseStep)),
    missing: strings(json.missing),
    unconfirmed: strings(flow.unconfirmed),
    stageImplied: str(json.stage_implied),
  });
};

/** `board cards thread <id> --limit <n> --json` : `{card_id, thread_uuid, messages}`. */
export const parseThread = (json: unknown, limit: number): Parsed<BoardThread> | null => {
  if (!isObj(json) || !Array.isArray(json.messages)) return null;
  return parsed(json, {
    messages: compact(json.messages.map(parseMessage)),
    capped: json.messages.length >= limit,
  });
};

/** `board obligations list --card <id> --json` : `{obligations, as_of, truncated}`. */
export const parseObligations = (json: unknown): Parsed<BoardObligations> | null => {
  if (!isObj(json) || !Array.isArray(json.obligations)) return null;
  return parsed(json, {
    obligations: compact(json.obligations.map(parseObligation)),
    truncated: json.truncated === true,
    asOf: str(json.as_of),
  });
};
