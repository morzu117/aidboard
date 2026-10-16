import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { admitAgentEvent, EventBody } from '../events/admit.js';
import type { EventStore } from '../events/store.js';

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
}
