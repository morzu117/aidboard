import type { Agent, Phase, Topic } from '../../../src/shared/model.js';
import { agentView, isAlive, mostUrgent } from './Statut.js';

// Chantier 25 : les règles de rangement de la coque V4, communes à la barre gauche et à l'accueil.

export type SectionId = 'a-decider' | 'a-relire' | 'en-cours' | 'en-pause';

/** Dans l'ordre d'affichage (V4) ; En pause est repliée par défaut dans la barre gauche. */
export const SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: 'a-decider', label: 'À décider' },
  { id: 'a-relire', label: 'À relire' },
  { id: 'en-cours', label: 'En cours' },
  { id: 'en-pause', label: 'En pause' },
];

/**
 * D103 : la section d'un sujet, d'après son agent le plus urgent. Une erreur se relit ; un agent vivant sans
 * statut suivi (shell, veille d'un agent vivant) reste en cours ; sans agent vivant, le sujet est en pause.
 */
export function sectionDe(agents: Agent[]): SectionId {
  // comme la vue « À décider » et le titre de l'accueil : une attente compte, même celle d'un shell
  if (agents.some((x) => x.status === 'needs_input')) return 'a-decider';
  const a = mostUrgent(agents);
  if (!a) return 'en-pause';
  switch (agentView(a).tone) {
    case 'attente':
      return 'a-decider';
    case 'erreur':
    case 'relire':
      return 'a-relire';
    case 'cours':
      return 'en-cours';
    case 'pause':
      return 'en-pause';
    case 'inactif':
      return agents.some(isAlive) ? 'en-cours' : 'en-pause';
  }
}

export const PHASES: Record<Phase, string> = {
  plan: 'Plan',
  dev: 'Développement',
  review: 'Revue',
  triage: 'Tri',
  retro: 'Rétro',
};

/** D108 : la question en attente, sinon le message d'état de l'agent, sinon la phase du sujet. */
export function prochaineChose(topic: Topic, agents: Agent[]): string {
  const a = mostUrgent(agents);
  if (a?.pending) return a.pending.question;
  if (a?.statusMessage) return a.statusMessage;
  if (topic.phase) return `Phase : ${PHASES[topic.phase]}`;
  return a ? agentView(a).label : 'Aucun agent sur ce sujet';
}

/**
 * D105 : la tuile d'un projet, sans rien en base. La lettre vient du nom, la couleur d'un hachage stable de
 * l'id, en index dans la palette des groupes (`taille` couleurs) : renommer un projet ne change pas sa couleur.
 */
export function tuileProjet(
  id: string,
  nom: string,
  taille: number,
): { lettre: string; couleur: number } {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const lettre = nom.trim().charAt(0).toUpperCase() || '?';
  return { lettre, couleur: taille > 0 ? h % taille : 0 };
}
