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

export interface Workspace {
  id: string;
  name: string;
  root: string;
  /** « origin », ou null pour un dépôt purement local */
  remote: string | null;
  baseBranch: string;
  worktreesDir: string;
  createdAt: string;
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
