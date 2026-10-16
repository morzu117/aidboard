import { EventEmitter } from 'node:events';
import { monotonicFactory } from 'ulid';
import type { AidEvent, StoredEvent } from '../../shared/events.js';
import type { Db } from '../db.js';
import { project } from './projectors.js';

const nextId = monotonicFactory();

export type NewEvent = Omit<AidEvent, 'v' | 'id' | 'ts'> & Partial<Pick<AidEvent, 'id' | 'ts'>>;

interface Row {
  seq: number;
  id: string;
  v: 1;
  ts: string;
  source: AidEvent['source'];
  workspace_id: string | null;
  topic_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  type: AidEvent['type'];
  data: string;
}

function fromRow(r: Row): StoredEvent {
  const e: StoredEvent = {
    seq: r.seq,
    v: r.v,
    id: r.id,
    ts: r.ts,
    source: r.source,
    type: r.type,
    data: JSON.parse(r.data),
  };
  if (r.workspace_id) e.workspaceId = r.workspace_id;
  if (r.topic_id) e.topicId = r.topic_id;
  if (r.run_id) e.runId = r.run_id;
  if (r.agent_id) e.agentId = r.agent_id;
  return e;
}

export class EventStore extends EventEmitter {
  constructor(private readonly db: Db) {
    super();
  }

  // L'événement, ses projections et les lignes neuves de `mutate` partent ensemble ou pas du tout.
  append(input: NewEvent, mutate?: (tx: Db) => void): StoredEvent {
    const event: AidEvent = {
      v: 1,
      id: input.id ?? nextId(),
      ts: input.ts ?? new Date().toISOString(),
      source: input.source,
      type: input.type,
      data: input.data,
      ...(input.workspaceId && { workspaceId: input.workspaceId }),
      ...(input.topicId && { topicId: input.topicId }),
      ...(input.runId && { runId: input.runId }),
      ...(input.agentId && { agentId: input.agentId }),
    };
    const stored = this.db.transaction((): { event: StoredEvent; fresh: boolean } => {
      const existing = this.db.prepare('SELECT * FROM events WHERE id = ?').get(event.id) as
        Row | undefined;
      if (existing) return { event: fromRow(existing), fresh: false };
      mutate?.(this.db);
      const info = this.db
        .prepare(
          'INSERT INTO events (id, v, ts, source, workspace_id, topic_id, run_id, agent_id, type, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          event.id,
          event.v,
          event.ts,
          event.source,
          event.workspaceId ?? null,
          event.topicId ?? null,
          event.runId ?? null,
          event.agentId ?? null,
          event.type,
          JSON.stringify(event.data),
        );
      project(this.db, event);
      return { event: { ...event, seq: Number(info.lastInsertRowid) }, fresh: true };
    })();
    if (stored.fresh) this.emit('event', stored.event);
    return stored.event;
  }

  // Message non persisté (sortie d'action, etc.) : relayé aux sockets, jamais rejoué.
  emitEphemeral(msg: {
    kind: 'ephemeral';
    type: string;
    topicId?: string;
    [k: string]: unknown;
  }): void {
    this.emit('ephemeral', msg);
  }

  since(afterId: string | null, filter: { topicId?: string; runId?: string } = {}): StoredEvent[] {
    const after = afterId
      ? (this.db.prepare('SELECT seq FROM events WHERE id = ?').get(afterId) as
          { seq: number } | undefined)
      : undefined;
    const rows = this.db
      .prepare(
        'SELECT * FROM events WHERE seq > ? AND (? IS NULL OR topic_id = ?) AND (? IS NULL OR run_id = ?) ORDER BY seq',
      )
      .all(
        after?.seq ?? 0,
        filter.topicId ?? null,
        filter.topicId ?? null,
        filter.runId ?? null,
        filter.runId ?? null,
      ) as Row[];
    return rows.map(fromRow);
  }
}
