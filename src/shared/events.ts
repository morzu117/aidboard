export type EventSource =
  'hook:claude' | 'codex:json' | 'swairm' | 'github' | 'daemon' | 'action' | 'heuristic';

export type EventType =
  | 'agent.spawned'
  | 'agent.exited'
  | 'agent.status'
  | 'agent.tool'
  | 'run.state'
  | 'run.command'
  | 'approval.requested'
  | 'approval.resolved'
  | 'files.changed'
  | 'cost'
  | 'action.started'
  | 'action.finished'
  | 'topic.state'
  | 'topic.phase';

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
