import { type Static, Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';

const SOURCES = [
  'hook:claude',
  'codex:json',
  'swairm',
  'github',
  'daemon',
  'action',
  'heuristic',
] as const;
const TYPES = [
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
] as const;

// Ce qu'un agent peut dire de lui-même : jamais l'état du sujet, jamais une validation.
const AGENT_SOURCES = new Set(['hook:claude', 'codex:json', 'heuristic']);
const AGENT_TYPES = new Set([
  'agent.status',
  'agent.tool',
  'approval.requested',
  'files.changed',
  'cost',
  'run.command',
]);

const oneOf = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>({ type: 'string', enum: [...values] });

const EventBody = Type.Object(
  {
    v: Type.Optional(Type.Literal(1)),
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    ts: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    source: oneOf(SOURCES),
    type: oneOf(TYPES),
    workspaceId: Type.Optional(Type.String()),
    topicId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export function registerEventRoutes(app: FastifyInstance, db: Db, store: EventStore): void {
  app.post('/api/events', { schema: { body: EventBody } }, async (req, reply) => {
    const body = req.body as Static<typeof EventBody>;
    const p = req.principal;
    if (p?.kind === 'run') {
      if (!AGENT_SOURCES.has(body.source) || !AGENT_TYPES.has(body.type)) {
        return reply.code(403).send({ error: 'type ou source réservés au daemon' });
      }
      const run = db
        .prepare(
          'SELECT r.id AS run_id, t.id AS topic_id, t.workspace_id FROM runs r JOIN topics t ON t.id = r.topic_id WHERE r.id = ?',
        )
        .get(p.runId) as { run_id: string; topic_id: string; workspace_id: string } | undefined;
      if (!run) return reply.code(403).send({ error: 'run inconnu' });
      if (body.agentId) {
        const own = db
          .prepare('SELECT 1 FROM agents WHERE id = ? AND run_id = ?')
          .get(body.agentId, p.runId);
        if (!own) return reply.code(403).send({ error: 'agent étranger' });
      }
      body.runId = run.run_id;
      body.topicId = run.topic_id;
      body.workspaceId = run.workspace_id;
    }
    const e = store.append(body as never);
    return reply.code(202).send({ id: e.id, seq: e.seq });
  });
}
