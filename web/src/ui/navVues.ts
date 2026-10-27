import type { Agent, NavPlacement, Topic } from '../../../src/shared/model.js';
import { isAlive } from './Statut.js';

/** Vues de la barre gauche (D54) : définitions partagées avec l'Accueil (D56, point 5) pour que
 * les deux ne divergent jamais sur ce qui compte comme « à décider », « agent libre »… */
export type VueId = 'tous' | 'a-decider' | 'agent-libre' | 'sans-agent' | 'epingles' | 'archives';

export const VUES: readonly { id: VueId; label: string; railColor?: string }[] = [
  { id: 'tous', label: 'Tous', railColor: '#5de0a1' },
  { id: 'a-decider', label: 'À décider', railColor: '#f2b84b' },
  { id: 'agent-libre', label: 'Agent libre', railColor: '#6ea8ff' },
  { id: 'sans-agent', label: 'Sans agent' },
  { id: 'epingles', label: 'Épinglés' },
  { id: 'archives', label: 'Archivés' },
];

export function correspondVue(p: NavPlacement, v: VueId, agents: Agent[]): boolean {
  if (v === 'archives') return p.archived;
  if (p.archived) return false;
  switch (v) {
    case 'tous':
      return true;
    case 'a-decider':
      return agents.some((a) => a.status === 'needs_input');
    case 'agent-libre':
      return agents.some((a) => isAlive(a) && a.role === 'free');
    case 'sans-agent':
      return agents.length === 0;
    case 'epingles':
      return p.pinned;
  }
}

/** Les sujets d'une vue (Accueil, point 5) : même filtre que `compteVue`, en liste plutôt qu'en total. */
export function topicsForVue(
  v: VueId,
  topics: Topic[],
  placementByTopic: Map<string, NavPlacement>,
  agentsOf: (topicId: string) => Agent[],
): Topic[] {
  return topics.filter((t) => {
    const p = placementByTopic.get(t.id);
    return p ? correspondVue(p, v, agentsOf(t.id)) : false;
  });
}

export function compteVue(
  v: VueId,
  topics: Topic[],
  placementByTopic: Map<string, NavPlacement>,
  agentsOf: (topicId: string) => Agent[],
  allAgents: Agent[],
): number {
  // « À décider » reprend la définition de Layout (agents en attente), pas un compte de sujets.
  if (v === 'a-decider') return allAgents.filter((a) => a.status === 'needs_input').length;
  let total = 0;
  for (const t of topics) {
    const p = placementByTopic.get(t.id);
    if (p && correspondVue(p, v, agentsOf(t.id))) total += 1;
  }
  return total;
}
