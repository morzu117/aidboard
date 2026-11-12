import type { FastifyRequest } from 'fastify';
import type { MeshRegistry } from '../mesh/registre.js';
import type { FastifyInstance } from 'fastify';
import { AidHttpError } from '../errors.js';
import type { MeshService } from '../mesh/service.js';

export interface MeshRouteDeps {
  mesh: MeshService | null;
  meshes?: MeshRegistry;
}

/**
 * 12.4 (D35) : l'état du mesh et sa boîte, connecter / déconnecter (202 : le résultat arrive par `mesh.state`),
 * et la marque « vu » locale. Sans cell configurée, tout répond 404. Un token de run n'arrive jamais ici
 * (registerSecurity ne lui ouvre que POST /api/events, la mémoire et l'index).
 */
export function registerMeshRoutes(app: FastifyInstance, deps: MeshRouteDeps): void {
  const mesh = (req: FastifyRequest) => {
    const nom =
      (req.params as { mesh?: string }).mesh ??
      (req.method === 'GET' ? (req.query as { mesh?: string }).mesh : undefined) ??
      'principal';
    if (deps.meshes) return deps.meshes.obtenir(nom).mesh;
    if (nom !== 'principal') throw new AidHttpError(404, 'mesh inconnu');
    if (!deps.mesh)
      throw new AidHttpError(404, 'mesh désactivé : `mesh.cell` vide dans config.yaml');
    return deps.mesh;
  };

  app.get('/api/mesh', async (req) => {
    const m = mesh(req);
    return { state: m.current(), inbox: m.inbox(), tailscaleManage: m.tailscaleManage };
  });

  app.get('/api/meshes', async () => deps.meshes?.liste() ?? []);
  app.post('/api/meshes/:nom/archiver', async (req, reply) => {
    // Même garde admin locale que PUT /api/host.
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    if (!deps.meshes) throw new AidHttpError(404, 'mesh inconnu');
    await deps.meshes.archiver((req.params as { nom: string }).nom);
    return reply.code(204).send();
  });

  for (const action of ['connect', 'disconnect'] as const) {
    for (const prefixe of ['/api/mesh', '/api/mesh/:mesh'])
      app.post(`${prefixe}/${action}`, async (req, reply) => {
        const m = mesh(req);
        void m[action]();
        return reply.code(202).send({ state: m.current() });
      });
  }

  for (const prefixe of ['/api/mesh', '/api/mesh/:mesh'])
    app.post(`${prefixe}/dm/:id/seen`, async (req) => {
      const m = mesh(req);
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id < 0) throw new AidHttpError(400, 'id invalide');
      const r = m.markSeen(id);
      if (!r) throw new AidHttpError(404, 'DM inconnu');
      return r;
    });

  // chantier 28 (D137) : le DM passe dans les décisions de la Boîte ; rien ne part vers le pair
  for (const prefixe of ['/api/mesh', '/api/mesh/:mesh'])
    app.post(`${prefixe}/dm/:id/decision`, async (req) => {
      const m = mesh(req);
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id < 0) throw new AidHttpError(400, 'id invalide');
      const r = m.markDecision(id);
      if (!r) throw new AidHttpError(404, 'DM inconnu');
      return r;
    });
}
