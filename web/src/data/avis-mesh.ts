/** Contrat D301 : 40.3 doit implémenter ces réponses telles quelles. */
import { useSyncExternalStore } from 'react';
import type { AvisMesh, PhaseAvis } from '../../../src/shared/avis-mesh.js';
import { boardStore } from './board.js';
import type { AidClient } from './client.js';
import { useAidClient } from './useAidState.js';

/** Dates ISO 8601 absolues ; un tour absent est désactivé. */
export interface EcheancesAvisMesh {
  positions: string;
  rebuttal?: string;
  vote?: string;
}
export interface DemandeAvisMesh {
  id: string;
  etat: string;
  date: string;
  cells: string[];
  carte: number;
  canal?: string | null;
  motion?: string | number | null;
}
export type ResultatAvisMesh = AvisMesh & {
  phase: PhaseAvis;
  echeances: EcheancesAvisMesh;
};
export function demanderAvisMesh(
  demande: { question: string; cells: string[]; carte: number; echeances: EcheancesAvisMesh },
  client: AidClient,
): Promise<DemandeAvisMesh> {
  return client.request('POST', '/api/avis-mesh', demande, { 'X-AID-Confirm': 'avis' });
}
export function lireAvisMesh(id: string, client: AidClient): Promise<ResultatAvisMesh> {
  return client.request('GET', `/api/avis-mesh/${encodeURIComponent(id)}`);
}
export function useDemandesAvisMesh() {
  const magasin = boardStore<{ demandes: DemandeAvisMesh[] }>(
    useAidClient(),
    '/api/avis-mesh',
    () => null,
  );
  const lecture = useSyncExternalStore(magasin.subscribe, magasin.getSnapshot);
  return { ...lecture, relire: () => magasin.lire() };
}
