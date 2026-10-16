import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { buildSnapshot } from '../state/snapshot.js';

export function registerStateRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/state', async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    return buildSnapshot(db, all);
  });
}
