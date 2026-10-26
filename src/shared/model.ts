import type { IndexEngine } from './structural.js';

export type RunMode = 'standard' | 'swairm';
export type Phase = 'plan' | 'dev' | 'review' | 'triage' | 'retro';
export type TopicState = 'draft' | 'active' | 'review' | 'merged' | 'archived';
export type TopicType = 'feat' | 'fix' | 'chore' | 'spike';
export type IndexState = 'disabled' | 'indexing' | 'ready' | 'failed';
export interface TopicIndex {
  engine: IndexEngine;
  indexedAt: string | null;
  stale: boolean;
  pending: number;
  languages: string[];
}
export type AgentStatus =
  'starting' | 'working' | 'needs_input' | 'idle' | 'done' | 'error' | 'stopped';
export type AgentKind =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'shell'
  | 'swairm-cell'
  | 'swairm-drone'
  | 'swairm-queen'
  | 'grokbot-cloud'
  /** la cell swarph du mesh, ouverte en PTY (12.6, D38) */
  | 'swarph-cell';
export type ActionState = 'running' | 'succeeded' | 'needs_human' | 'failed';
export type StatusSource = 'hook' | 'heuristic' | 'daemon';
export type NeedsInputReason =
  | 'design'
  | 'scope'
  | 'redev_cap'
  | 'budget'
  | 'ambiguity'
  | 'delivery'
  | 'permission'
  | 'question'
  | 'hive';

/**
 * Réponse possible à une demande. L'agent ne choisit jamais la touche envoyée : le daemon la déduit de
 * `answer` (« yes » → 1, « always » → 2, « no » → Échap, « 1 » à « 9 » → ce chiffre) après avoir vérifié l'écran.
 */
export interface PendingOption {
  label: string;
  answer: 'yes' | 'always' | 'no' | `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
}

export interface PendingRequest {
  id: string;
  kind: 'permission' | 'question';
  question: string;
  options: PendingOption[];
}

/** Ce qui a fondé un statut estimé (infobulle). */
export interface StatusDetail {
  silenceMs?: number;
  lastLine?: string;
  promptDetected?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  root: string;
  /** « origin », ou null pour un dépôt purement local */
  remote: string | null;
  baseBranch: string;
  worktreesDir: string;
  namespace: string | null;
  createdAt: string;
}

/** Consignes d'un projet (écran Consignes) : présence des fichiers et version du bloc agentkit. */
export interface WorkspaceConsignes {
  claudeMd: boolean;
  agentsMd: boolean;
  blockVersion: string | null;
  kernelVersion: string | null;
}

export interface Topic {
  id: string;
  workspaceId: string;
  slug: string;
  title: string;
  type: TopicType;
  branch: string;
  base: string;
  worktree: string;
  state: TopicState;
  phase: Phase | null;
  indexState: IndexState;
  /** relu en direct depuis le moteur à chaque instantané, jamais stocké (DS7) */
  index: TopicIndex | null;
  worktreeMissing: boolean;
  prNumber: number | null;
  prUrl: string | null;
  stashRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  topicId: string;
  mode: RunMode;
  state: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  runId: string;
  kind: AgentKind;
  role: 'orchestrator' | Phase | 'free';
  transport: 'pty' | 'headless' | 'remote' | 'stream';
  status: AgentStatus;
  cwd: string;
  command: string[];
  pid: number | null;
  sessionId: string | null;
  exitCode: number | null;
  issue: number | null;
  statusReason: string | null;
  statusMessage: string | null;
  statusSource: StatusSource | null;
  statusAt: string | null;
  statusDetail: StatusDetail | null;
  lastTool: string | null;
  pending: PendingRequest | null;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActionRun {
  id: string;
  topicId: string | null;
  workspaceId: string;
  action: string;
  state: ActionState;
  exitCode: number | null;
  result: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Chantier 13 (DR5) : comment le daemon a été installé — détecté sur le disque, jamais configuré. */
export type InstallMode = 'repo' | 'release' | 'inconnu';

/** GET /api/daemon/update */
export interface UpdateInfo {
  mode: InstallMode;
  /** version qui tourne (package.json du build) */
  version: string;
  available: boolean;
  /** ce qui est disponible : une version (mode release) ou un sha d'origin/main (mode repo) ; null sinon */
  latest: string | null;
  lastError: string | null;
}

/** Mesh swarph (chantier 12, D36) : ce que le daemon projette d'`inbox.log` et de `monitor status`. */
export type MeshDmKind = 'fyi' | 'status' | 'question' | 'answer' | 'unblock';
export const MESH_DM_KINDS: readonly MeshDmKind[] = [
  'fyi',
  'status',
  'question',
  'answer',
  'unblock',
];

export interface MeshDm {
  /** id swarph, global au gateway et croissant : c'est lui qui rend `mesh.dm` idempotent */
  id: number;
  threadId: string | null;
  from: string;
  to: string;
  kind: MeshDmKind;
  /** donnée d'un pair : texte brut, jamais rendu en Markdown ni injecté dans un agent */
  content: string;
  createdAt: string;
  replyTo: number | null;
  obligationId: string | null;
  /** marque locale posée dans A-I-D (12.4), jamais le `read_at` du gateway */
  seenAt: string | null;
}

export type MeshTailscale = 'running' | 'stopped' | 'absent';
export type MeshMonitor = 'running' | 'stopped' | 'stale' | 'absent';

export interface MeshState {
  connected: boolean;
  tailscale: MeshTailscale;
  monitor: MeshMonitor;
  /** DM en attente côté monitor (`sinks[].pending`) */
  pending: number;
  /** depuis quand l'état `connected` courant tient (D41 : « hors mesh depuis <durée> ») */
  since: string | null;
  cell: string;
}
