import type { MeshRegistry } from '../mesh/registre.js';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';
import { buildSnapshot } from '../state/snapshot.js';
import { syncTopicBranches } from '../state/syncBranches.js';
import type { StructuralService } from '../structural/service.js';
import type { MeshService } from '../mesh/service.js';

export function registerStateRoutes(
  app: FastifyInstance,
  db: Db,
  store: EventStore,
  engine: StructuralService,
  mesh: MeshService | null = null,
  swairmEnabled = false,
  agentTransport?: 'pty' | 'stream',
  meshes?: MeshRegistry,
): void {
  app.get('/api/state', async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    await syncTopicBranches(db, store);
    const snapshot = await buildSnapshot(
      db,
      engine,
      all,
      meshes?.principal?.mesh ?? mesh,
      swairmEnabled,
      meshes,
    );
    return agentTransport ? { ...snapshot, agentTransport } : snapshot;
  });
}
