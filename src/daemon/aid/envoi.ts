import type { Db } from '../db.js';
import type { BoardReader } from '../mesh/board.js';
import { AidHttpError } from '../errors.js';
import { raisonDeplacement } from '../../shared/deplacements.js';
import { lireParamsEtat, type ParametresEtat } from '../../shared/etats.js';

/** D293 : l'attendu est relu à l'envoi, puis signé et revalidé au oui. */
export async function preparerPropositionAid(
  db: Db,
  board: BoardReader | null,
  cell: string,
  id: number,
): Promise<ParametresEtat['carte.deplacer']> {
  if (!Number.isSafeInteger(id) || id < 1) throw new AidHttpError(400, 'proposition invalide');
  const p = db
    .prepare('SELECT carte, etape FROM aid_propositions WHERE id = ? AND fermee_a IS NULL')
    .get(id) as { carte: number; etape: string } | undefined;
  if (!p) throw new AidHttpError(404, 'proposition absente');
  const fiche = await board?.card(p.carte, { fresh: true, sansCache: true });
  if (!fiche?.card.ok || raisonDeplacement(fiche.card.data, cell))
    throw new AidHttpError(409, 'perime');
  const carte = fiche.card.data;
  const lecture = lireParamsEtat('carte.deplacer', {
    carte: p.carte,
    etape: p.etape,
    attendu: { stage: carte.stage, stageVersion: carte.stageVersion },
  });
  if (!lecture.ok) throw new AidHttpError(409, 'perime');
  return lecture.params;
}
