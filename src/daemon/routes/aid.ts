import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import type { BoardReader } from '../mesh/board.js';
import { lireBoardAid } from '../aid/board.js';
import { IdentitesWorkspaces } from '../aid/workspace.js';

export function registerAidRoutes(app: FastifyInstance, db: Db, board: BoardReader | null): void {
  const identites = new IdentitesWorkspaces();
  app.get('/api/aid/board', async () => lireBoardAid(db, board, identites));
}
