import { useSyncExternalStore } from 'react';
import type { Ask, AskResult, Asks, ModeleAsk } from '../../../src/shared/swairm-ask.js';
import { boardStore } from './board.js';
import type { AidClient } from './client.js';
import { useAidClient } from './useAidState.js';

export interface EtatAsk {
  enCours: boolean;
  depuis: string | null;
  budgetUsd: number;
}
export function demanderAvis(
  demande: { question: string; n: number; modeles: ModeleAsk[] },
  client: AidClient,
): Promise<AskResult<Ask>> {
  return client.request('POST', '/api/swairm/ask', demande, { 'X-AID-Confirm': 'ask' });
}
export function annulerAvis(client: AidClient): Promise<EtatAsk> {
  return client.request('POST', '/api/swairm/ask/annuler');
}
export function relireAsk(id: string, client: AidClient): Promise<AskResult<Ask>> {
  return client.request('GET', `/api/swairm/asks/${encodeURIComponent(id)}`);
}
function useLecture<T>(chemin: string) {
  const magasin = boardStore<T>(useAidClient(), chemin, () => null);
  const lecture = useSyncExternalStore(magasin.subscribe, magasin.getSnapshot);
  return { ...lecture, relire: () => magasin.lire() };
}
export const useEtatAsk = () => useLecture<EtatAsk>('/api/swairm/ask/etat');
export const useAsks = () => useLecture<AskResult<Asks>>('/api/swairm/asks');
