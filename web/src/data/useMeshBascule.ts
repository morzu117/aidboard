import { useEffect, useState } from 'react';
import type { StateSnapshot } from '../../../src/shared/state.js';
import { useAid } from './useAidState.js';

export interface MeshBascule {
  /** absent quand `mesh.cell` n'est pas configuré */
  mesh: StateSnapshot['mesh'];
  /** D99 bis : dernière lecture de `monitor status`, l'éphémère `mesh.checked` l'emporte sur l'instantané */
  checkedAt: string | null;
  /** un connect/disconnect est parti et son résultat n'est pas encore arrivé par `mesh.state` */
  enCours: boolean;
  basculer: (vers: boolean) => void;
}

/**
 * Chantier 25 (D100) : la bascule du mesh, sortie de la pastille (12.5) pour Réglages. Connect/disconnect
 * répondent 202, le résultat arrive par `mesh.state`. En attendant, « connexion… » ; si rien n'arrive (échec
 * silencieux), l'attente se relâche au bout de 30 s. Appelé une fois, dans Layout : la barre et Réglages
 * voient la même attente.
 */
export function useMeshBascule(): MeshBascule {
  const { state, call, meshCheckedAt } = useAid();
  const mesh = state?.mesh;
  const [cible, setCible] = useState<{ vers: boolean } | null>(null);
  const enCours = cible !== null && mesh?.state.connected !== cible.vers;
  useEffect(() => {
    if (cible === null) return;
    const t = setTimeout(() => setCible(null), 30_000);
    return () => clearTimeout(t);
  }, [cible]);
  const basculer = async (vers: boolean) => {
    if (!mesh) return;
    setCible({ vers });
    try {
      await call('POST', vers ? '/api/mesh/connect' : '/api/mesh/disconnect');
    } catch {
      setCible(null);
    }
  };
  const lu = [meshCheckedAt, mesh?.checkedAt].filter((x): x is string => !!x).sort();
  return {
    mesh,
    checkedAt: lu.at(-1) ?? null,
    enCours,
    basculer: (vers) => void basculer(vers),
  };
}
