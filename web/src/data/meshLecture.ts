import { createContext, useContext } from 'react';
import type { StateSnapshot } from '../../../src/shared/state.js';

/** Ce contexte ne sert qu'aux lectures. Les écritures reçoivent le mesh de leur objet. */
export const MeshLecture = createContext('principal');
export const useMeshLecture = () => useContext(MeshLecture);

export function cheminMesh(chemin: string, mesh: string): string {
  // L'absence de paramètre conserve les routes historiques du mesh principal.
  return mesh === 'principal'
    ? chemin
    : `${chemin}${chemin.includes('?') ? '&' : '?'}mesh=${encodeURIComponent(mesh)}`;
}

export function instantaneMesh(state: StateSnapshot | null, nom: string) {
  return state?.meshes?.[nom] ?? (nom === 'principal' ? state?.mesh : undefined);
}
