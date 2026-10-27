export const EVENT_SOURCES = [
  'hook:claude',
  'codex:json',
  'swairm',
  'swarph',
  'github',
  'daemon',
  'action',
  'heuristic',
  'relay',
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_TYPES = [
  'agent.spawned',
  'agent.exited',
  'agent.resumed',
  'agent.status',
  'agent.tool',
  'agent.closed',
  'run.state',
  'run.command',
  'approval.requested',
  'approval.resolved',
  'files.changed',
  'cost',
  'action.started',
  'action.finished',
  'topic.state',
  'topic.phase',
  'topic.branch',
  'topic.pr',
  'topic.stash',
  'plan.updated',
  'task.status',
  'instructions.updated',
  'memory.page',
  'mesh.dm',
  'mesh.state',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface AidEvent<T = Record<string, unknown>> {
  v: 1;
  id: string;
  ts: string;
  source: EventSource;
  workspaceId?: string;
  topicId?: string;
  runId?: string;
  agentId?: string;
  type: EventType;
  data: T;
}

export type StoredEvent = AidEvent & {
  seq: number;
  /** Rempli par /api/events/recent (jointure topics/workspaces) : jamais par `EventStore.append`. */
  context?: { topicBranch?: string; topicTitle?: string; workspaceName?: string };
};

// Chantier 15 C.2 : sous-ensemble de EVENT_TYPES affiché dans le fil d'activité de l'Accueil.
// Le reste (agent.status, agent.tool, cost, files.changed, run.*, lease_acquired/released…)
// est technique et resterait du bruit pour l'utilisateur.
export const ACTIVITY_TYPES = [
  'approval.requested',
  'approval.resolved',
  'agent.spawned',
  'agent.exited',
  'topic.state',
  'topic.phase',
  'topic.branch',
  'topic.pr',
  'plan.updated',
  'action.finished',
  'mesh.dm',
] as const satisfies readonly EventType[];
