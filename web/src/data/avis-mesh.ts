/** Contrat D301 : 40.3 doit implémenter ces réponses telles quelles. */
import { cheminMesh, useMeshLecture } from './meshLecture.js';
import { useCallback, useEffect, useState } from 'react';
import type { AidClient } from './client.js';
import { useAidClient } from './useAidState.js';

export type {
  EcheancesAvisMesh,
  DemandeAvisMesh,
  ResultatAvisMesh,
} from '../../../src/shared/avis-mesh-api.js';
import type {
  EcheancesAvisMesh,
  DemandeAvisMesh,
  ResultatAvisMesh,
} from '../../../src/shared/avis-mesh-api.js';
export function demanderAvisMesh(
  demande: {
    mesh: string;
    question: string;
    cells: string[];
    carte: number;
    echeances: EcheancesAvisMesh;
  },
  client: AidClient,
): Promise<DemandeAvisMesh> {
  return client.request('POST', '/api/avis-mesh', demande, { 'X-AID-Confirm': 'avis' });
}
export function lireAvisMesh(
  id: string,
  client: AidClient,
  mesh = 'principal',
): Promise<ResultatAvisMesh> {
  return client.request('GET', cheminMesh(`/api/avis-mesh/${encodeURIComponent(id)}`, mesh));
}
export function useDemandesAvisMesh(nom?: string) {
  const courant = useMeshLecture();
  const mesh = nom ?? courant;
  const client = useAidClient();
  const [result, setResult] = useState<{ mesh: string; demandes: DemandeAvisMesh[] } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const relire = useCallback(async () => {
    try {
      const lecture = await client.request<{ demandes: DemandeAvisMesh[] }>(
        'GET',
        cheminMesh('/api/avis-mesh', mesh),
      );
      setResult({ ...lecture, mesh });
      setErreur(null);
    } catch (e) {
      setErreur((e as Error).message);
    }
  }, [client, mesh]);
  useEffect(() => {
    void Promise.resolve().then(relire);
  }, [relire]);
  return {
    result:
      result?.mesh === mesh ? { demandes: result.demandes?.map((d) => ({ ...d, mesh })) } : null,
    mesh,
    erreur,
    relire,
  };
}

export function agirAvisMesh(
  id: string,
  action: 'motion' | 'baseline-absent',
  client: AidClient,
  echeances: EcheancesAvisMesh | undefined,
  mesh: string,
): Promise<{ confirmation: string }> {
  return client.request(
    'POST',
    `/api/avis-mesh/${encodeURIComponent(id)}/${action}`,
    { mesh, ...(action === 'motion' && { echeances }) },
    { 'X-AID-Confirm': 'avis' },
  );
}
export const ETATS_AVIS: Record<string, string> = {
  confirmation: 'En attente de confirmation',
  ouverture: 'Ouverture de la salle',
  'ouverture-motion': 'Ouverture de la motion',
  ouverte: 'Ouverte',
  'salle-sans-motion': 'Salle sans motion',
  echouee: 'Échouée',
  abandonnee: 'Abandonnée',
};
