import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';
import { buildSnapshot } from '../state/snapshot.js';
import { syncTopicBranches } from '../state/syncBranches.js';
import type { StructuralService } from '../structural/service.js';

export function registerStateRoutes(
  app: FastifyInstance,
  db: Db,
  store: EventStore,
  engine: StructuralService,
): void {
  app.get('/api/state', async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    await syncTopicBranches(db, store);
    return buildSnapshot(db, engine, all);
  });
}
