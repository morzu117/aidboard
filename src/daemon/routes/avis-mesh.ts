import type { MeshRegistry } from '../mesh/registre.js';
import type { FastifyInstance } from 'fastify';
import type { AvisMeshService } from '../mesh/avis.js';
import type { Porte } from '../confirmations/porte.js';
import { AidHttpError } from '../errors.js';
import { ID_ASK } from '../../shared/swairm-ask.js';

/** Uniquement enregistrées sur le serveur local ; jamais sur le serveur host. */
export function registerAvisMeshRoutes(
  app: FastifyInstance,
  deps: { avis: AvisMeshService | null; porte: Porte; meshes?: MeshRegistry },
) {
  const service = () => {
    if (!deps.avis) throw new AidHttpError(404, 'mesh désactivé');
    return deps.avis;
  };
  const lecture = (query: unknown) => {
    const nom = (query as { mesh?: string }).mesh ?? 'principal';
    if (deps.meshes) return deps.meshes.obtenir(nom).avis;
    if (nom !== 'principal') throw new AidHttpError(404, 'mesh inconnu');
    return service();
  };
  const identifiant = (params: unknown) => {
    const { id } = params as { id: string };
    if (!ID_ASK.test(id)) throw new AidHttpError(400, 'identifiant invalide');
    return id;
  };
  app.post('/api/avis-mesh', async (req, reply) => {
    if (req.headers['x-aid-confirm'] !== 'avis')
      throw new AidHttpError(403, 'confirmation absente');
    const avis = service();
    const params = avis.preparer(req.body);
    avis.enregistrer(params);
    try {
      const demande = await deps.porte.demander('mesh.avis', { params }, req);
      if (!('confirmation' in demande) || !demande.confirmation)
        throw new AidHttpError(409, 'confirmation_requise');
      avis.lierConfirmation(params.id, demande.confirmation);
      return reply.code(202).send({
        ...avis.demande(avis.ligne(params.id)),
        confirmation: demande.confirmation,
        apercu: {
          nom: params.nom,
          sieges: params.sieges,
          carte: params.carte,
          echeances: params.echeances,
          texte: params.texte,
        },
      });
    } catch (e) {
      avis.oublier(params.id);
      throw e;
    }
  });
  app.get('/api/avis-mesh', async (req) => lecture(req.query).liste());
  app.get('/api/avis-mesh/config', async (req) => lecture(req.query).config());
  app.get('/api/avis-mesh/:id', async (req) => lecture(req.query).lire(identifiant(req.params)));
  app.post('/api/avis-mesh/:id/motion', async (req, reply) => {
    if (req.headers['x-aid-confirm'] !== 'avis')
      throw new AidHttpError(403, 'confirmation absente');
    const avis = service();
    const id = identifiant(req.params);
    const params = avis.preparerMotion(
      id,
      (req.body as { echeances: import('../../shared/avis-mesh-api.js').EcheancesAvisMesh } | null)
        ?.echeances as import('../../shared/avis-mesh-api.js').EcheancesAvisMesh,
    );
    const demande = await deps.porte.demander('mesh.avis.motion', { params }, req);
    if (!('confirmation' in demande) || !demande.confirmation)
      throw new AidHttpError(409, 'confirmation_requise');
    avis.lierConfirmation(id, demande.confirmation);
    return reply.code(202).send({ confirmation: demande.confirmation });
  });
  app.post('/api/avis-mesh/:id/baseline-absent', async (req, reply) => {
    if (req.headers['x-aid-confirm'] !== 'avis')
      throw new AidHttpError(403, 'confirmation absente');
    const params = await service().verifierAbsence(identifiant(req.params));
    const demande = await deps.porte.demander('mesh.avis.baseline-absent', { params }, req);
    if (!('confirmation' in demande) || !demande.confirmation)
      throw new AidHttpError(409, 'confirmation_requise');
    return reply.code(202).send({ confirmation: demande.confirmation });
  });
}
