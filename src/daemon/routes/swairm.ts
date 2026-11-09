import type { FastifyInstance } from 'fastify';
import { ID_ASK } from '../../shared/swairm-ask.js';
import { AidHttpError } from '../errors.js';
import { AskOccupe, SwairmAsk, validerDemande } from '../swairm/ask.js';

/** Routes du port local uniquement ; sécurité et CSRF communs au daemon. */
export function registerSwairmRoutes(app: FastifyInstance, swairm: SwairmAsk): void {
  app.post('/api/swairm/ask', async (req) => {
    if (req.headers['x-aid-confirm'] !== 'ask') throw new AidHttpError(403, 'confirmation absente');
    try {
      validerDemande(req.body);
    } catch {
      throw new AidHttpError(400, 'demande invalide');
    }
    try {
      return await swairm.demander(req.body);
    } catch (err) {
      if (err instanceof AskOccupe) throw new AidHttpError(409, err.message);
      throw err;
    }
  });
  app.post('/api/swairm/ask/annuler', async () => {
    swairm.annuler();
    return swairm.etat();
  });
  app.get('/api/swairm/ask/etat', async () => swairm.etat());
  app.get('/api/swairm/asks', async () => swairm.liste());
  app.get('/api/swairm/asks/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!ID_ASK.test(id)) throw new AidHttpError(400, 'identifiant invalide');
    return swairm.relire(id);
  });
}
