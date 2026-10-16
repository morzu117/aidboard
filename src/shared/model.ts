export type RunMode = 'standard' | 'swairm';
export type Phase = 'plan' | 'dev' | 'review' | 'triage' | 'retro';
export type TopicState = 'draft' | 'active' | 'review' | 'merged' | 'archived';
export type TopicType = 'feat' | 'fix' | 'chore' | 'spike';
export type IndexState = 'disabled' | 'indexing' | 'ready' | 'failed';
export type AgentStatus =
  'starting' | 'working' | 'needs_input' | 'idle' | 'done' | 'error' | 'stopped';
export type AgentKind =
  'claude' | 'codex' | 'cursor' | 'shell' | 'swairm-drone' | 'swairm-queen' | 'grokbot-cloud';
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
  worktreeMissing: boolean;
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
  transport: 'pty' | 'headless' | 'remote';
  status: AgentStatus;
  cwd: string;
  command: string[];
  pid: number | null;
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
