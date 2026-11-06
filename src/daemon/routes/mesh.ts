import type { FastifyInstance } from 'fastify';
import { AidHttpError } from '../errors.js';
import type { MeshService } from '../mesh/service.js';

export interface MeshRouteDeps {
  mesh: MeshService | null;
}

/**
 * 12.4 (D35) : l'état du mesh et sa boîte, connecter / déconnecter (202 : le résultat arrive par `mesh.state`),
 * et la marque « vu » locale. Sans cell configurée, tout répond 404. Un token de run n'arrive jamais ici
 * (registerSecurity ne lui ouvre que POST /api/events, la mémoire et l'index).
 */
export function registerMeshRoutes(app: FastifyInstance, deps: MeshRouteDeps): void {
  const mesh = () => {
    if (!deps.mesh)
      throw new AidHttpError(404, 'mesh désactivé : `mesh.cell` vide dans config.yaml');
    return deps.mesh;
  };

  app.get('/api/mesh', async () => {
    const m = mesh();
    return { state: m.current(), inbox: m.inbox(), tailscaleManage: m.tailscaleManage };
  });

  for (const action of ['connect', 'disconnect'] as const) {
    app.post(`/api/mesh/${action}`, async (_req, reply) => {
      const m = mesh();
      void m[action]();
      return reply.code(202).send({ state: m.current() });
    });
  }

  app.post('/api/mesh/dm/:id/seen', async (req) => {
    const m = mesh();
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 0) throw new AidHttpError(400, 'id invalide');
    const r = m.markSeen(id);
    if (!r) throw new AidHttpError(404, 'DM inconnu');
    return r;
  });

  // chantier 28 (D137) : le DM passe dans les décisions de la Boîte ; rien ne part vers le pair
  app.post('/api/mesh/dm/:id/decision', async (req) => {
    const m = mesh();
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 0) throw new AidHttpError(400, 'id invalide');
    const r = m.markDecision(id);
    if (!r) throw new AidHttpError(404, 'DM inconnu');
    return r;
  });
}
