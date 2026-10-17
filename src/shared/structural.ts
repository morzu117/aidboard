// Contrat partagé de la capacité structural_index (chantier 08) : un adaptateur par moteur,
// le reste du daemon ne parle qu'à cette forme-ci (jamais au CLI d'un moteur directement).

export type Provenance = 'exact' | 'candidate' | 'heuristic';
export type IndexEngine = 'codegraph' | 'off';
export type Capability = 'explore' | 'symbols' | 'callers' | 'impact' | 'affected' | 'types';

export interface SymbolRef {
  name: string;
  kind: string;
  file: string;
  line: number;
}

export interface Relation {
  from: SymbolRef;
  to: SymbolRef;
  kind: 'calls' | 'imports' | 'extends' | 'references';
  provenance: Provenance;
}

export interface IndexStatus {
  engine: IndexEngine;
  state: 'ready' | 'indexing' | 'stale' | 'unavailable';
  /** présent quand state === 'unavailable', ou state === 'stale' par worktreeMismatch */
  reason?: string;
  indexedAt: string | null;
  files: number;
  symbols: number;
  languages: string[];
  /** fichiers modifiés depuis indexedAt, pas encore pris en compte par l'index */
  pending: number;
  engineVersion: string | null;
  /** version du moteur qui a construit l'index sur disque — peut différer de engineVersion */
  builtWith: string | null;
  capabilities: Capability[];
}

// Levée par un adaptateur quand le moteur ne peut pas répondre (binaire absent, délai dépassé,
// sortie illisible…). Jamais une Error générique : à charge de l'appelant (service, route,
// outil MCP) de la convertir en dégradation déclarative plutôt que de planter le daemon.
export class StructuralUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
  }
}
