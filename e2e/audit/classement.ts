export const CLASSES = [
  'erreur',
  'refus',
  'visuel',
  'cible disparue',
  'clic impossible',
  'annulé',
  'sans effet',
  'desactive',
  'ok',
] as const;
export type Classe = (typeof CLASSES)[number];

export interface Observation {
  actif: boolean;
  dialogueAnnule?: boolean;
  cibleDisparue?: boolean;
  saisie?: string;
  filtreChange?: boolean;
  erreursConsole: number;
  erreursPage: number;
  reponses: Array<{ chemin: string; statut: number }>;
  requetes: Array<{ chemin: string }>;
  navigation: boolean;
  mutations: number;
  echecClic: boolean;
  causeClic?: string;
  daemonArrete: boolean;
}

// Lecture facultative d'une carte non reliée ; un autre 404 reste un refus à examiner.
export const reponseAttendue = (r: { chemin: string; statut: number }) =>
  r.statut === 404 && /^\/api\/swairm\/board\/\d+\/commits$/.test(r.chemin);

/** La priorité est celle de D343, indépendamment de l'ordre des événements. */
export function classer(releve: Observation): Classe {
  if (
    releve.erreursConsole > 0 ||
    releve.erreursPage > 0 ||
    releve.reponses.some((r) => r.statut >= 500)
  )
    return 'erreur';
  if (releve.reponses.some((r) => r.statut >= 400 && !reponseAttendue(r))) return 'refus';
  if (releve.cibleDisparue) return 'cible disparue';
  if (releve.echecClic) return 'clic impossible';
  if (releve.dialogueAnnule) return 'annulé';
  if (!releve.actif) return 'desactive';
  if (
    !releve.saisie &&
    !releve.filtreChange &&
    !releve.requetes.length &&
    !releve.navigation &&
    !releve.mutations
  )
    return 'sans effet';
  return 'ok';
}
