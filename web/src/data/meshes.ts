import { useSyncExternalStore } from 'react';
import type { MeshState } from '../../../src/shared/model.js';
import { boardStore } from './board.js';
import { useAid, useAidClient } from './useAidState.js';

export interface MeshWeb {
  nom: string;
  cell: string;
  actif: boolean;
  erreur: string | null;
  etat: MeshState | null;
  ecriture: boolean;
}

const vide: MeshWeb[] = [];
const sansAbonnement = () => () => {};
const lireVide = () => ({ result: vide, erreur: null, enLecture: false, luA: null });
const lectureVide = lireVide();

/** Le magasin partage une lecture entre les écrans et les deux variantes de navigation. */
export function useMeshes() {
  const client = useAidClient();
  const { state, appareil } = useAid();
  const magasin =
    state && !appareil ? boardStore<MeshWeb[]>(client, '/api/meshes', () => null) : null;
  const lecture = useSyncExternalStore(
    magasin?.subscribe ?? sansAbonnement,
    magasin?.getSnapshot ?? (() => lectureVide),
  );
  const meshes = Array.isArray(lecture.result) ? lecture.result : [];
  return {
    meshes,
    charge: lecture.result !== null || lecture.erreur !== null,
    multiple: meshes.filter((m) => m.actif).length >= 2,
    erreur: lecture.erreur,
    relire: magasin?.relire ?? (() => Promise.resolve()),
  };
}
