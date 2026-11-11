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

export const ETAPES_PROXY = [
  'proposed',
  'idea',
  'spec',
  'plan',
  'build',
  'review',
  'ready',
  'done',
  'parked',
] as const;
export const REFUS_DEPLACEMENT = [
  'precondition',
  'step_gate',
  'flow_unconfirmed',
  'open_obligations',
  'forbidden',
  'bad_stage',
  'not_found',
  'other',
] as const;
export interface ReponseDeplacement {
  code: string;
  status?: number;
  current_stage?: string;
  refusal?: (typeof REFUS_DEPLACEMENT)[number];
  avertissement?: boolean;
}

export function libelleDeplacement(r: ReponseDeplacement): string {
  if (r.code === 'succes')
    return r.avertissement ? "Porte d'étape en mode avertissement" : 'Carte déplacée.';
  if (r.code === 'proxy_lecture_seule') return 'Le proxy est en lecture seule.';
  const generique = 'Déplacement non confirmé. Relis la carte avant toute nouvelle action.';
  if (r.refusal) {
    const libelles = {
      precondition: `La carte a changé${ETAPES_PROXY.some((e) => e === r.current_stage) ? ` (${r.current_stage})` : ''}`,
      step_gate: "Porte d'étape",
      flow_unconfirmed: "Flow non confirmé (l'orchestrateur doit le confirmer)",
      open_obligations: 'Obligations ouvertes',
      forbidden: 'Droit manquant',
      bad_stage: 'Étape inconnue',
      not_found: 'Carte absente',
      other: generique,
    };
    return libelles[r.refusal];
  }
  if (r.status === 403) return 'Droit manquant';
  if (r.status === 400) return 'Étape inconnue';
  if (r.status === 404) return 'Carte absente';
  if (r.status === 409)
    return 'La carte a changé ou une porte a refusé le déplacement. Relis la carte.';
  return generique;
}
