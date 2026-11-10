import { useSyncExternalStore } from 'react';
import type { lireBoardSwairm } from '../../../src/daemon/swairm/board.js';
import { boardStore, type BoardLecture } from './board.js';
import { useAid, useAidClient } from './useAidState.js';

export type BoardSwairm = Awaited<ReturnType<typeof lireBoardSwairm>>;
export type SujetBoardSwairm = BoardSwairm['sujets'][number];
const vide: BoardLecture<BoardSwairm> = {
  result: null,
  enLecture: false,
  luA: null,
  erreur: null,
};
const sansAbonnement = () => () => {};
const lireVide = () => vide;

/** Même magasin et même rythme que les cartes ; aucun abonnement sur le port host. */
export function useSwairmBoard() {
  const client = useAidClient();
  const { state, appareil } = useAid();
  const magasin =
    state && !appareil
      ? boardStore<BoardSwairm>(client, '/api/swairm/board', (r) => r.board?.readAt ?? null)
      : null;
  return useSyncExternalStore(
    magasin?.subscribe ?? sansAbonnement,
    magasin?.getSnapshot ?? lireVide,
  );
}

export const LIBELLES_SWAIRM: Record<string, string> = {
  planned: 'planifié',
  plan_validated: 'plan validé',
  in_progress: 'en cours',
  integrated: 'intégré',
  delivering: 'en livraison',
  queued: 'en file',
  merged: 'mergé',
  parked: 'garé',
  abandoned: 'abandonné',
};
export const libelleSwairm = (etat: string) =>
  Object.hasOwn(LIBELLES_SWAIRM, etat) ? LIBELLES_SWAIRM[etat]! : etat;

/** Quotes POSIX : aucune expansion, même avec dollars, backticks ou retours à la ligne. */
const citer = (texte: string) => "'" + texte.replaceAll("'", "'\"'\"'") + "'";
export const ligneSwairm = (s: SujetBoardSwairm) => `Swairm: ${s.projet}#${s.id}`;
export const commandeSwairm = (s: SujetBoardSwairm) =>
  `swarph board cards create --project <PROJET> --title ${citer(s.titre)} --body ${citer(ligneSwairm(s))}`;
