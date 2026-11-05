import type { FastifyInstance } from 'fastify';
import { AidHttpError } from '../errors.js';
import { type BoardReader, isBoardId } from '../mesh/board.js';

export interface BoardRouteDeps {
  board: BoardReader | null;
}

/**
 * Chantier 24 : le board swarph en lecture seule. Toujours 200 avec un résultat discriminé (D95), sauf
 * 404 quand le mesh est désactivé (comme `/api/mesh`) et 400 pour un identifiant invalide. `?fresh=1`
 * contourne le cache (bouton Relire). Un token de run n'arrive jamais ici (registerSecurity).
 */
export function registerBoardRoutes(app: FastifyInstance, deps: BoardRouteDeps): void {
  const board = () => {
    if (!deps.board)
      throw new AidHttpError(404, 'mesh désactivé : `mesh.cell` vide dans config.yaml');
    return deps.board;
  };
  const id = (raw: string) => {
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!isBoardId(n)) throw new AidHttpError(400, 'identifiant invalide');
    return n;
  };
  const fresh = (query: unknown) => ({ fresh: (query as { fresh?: string }).fresh === '1' });

  app.get('/api/board/projects', async (req) => board().projects(fresh(req.query)));

  app.get('/api/board/projects/:projectId/cards', async (req) => {
    const b = board();
    return b.cards(id((req.params as { projectId: string }).projectId), fresh(req.query));
  });

  app.get('/api/board/cards/:cardId', async (req) => {
    const b = board();
    return b.card(id((req.params as { cardId: string }).cardId), fresh(req.query));
  });
}
