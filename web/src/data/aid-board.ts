import { useSyncExternalStore } from 'react';
import type { lireBoardAid } from '../../../src/daemon/aid/board.js';
import { boardStore, type BoardLecture } from './board.js';
import { useAid, useAidClient } from './useAidState.js';

export type BoardAid = Awaited<ReturnType<typeof lireBoardAid>>;
export type SujetBoardAid = BoardAid['sujets'][number];
const vide: BoardLecture<BoardAid> = {
  result: null,
  enLecture: false,
  luA: null,
  erreur: null,
};
const sansAbonnement = () => () => {};
const lireVide = () => vide;

/** Même magasin et même rythme que les cartes ; aucun abonnement sur le port host. */
export function useAidBoard() {
  const client = useAidClient();
  const { state, appareil } = useAid();
  const magasin =
    state && !appareil
      ? boardStore<BoardAid>(client, '/api/aid/board', (r) =>
          r.board && 'readAt' in r.board ? r.board.readAt : null,
        )
      : null;
  return useSyncExternalStore(
    magasin?.subscribe ?? sansAbonnement,
    magasin?.getSnapshot ?? lireVide,
  );
}

export const LIBELLES_AID: Record<string, string> = {
  draft: 'brouillon',
  active: 'actif',
  review: 'en revue',
  merged: 'mergé',
  archived: 'archivé',
};
export const libelleAid = (etat: string) =>
  Object.hasOwn(LIBELLES_AID, etat) ? LIBELLES_AID[etat]! : etat;
