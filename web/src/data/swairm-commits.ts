import { useEffect, useState } from 'react';
import type { LecturePrSwairm } from '../../../src/shared/swairm-trailers.js';
import { AidApiError } from './api.js';
import { useAid, useAidClient } from './useAidState.js';

/** Une lecture par ouverture, sans minuterie ni relecture au focus. Jamais sur le port host. */
export function useSwairmCommits(carte: number): LecturePrSwairm | null {
  const client = useAidClient();
  const { state, appareil } = useAid();
  const admin = !!state && !appareil && carte > 0;
  const [resultat, setResultat] = useState<{ carte: number; lecture: LecturePrSwairm } | null>(
    null,
  );
  useEffect(() => {
    if (!admin) return;
    let actif = true;
    void client.request<LecturePrSwairm>('GET', `/api/swairm/board/${carte}/commits`).then(
      (lecture) => {
        if (actif && (lecture.etat === 'ok' || lecture.etat === 'non-lu'))
          setResultat({ carte, lecture });
      },
      (erreur: unknown) => {
        if (!actif || (erreur instanceof AidApiError && erreur.status === 404)) return;
        setResultat({
          carte,
          lecture: { pr: null, commits: [], etat: 'non-lu', raison: 'lecture impossible' },
        });
      },
    );
    return () => {
      actif = false;
    };
  }, [client, carte, admin]);
  return admin && resultat?.carte === carte ? resultat.lecture : null;
}
