import { liensSwairm } from '../../shared/swairm-board.js';
import type { BoardReader } from '../mesh/board.js';
import type { SwairmStatut } from './statut.js';

/** D286 : deux lectures indépendantes ; aucune écriture ni état persistant. */
export async function lireBoardSwairm(board: BoardReader | null, statut: SwairmStatut) {
  const [lectureBoard, swairm] = await Promise.all([
    board?.chercherCartes('Swairm: ') ??
      Promise.resolve({
        ok: false as const,
        kind: 'not-configured' as const,
        readAt: new Date().toISOString(),
      }),
    statut.lire(),
  ]);
  const cartes = lectureBoard.ok
    ? lectureBoard.data.cards.filter((c) => liensSwairm(c.body ?? '').length > 0)
    : [];
  const sujets =
    swairm.etat === 'ok'
      ? swairm.data.projets.flatMap((p) =>
          p.sujets.map((s) => {
            const liens = cartes
              .filter((c) =>
                liensSwairm(c.body ?? '').some((l) => l.projet === p.projet && l.id === s.id),
              )
              .map((c) => c.id);
            const conflit = [...new Set(liens)];
            return {
              projet: p.projet,
              ...s,
              vol: p.vols.find((v) => v.cible === s.id) ?? null,
              carte: conflit.length === 1 ? conflit[0]! : null,
              conflit: conflit.length > 1 ? conflit : [],
            };
          }),
        )
      : [];
  return { sujets, cartes, swairm, board: lectureBoard };
}
