export const EVENT_SOURCES = [
  'hook:claude',
  'codex:json',
  'swairm',
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
  'agent.status',
  'agent.tool',
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
  'plan.updated',
  'task.status',
  'instructions.updated',
  'memory.page',
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

export type StoredEvent = AidEvent & { seq: number };
