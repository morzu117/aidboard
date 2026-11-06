import { useEffect, useState } from 'react';
import type { Processus } from '../ui/repriseVue.js';
import { useAidClient } from './useAidState.js';

// Chantier 28 (D148) : la sonde d'un agent de serveur, à l'ouverture du dialogue Reprendre et sur « Vérifier à
// nouveau », jamais en tâche de fond.

export interface Sonde {
  etat: Processus;
  dernierEvenement: string | null;
}

/** null tant que la sonde n'est pas revenue ; sans agent de serveur, rien n'est demandé. */
export function useSonde(serverAgentId: string | null): {
  sonde: Sonde | null;
  verifier: () => void;
} {
  const client = useAidClient();
  const [tour, setTour] = useState(0);
  const [lu, setLu] = useState<{ tour: number; sonde: Sonde } | null>(null);
  useEffect(() => {
    if (!serverAgentId) return;
    let actif = true;
    client
      .request<Sonde>('GET', `/api/server-agents/${serverAgentId}/processus`)
      .then((sonde) => actif && setLu({ tour, sonde }))
      // le daemon ne répond pas : la machine n'est pas plus joignable
      .catch(
        () => actif && setLu({ tour, sonde: { etat: 'injoignable', dernierEvenement: null } }),
      );
    return () => {
      actif = false;
    };
  }, [client, serverAgentId, tour]);
  return {
    sonde: lu?.tour === tour ? lu.sonde : null,
    verifier: () => setTour((t) => t + 1),
  };
}
