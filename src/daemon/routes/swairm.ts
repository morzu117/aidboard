import type { Db } from '../db.js';
import { propositionsSwairm, releverEtatsSwairm } from '../swairm/propositions.js';
import type { BoardReader } from '../mesh/board.js';
import { SwairmStatut } from '../swairm/statut.js';
import { lireBoardSwairm } from '../swairm/board.js';
import type { FastifyInstance } from 'fastify';
import { ID_ASK } from '../../shared/swairm-ask.js';
import { AidHttpError } from '../errors.js';
import { AskOccupe, SwairmAsk, validerDemande } from '../swairm/ask.js';

/** Routes du port local uniquement ; sécurité et CSRF communs au daemon. */
export function registerSwairmRoutes(
  app: FastifyInstance,
  swairm: SwairmAsk,
  board: BoardReader | null = null,
  statut = new SwairmStatut(),
  db?: Db,
): void {
  app.get('/api/swairm/board', async () => {
    const lecture = await lireBoardSwairm(board, statut);
    if (db) releverEtatsSwairm(db, lecture);
    return lecture;
  });
  app.get('/api/swairm/propositions', async () => (db ? propositionsSwairm(db) : []));
  app.delete('/api/swairm/propositions/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id < 1) throw new AidHttpError(400, 'identifiant invalide');
    db?.prepare(
      'UPDATE swairm_propositions SET fermee_a = ? WHERE id = ? AND fermee_a IS NULL',
    ).run(new Date().toISOString(), id);
    return { ok: true };
  });
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
