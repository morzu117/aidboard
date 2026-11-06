import type { Agent, MeshDm } from '../../../src/shared/model.js';
import type { StateSnapshot } from '../../../src/shared/state.js';
import { agentView } from './Statut.js';

// Chantier 28 : les règles de la Boîte de réception, sans rendu (D136, D140).

export type Nature = 'decision' | 'relire' | 'information';

export const NATURES: { id: Nature; titre: string }[] = [
  { id: 'decision', titre: 'Décisions' },
  { id: 'relire', titre: 'À relire' },
  { id: 'information', titre: 'Informations' },
];

/**
 * D136 : la nature d'un agent, ou null s'il n'a rien à dire dans la Boîte (terminé, arrêté, shell vivant).
 * Une question tranche, un tour terminé ou une erreur se relit, un agent au travail ou en pause informe.
 */
export function natureAgent(a: Agent): Nature | null {
  switch (agentView(a, 'boite').tone) {
    case 'attente':
      return 'decision';
    case 'relire':
    case 'erreur':
      return 'relire';
    case 'cours':
    case 'pause':
      return 'information';
    case 'inactif':
      return null;
  }
}

/** D137 : un DM vu sort de la Boîte ; mis en décision, il y passe ; sinon il informe. */
export function natureDm(
  dm: Pick<MeshDm, 'seenAt'> & { decidedAt?: string | null },
): Nature | null {
  if (dm.seenAt) return null;
  return dm.decidedAt ? 'decision' : 'information';
}

/** Les agents qu'affiche la Boîte : ceux d'un sujet connu, filtrés par projet s'il y en a un. */
export function agentsDeLaBoite(
  state: StateSnapshot,
  projet: string | null = null,
): { agent: Agent; nature: Nature }[] {
  const topicOfRun = new Map(state.runs.map((r) => [r.id, r.topicId]));
  const topics = new Map(state.topics.map((t) => [t.id, t]));
  const out: { agent: Agent; nature: Nature }[] = [];
  for (const agent of state.agents) {
    const topic = topics.get(topicOfRun.get(agent.runId) ?? '');
    if (!topic || (projet && topic.workspaceId !== projet)) continue;
    const nature = natureAgent(agent);
    if (nature) out.push({ agent, nature });
  }
  return out;
}

/** Les compteurs des filtres ; `tout` additionne les trois natures. */
export function compterNatures(natures: Nature[]): Record<Nature | 'tout', number> {
  const c = { tout: natures.length, decision: 0, relire: 0, information: 0 };
  for (const n of natures) c[n]++;
  return c;
}

/** D140 : le compteur ambre de la barre, la même définition que la section Décisions, tous projets. */
export function decisionsEnAttente(state: StateSnapshot): number {
  const agents = agentsDeLaBoite(state).filter((e) => e.nature === 'decision').length;
  const dms = (state.mesh?.inbox ?? []).filter((d) => natureDm(d) === 'decision').length;
  return agents + dms;
}
