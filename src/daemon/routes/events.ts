import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { ACTIVITY_TYPES, type AidEvent, type StoredEvent } from '../../shared/events.js';
import type { Db } from '../db.js';
import { admitAgentEvent, EventBody } from '../events/admit.js';
import type { EventStore } from '../events/store.js';

const RecentQuery = Type.Object(
  { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) },
  { additionalProperties: false },
);

interface RecentRow {
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
  topic_branch: string | null;
  topic_title: string | null;
  workspace_name: string | null;
}

function fromRecentRow(r: RecentRow): StoredEvent {
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
  if (r.topic_branch || r.topic_title || r.workspace_name) {
    e.context = {
      ...(r.topic_branch && { topicBranch: r.topic_branch }),
      ...(r.topic_title && { topicTitle: r.topic_title }),
      ...(r.workspace_name && { workspaceName: r.workspace_name }),
    };
  }
  return e;
}

export function registerEventRoutes(app: FastifyInstance, db: Db, store: EventStore): void {
  app.post('/api/events', { schema: { body: EventBody } }, async (req, reply) => {
    const body = req.body as EventBody;
    const p = req.principal;
    if (p?.kind === 'run') {
      const refused = admitAgentEvent(db, body, p.runId);
      if (refused) return reply.code(403).send({ error: refused });
    }
    const e = store.append(body as never);
    return reply.code(202).send({ id: e.id, seq: e.seq });
  });

  // Fil d'activité de l'Accueil (chantier 15, C.2) : filtre en SQL sur ACTIVITY_TYPES — un
  // filtre en JS après coup laisserait les types techniques (lease, agent.status…) pousser
  // les événements utiles hors de la fenêtre `limit`.
  app.get('/api/events/recent', { schema: { querystring: RecentQuery } }, async (req) => {
    const { limit } = req.query as { limit?: number };
    const placeholders = ACTIVITY_TYPES.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT e.*, t.branch AS topic_branch, t.title AS topic_title, w.name AS workspace_name
         FROM events e
         LEFT JOIN topics t ON t.id = e.topic_id
         LEFT JOIN workspaces w ON w.id = e.workspace_id
         WHERE e.type IN (${placeholders})
           -- un topic.state dont le data ne porte qu'indexState est un changement technique, pas un changement d'état visible : exclu.
           AND NOT (
             e.type = 'topic.state'
             AND json_extract(e.data, '$.indexState') IS NOT NULL
             AND json_extract(e.data, '$.state') IS NULL
           )
         ORDER BY e.seq DESC
         LIMIT ?`,
      )
      .all(...ACTIVITY_TYPES, limit ?? 20) as RecentRow[];
    return { events: rows.map(fromRecentRow) };
  });
}
