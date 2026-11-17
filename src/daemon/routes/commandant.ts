import type { Porte } from '../confirmations/porte.js';
import { AidHttpError } from '../errors.js';
import type { FastifyInstance } from 'fastify';
import type { ServiceCommandant } from '../commandant/service.js';
import { identifiantCockpitValide } from '../commandant/identifiant.js';

/** Même lecture sur les deux ports ; la saisie et la suppression ne sont déclarées que sur le Mac. */
export function registerCommandantRoutes(
  app: FastifyInstance,
  service: ServiceCommandant | undefined,
  mac: boolean,
  porte?: Porte,
): void {
  void app.register(async (routes) => {
    routes.setErrorHandler((erreur, _req, reply) => {
      if (erreur instanceof AidHttpError)
        return reply.code(erreur.status).send({ error: erreur.message });
      return reply.code(500).send({ error: 'Commande cockpit impossible' });
    });
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
        const ouverture = (req.body as { ouverture?: unknown } | null)?.ouverture === true;
        const lecture = s.battement(req.params.mesh, ouverture);
        if (ouverture) await lecture;
        else void lecture.catch(() => {});
        return reply.code(204).send();
      },
    );
    if (!mac) return;
    routes.post<{ Params: { mesh: string; id: string } }>(
      '/api/commandant/:mesh/demandes/:id/reponse',
      async (req, reply) => {
        if (req.principal?.kind !== 'admin')
          return reply.code(403).send({ error: 'admin seulement' });
        if (!obtenir(req.params.mesh) || !porte)
          return reply.code(404).send({ error: 'Mesh commandant indisponible' });
        const corps = req.body as { digest?: unknown; decision?: unknown } | null;
        if (
          !/^\d+$/.test(req.params.id) ||
          !Number.isSafeInteger(Number(req.params.id)) ||
          !corps ||
          typeof corps.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(corps.digest) ||
          typeof corps.decision !== 'string' ||
          Object.keys(corps).some((k) => !['digest', 'decision'].includes(k))
        )
          return reply.code(400).send({ error: 'commandant_parametres' });
        const demande = await porte.demander(
          'mesh.commandant.repondre',
          {
            mesh: req.params.mesh,
            params: {
              requestId: Number(req.params.id),
              digest: corps.digest,
              decision: corps.decision,
            },
          },
          req,
        );
        return reply.code(202).send(demande);
      },
    );
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
