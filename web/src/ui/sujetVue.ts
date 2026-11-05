import type { Agent, Phase } from '../../../src/shared/model.js';
import { PHASES } from './rangement.js';
import { isAlive, isResumable } from './Statut.js';

// Chantier 26 : les règles de l'écran Sujet, sans rendu (D113, D115).

/**
 * D115 : l'état d'un onglet d'agent, en mots. `agentView()` reste celle de l'accueil, de la barre et
 * de la Boîte ; un shell vivant n'a pas de statut suivi et se dit « ouvert ».
 */
export function etatOnglet(a: Agent): string {
  if (isAlive(a) && a.pausedAt) return 'en pause';
  if (isAlive(a) && a.kind === 'shell') return 'ouvert';
  switch (a.status) {
    case 'working':
    case 'starting':
      return 'au travail';
    case 'needs_input':
      return 'attend ta réponse';
    case 'idle':
      return a.statusReason === 'question' ? 'attend ta réponse' : 'libre';
    case 'error':
      return 'erreur';
    case 'done':
    case 'stopped':
      return isResumable(a) ? 'en veille' : 'arrêté';
  }
}

export type Segment = 'fait' | 'en-cours' | 'a-venir';

export interface EtapesPhase {
  segments: { phase: Phase; label: string; etat: Segment }[];
  /** « Phase 2 sur 5 · Développement » */
  ligne: string;
}

/** D113 : les cinq phases du sujet en segments ; rien quand le sujet n'a pas de phase. */
export function etapesPhase(phase: Phase | null): EtapesPhase | null {
  if (!phase) return null;
  const ordre = Object.keys(PHASES) as Phase[];
  const i = ordre.indexOf(phase);
  return {
    segments: ordre.map((p, j) => ({
      phase: p,
      label: PHASES[p],
      etat: j < i ? 'fait' : j === i ? 'en-cours' : 'a-venir',
    })),
    ligne: `Phase ${i + 1} sur ${ordre.length} · ${PHASES[phase]}`,
  };
}
