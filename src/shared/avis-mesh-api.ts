import type { AvisMesh, PhaseAvis } from './avis-mesh.js';

export const FAMILLES_AVIS = ['claude', 'gemini', 'gpt', 'grok', 'meta', 'cursor'] as const;

export interface SiegeAvis {
  peer: string;
  role: 'chair' | 'baseline' | 'seat';
  family: string;
}
export interface EcheancesAvisMesh {
  positions: string;
  rebuttal: string;
  vote: string;
}
export interface DemandeAvisMesh {
  id: string;
  etat: string;
  date: string;
  cells: string[];
  carte: number;
  canal?: string | null;
  motion?: string | number | null;
  confirmation?: string;
  apercu?: ApercuAvisMesh;
  erreur?: { status: number; message: string };
}
export interface ApercuAvisMesh {
  nom: string;
  sieges: SiegeAvis[];
  carte: number;
  echeances: EcheancesAvisMesh;
  texte: string;
}
/** La déclaration vient du gateway ; elle ne se déduit ni du temps ni d'un bulletin manquant. */
export type BaselineAvisMesh =
  | AvisMesh['avis'][number]
  | (Omit<AvisMesh['avis'][number], 'etat'> & {
      etat: 'declare_absent';
      reason: string;
      by: string;
      at: string;
    });
export type ResultatAvisMesh = AvisMesh & {
  phase: PhaseAvis;
  echeances: EcheancesAvisMesh;
  baseline: BaselineAvisMesh | null;
};
export interface ConfigAvisMesh {
  cellAid: string;
  baseline: string | null;
  familles: Record<string, string>;
}
export interface ParametresAvisMesh extends ApercuAvisMesh {
  id: string;
  question: string;
  jeton: string;
  charter: string;
}
export type ConfirmationAvisMesh = Omit<ParametresAvisMesh, 'question' | 'charter' | 'jeton'>;

export interface ConfirmationMotionAvis {
  id: string;
  canal: string;
  texte: string;
  echeances: EcheancesAvisMesh;
}

export const RAISON_BASELINE_ABSENT = "baseline absent à l'échéance, déclaré par le chair";

export function siegesAvis({
  cellAid,
  baseline,
  cells,
  familles,
}: {
  cellAid: string;
  baseline?: string;
  cells: readonly string[];
  familles: Record<string, string>;
}): SiegeAvis[] {
  if (!baseline) throw new Error('baseline non configuré');
  if (cells.length < 2 || cells.length > 8) throw new Error(`De 2 à 8 cells : ${cells.join(', ')}`);
  const peers = [cellAid, baseline, ...cells];
  const vus = new Set<string>();
  const famillesVues = new Map<string, string>();
  return peers.map((peer, i) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(peer))
      throw new Error(`Cell invalide : ${peer}`);
    if (vus.has(peer)) throw new Error(`Cell en double : ${peer}`);
    vus.add(peer);
    const valeur = Object.hasOwn(familles, peer) ? familles[peer] : undefined;
    const family =
      i === 0 ? 'orchestrator' : typeof valeur === 'string' ? valeur.toLowerCase() : undefined;
    if (!family || (i !== 0 && !FAMILLES_AVIS.includes(family as (typeof FAMILLES_AVIS)[number])))
      throw new Error(`Famille manquante ou invalide : ${peer}`);
    const autre = famillesVues.get(family);
    if (autre) throw new Error(`Même famille : ${autre}, ${peer}`);
    famillesVues.set(family, peer);
    return { peer, role: i === 0 ? 'chair' : i === 1 ? 'baseline' : 'seat', family };
  });
}

export function echeancesAvisParDefaut(maintenant = Date.now()): EcheancesAvisMesh {
  return {
    positions: new Date(maintenant + 86400000).toISOString(),
    rebuttal: new Date(maintenant + 90000000).toISOString(),
    vote: new Date(maintenant + 93600000).toISOString(),
  };
}

/** Les trois tours durent chacun entre une heure et sept jours. */
export function validerEcheancesAvis(e: EcheancesAvisMesh, maintenant = Date.now()): void {
  if (
    !e ||
    typeof e !== 'object' ||
    Array.isArray(e) ||
    Object.keys(e).some((k) => !['positions', 'rebuttal', 'vote'].includes(k))
  )
    throw new Error('Échéances invalides');
  let precedente = maintenant;
  for (const tour of ['positions', 'rebuttal', 'vote'] as const) {
    const date = typeof e[tour] === 'string' ? Date.parse(e[tour]) : NaN;
    const duree = date - precedente;
    if (!Number.isFinite(date) || duree < 3600000 || duree > 7 * 86400000)
      throw new Error(`Échéance ${tour} : entre 1 heure et 7 jours, strictement croissante`);
    precedente = date;
  }
}
