import type { AgentManager } from '../pty/manager.js';
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
  bwrapVersion?: string,
  agents?: AgentManager,
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
    for (const agent of snapshot.agents) {
      const live = agents?.get(agent.id) ?? agents?.getStream(agent.id);
      if (live?.isole && !live.exited) agent.isole = true;
    }
    if (bwrapVersion !== undefined) snapshot.bwrapVersion = bwrapVersion;
    return agentTransport ? { ...snapshot, agentTransport } : snapshot;
  });
}
