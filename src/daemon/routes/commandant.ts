import type { FastifyInstance } from 'fastify';
import type { ServiceCommandant } from '../commandant/service.js';
import { identifiantCockpitValide } from '../commandant/identifiant.js';

/** Même lecture sur les deux ports ; la saisie et la suppression ne sont déclarées que sur le Mac. */
export function registerCommandantRoutes(
  app: FastifyInstance,
  service: ServiceCommandant | undefined,
  mac: boolean,
): void {
  void app.register(async (routes) => {
    routes.setErrorHandler((_erreur, _req, reply) =>
      reply.code(500).send({ error: 'Commande cockpit impossible' }),
    );
    routes.addHook('onRequest', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    const obtenir = (mesh: string) => {
      if (!service) return null;
      try {
        service.etat(mesh);
        return service;
      } catch {
        return null;
      }
    };
    routes.get<{ Params: { mesh: string } }>('/api/commandant/:mesh', async (req, reply) => {
      const s = obtenir(req.params.mesh);
      if (!s) return reply.code(404).send({ error: 'Mesh commandant indisponible' });
      return s.etat(req.params.mesh);
    });
    routes.get<{ Params: { mesh: string; id: string } }>(
      '/api/commandant/:mesh/demandes/:id',
      async (req, reply) => {
        const s = obtenir(req.params.mesh);
        if (!s) return reply.code(404).send({ error: 'Mesh commandant indisponible' });
        if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id)))
          return reply.code(400).send({ error: 'Id invalide' });
        return s.detail(req.params.mesh, Number(req.params.id));
      },
    );
    routes.get<{ Params: { mesh: string } }>(
      '/api/commandant/:mesh/identifiant',
      async (req, reply) => {
        const s = obtenir(req.params.mesh);
        if (!s) return reply.code(404).send({ error: 'Mesh commandant indisponible' });
        return s.etat(req.params.mesh).identifiant;
      },
    );
    routes.post<{ Params: { mesh: string } }>(
      '/api/commandant/:mesh/battement',
      async (req, reply) => {
        const s = obtenir(req.params.mesh);
        if (!s) return reply.code(404).send({ error: 'Mesh commandant indisponible' });
        void s.battement(req.params.mesh).catch(() => {});
        return reply.code(204).send();
      },
    );
    if (!mac) return;
    routes.put<{ Params: { mesh: string } }>(
      '/api/commandant/:mesh/identifiant',
      async (req, reply) => {
        if (req.principal?.kind !== 'admin')
          return reply.code(403).send({ error: 'admin seulement' });
        const s = obtenir(req.params.mesh);
        if (!s) return reply.code(404).send({ error: 'Mesh commandant indisponible' });
        const valeur = (req.body as { identifiant?: unknown } | null)?.identifiant;
        if (!identifiantCockpitValide(valeur))
          return reply.code(400).send({ error: 'Format de l’identifiant cockpit invalide' });
        await s.saisir(req.params.mesh, valeur);
        return s.etat(req.params.mesh).identifiant;
      },
    );
    routes.delete<{ Params: { mesh: string } }>(
      '/api/commandant/:mesh/identifiant',
      async (req, reply) => {
        if (req.principal?.kind !== 'admin')
          return reply.code(403).send({ error: 'admin seulement' });
        const s = obtenir(req.params.mesh);
        if (!s) return reply.code(404).send({ error: 'Mesh commandant indisponible' });
        s.supprimer(req.params.mesh);
        return reply.code(204).send();
      },
    );
  });
}
