export const CLASSES = ['erreur', 'refus', 'sans effet', 'desactive', 'ok'] as const;
export type Classe = (typeof CLASSES)[number];

export interface Observation {
  actif: boolean;
  erreursConsole: number;
  erreursPage: number;
  reponses: Array<{ chemin: string; statut: number }>;
  requetes: Array<{ chemin: string }>;
  navigation: boolean;
  mutations: number;
  echecClic: boolean;
  daemonArrete: boolean;
}

/** La priorité est celle de D343, indépendamment de l'ordre des événements. */
export function classer(releve: Observation): Classe {
  if (
    releve.erreursConsole > 0 ||
    releve.erreursPage > 0 ||
    releve.reponses.some((r) => r.statut >= 500)
  )
    return 'erreur';
  if (releve.reponses.some((r) => r.statut >= 400)) return 'refus';
  if (!releve.actif) return 'desactive';
  if (!releve.requetes.length && !releve.navigation && !releve.mutations) return 'sans effet';
  return 'ok';
}
