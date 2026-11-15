import { useSyncExternalStore } from 'react';
import { boardStore } from './board.js';
import { useAidClient } from './useAidState.js';
import type { AidClient } from './client.js';
import type { BoardCardSheet } from '../../../src/shared/board.js';

export interface CibleCarte {
  mesh: string;
  carte: number;
}
export interface MembreRelie extends CibleCarte {
  id: number;
  statut: 'ok' | 'mesh_change' | 'carte_remplacee' | 'lecture_impossible';
  titre?: string | null;
  etape?: string | null;
  responsable?: string | null;
  obligations?: number;
  echeance?: string | null;
  maj?: string | null;
}
export interface GroupeRelie {
  id: number;
  note: string | null;
  membres: MembreRelie[];
  ecart: boolean;
}
export interface PageCartesReliees {
  groupes: GroupeRelie[];
  suivant: number | null;
}

export function useGroupeRelie({ mesh, carte }: CibleCarte) {
  const magasin = boardStore<GroupeRelie | null>(
    useAidClient(),
    `/api/cartes-reliees?mesh=${encodeURIComponent(mesh)}&carte=${carte}`,
    () => null,
  );
  return {
    ...useSyncExternalStore(magasin.subscribe, magasin.getSnapshot),
    relire: () => magasin.lire(),
  };
}

export function lirePageReliee(client: AidClient, apres = 0) {
  return client.request<PageCartesReliees>('GET', `/api/cartes-reliees?limite=20&apres=${apres}`);
}

export function lireApercuRelie(client: AidClient, cible: CibleCarte) {
  return client.request<BoardCardSheet>(
    'GET',
    `/api/board/cards/${cible.carte}?mesh=${encodeURIComponent(cible.mesh)}`,
  );
}

export function relierCartes(
  client: AidClient,
  origine: CibleCarte,
  cible: CibleCarte,
  groupe: GroupeRelie | null,
) {
  // L'identité complète est exclusivement relue par le daemon.
  return groupe
    ? client.request('POST', `/api/cartes-reliees/${groupe.id}/membres`, cible)
    : client.request('POST', '/api/cartes-reliees', { membres: [origine, cible] });
}

export function retirerMembre(client: AidClient, groupe: number, membre: number) {
  return client.request('DELETE', `/api/cartes-reliees/${groupe}/membres/${membre}`);
}
