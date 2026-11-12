import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import type { BoardReader } from '../mesh/board.js';
import { lireBoardAid } from '../aid/board.js';
import { creerReleveAid, propositionsAid } from '../aid/propositions.js';
import { AidHttpError } from '../errors.js';
import { preparerPropositionAid } from '../aid/envoi.js';
import { resumeEtat } from '../../shared/etats.js';
import { IdentitesWorkspaces } from '../aid/workspace.js';

export function registerAidRoutes(
  app: FastifyInstance,
  db: Db,
  board: BoardReader | null,
  cell = '',
): void {
  const identites = new IdentitesWorkspaces();
  const relever = creerReleveAid(db, cell);
  app.get('/api/aid/board', async () => {
    const lecture = await lireBoardAid(db, board, identites);
    relever(lecture);
    return lecture;
  });
  app.get('/api/aid/propositions', async () => propositionsAid(db));
  app.get('/api/aid/propositions/:id/apercu', async (req) => {
    const params = await preparerPropositionAid(
      db,
      board,
      cell,
      Number((req.params as { id: string }).id),
    );
    const { mesh } = db
      .prepare('SELECT mesh FROM aid_propositions WHERE id = ?')
      .get(Number((req.params as { id: string }).id)) as { mesh: string };
    return { mesh, params, resume: resumeEtat('carte.deplacer', params) };
  });
  app.delete('/api/aid/propositions/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id < 1) throw new AidHttpError(400, 'identifiant invalide');
    db.prepare(
      "UPDATE aid_propositions SET fermee_a = ? WHERE mesh = 'principal' AND id = ? AND fermee_a IS NULL",
    ).run(new Date().toISOString(), id);
    return { ok: true };
  });
}
