import type { BoardCard } from './board.js';
import { ETAPES_DEPLACEMENT } from './etats.js';

/** D293 : disponibilité locale d'une proposition, le gateway garde l'autorité. */
export function raisonDeplacement(carte: BoardCard, cell: string): string | null {
  if (carte.assignee !== cell) return `carte non assignée à ${cell}`;
  if (!ETAPES_DEPLACEMENT.some((e) => e === carte.stage))
    return `étape ${carte.stage ?? 'inconnue'} hors de build, review, ready`;
  if (!Number.isSafeInteger(carte.stageVersion) || (carte.stageVersion ?? -1) < 0)
    return 'version d’étape indisponible';
  return null;
}

export interface ReponseDeplacement {
  code: string;
  status?: number;
  detail?: string;
  current_stage?: string;
  warn?: string;
}

export function libelleDeplacement(r: ReponseDeplacement): string {
  if (r.code === 'succes') return r.warn ?? 'Carte déplacée.';
  if (r.code === 'proxy_lecture_seule') return 'Le proxy est en lecture seule.';
  const detail = r.detail ? ` : ${r.detail}` : '';
  if (r.status === 403) return `Droit manquant${detail}`;
  if (r.status === 400) return `Étape inconnue${detail}`;
  if (r.status === 404) return `Carte absente${detail}`;
  if (r.status === 409) {
    const titre = r.current_stage
      ? `La carte a changé (${r.current_stage})`
      : /obligation/i.test(r.detail ?? '')
        ? 'Obligations ouvertes'
        : /\b(?:gate|porte|confirm-flow|flow)\b/i.test(r.detail ?? '')
          ? "Porte d'étape"
          : 'La carte a changé';
    return titre + detail;
  }
  return 'Déplacement non confirmé. Relis la carte avant toute nouvelle action.';
}
