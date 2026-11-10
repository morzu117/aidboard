import {
  lireParamsEcriture,
  resumeEcriture,
  type Ecriture,
  type ActionEcriture,
} from './ecritures.js';
export interface ParametresActions {
  'mesh.ecrire': Ecriture;
  merge: {
    topicId: string;
    depot: string;
    pr: number;
    tete: string;
    strategie: 'squash' | 'merge' | 'rebase';
    supprimerBranche: boolean;
    nettoyer: boolean;
    teteNettoyage: string | null;
  };
  push: { topicId: string; branche: string; tete: string; distante: string | null };
  nettoyage: {
    topicId: string;
    branche: string;
    tete: string | null;
    etat: string;
    nonFusionnes: number | null;
    sale: 'refuser' | 'stash' | 'force';
  };
  'projet.retirer': { workspaceId: string; racine: string };
  appairage: { appairageId: string; nom: string; hIdentite: string | null; sansIdentite: boolean };
  'pda.activer': { appareilId: string; nom: string; empreinte: string };
  'host.option': { option: 'code' | 'push'; actif: boolean };
  reglage: {
    action: 'merge' | 'push' | 'nettoyage' | 'projet.retirer' | 'mesh.ecrire';
    actif: false;
  };
  desarmement: Record<string, never>;
  essai: Record<string, never>;
}
export type ActionConfirmee = keyof ParametresActions;
export type ClasseConfirmation = 'toujours' | 'defaut';
export const CLASSE_ACTION = Object.freeze({
  'mesh.ecrire': 'defaut',
  merge: 'defaut',
  push: 'defaut',
  nettoyage: 'defaut',
  'projet.retirer': 'defaut',
  appairage: 'toujours',
  'pda.activer': 'toujours',
  'host.option': 'toujours',
  reglage: 'toujours',
  desarmement: 'toujours',
  essai: 'defaut',
} as const satisfies Record<ActionConfirmee, ClasseConfirmation>);

export type ParamsAction = {
  [A in ActionConfirmee]: { action: A; params: ParametresActions[A] };
}[ActionConfirmee];
export type CorpsDemandeV2 = {
  [A in ActionConfirmee]: {
    v: 2;
    id: string;
    action: A;
    classe: (typeof CLASSE_ACTION)[A];
    params: ParametresActions[A];
    resume: string;
    numero: (typeof CLASSE_ACTION)[A] extends 'toujours' ? null : string;
    echeance: number;
    emise: number;
  };
}[ActionConfirmee];

type Validation = (valeur: unknown) => boolean;
// C0, C1, séparateurs de ligne et marques de direction sont interdits à l'affichage.
// eslint-disable-next-line no-control-regex -- Le schéma refuse explicitement les contrôles C0.
const interdits = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const texte =
  (maximum: number): Validation =>
  (v) =>
    typeof v === 'string' && Array.from(v).length <= maximum && !interdits.test(v);
const motif =
  (expression: RegExp): Validation =>
  (v) =>
    typeof v === 'string' && expression.exec(v)?.[0] === v;
const identifiant = motif(/^[A-Za-z0-9_-]{1,64}$/);
const tete = motif(/^[a-f0-9]{40}$/);
const nullable =
  (valider: Validation): Validation =>
  (v) =>
    v === null || valider(v);
const booleen: Validation = (v) => typeof v === 'boolean';
const choix =
  (...valeurs: unknown[]): Validation =>
  (v) =>
    valeurs.includes(v);
const branche: Validation = (v) =>
  typeof v === 'string' &&
  v.length > 0 &&
  texte(200)(v) &&
  !/\s/u.test(v) &&
  !v.includes('..') &&
  !/^[-/]/.test(v);
const schemas: Record<ActionConfirmee, Record<string, Validation>> = {
  'mesh.ecrire': {
    action: choix('carte.note', 'dm.envoyer', 'canal.poster'),
    params: () => true,
  },
  merge: {
    topicId: identifiant,
    depot: (v) =>
      typeof v === 'string' && v.length <= 100 && motif(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)(v),
    pr: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1e9,
    tete,
    strategie: choix('squash', 'merge', 'rebase'),
    supprimerBranche: booleen,
    nettoyer: booleen,
    teteNettoyage: nullable(tete),
  },
  push: { topicId: identifiant, branche, tete, distante: nullable(tete) },
  nettoyage: {
    topicId: identifiant,
    branche,
    tete: nullable(tete),
    etat: texte(60),
    nonFusionnes: nullable(
      (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e6,
    ),
    sale: choix('refuser', 'stash', 'force'),
  },
  'projet.retirer': { workspaceId: identifiant, racine: texte(1024) },
  appairage: {
    appairageId: identifiant,
    nom: (v) => texte(40)(v) && typeof v === 'string' && !/[<>]/.test(v),
    hIdentite: nullable(motif(/^[A-Za-z0-9_-]{43}$/)),
    sansIdentite: booleen,
  },
  'pda.activer': {
    appareilId: identifiant,
    nom: (v) => texte(40)(v) && typeof v === 'string' && !/[<>]/.test(v),
    empreinte: motif(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/),
  },
  'host.option': { option: choix('code', 'push'), actif: booleen },
  reglage: {
    action: choix('merge', 'push', 'nettoyage', 'projet.retirer', 'mesh.ecrire'),
    actif: choix(false),
  },
  desarmement: {},
  essai: {},
};

export function validerParamsAction(action: ActionConfirmee, params: unknown): boolean {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const schema = schemas[action];
  const p = params as Record<string, unknown>;
  return (
    (action !== 'mesh.ecrire' || lireParamsEcriture(p.action as ActionEcriture, p.params, '').ok) &&
    (action !== 'merge' || p.nettoyer === true || p.teteNettoyage === null) &&
    Object.keys(p).length === Object.keys(schema).length &&
    Object.entries(schema).every(([cle, valider]) => Object.hasOwn(p, cle) && valider(p[cle]))
  );
}

export function resumeAction<A extends ActionConfirmee>(
  action: A,
  params: ParametresActions[A],
): string;
export function resumeAction(
  action: ActionConfirmee,
  params: ParametresActions[ActionConfirmee],
): string {
  if (!Object.hasOwn(CLASSE_ACTION, action) || !validerParamsAction(action, params))
    throw new Error('Paramètres invalides');
  const p = { action, params } as ParamsAction;
  let resume: string;
  switch (p.action) {
    case 'mesh.ecrire':
      resume = resumeEcriture(p.params.action, p.params.params);
      break;
    case 'merge':
      resume = `Merge de ${p.params.depot}#${p.params.pr} (${p.params.tete.slice(0, 7)}), ${p.params.strategie}, branche supprimée ${p.params.supprimerBranche ? 'oui' : 'non'}${p.params.nettoyer ? ', puis nettoyage' : ''}`;
      break;
    case 'push':
      resume = `Push de ${p.params.branche} (${p.params.tete.slice(0, 7)})`;
      break;
    case 'nettoyage':
      resume = `Nettoyage du sujet ${p.params.branche}${p.params.nonFusionnes ? `, ${p.params.nonFusionnes} commits non fusionnés perdus` : ''}${p.params.sale === 'stash' ? ', modifications locales mises de côté' : p.params.sale === 'force' ? ', modifications locales perdues' : ''}`;
      break;
    case 'projet.retirer': {
      const nom = p.params.racine.replace(/\/+$/, '').split('/').at(-1) ?? '';
      if (!texte(60)(nom)) throw new Error('Nom trop long');
      resume = `Retrait du projet ${nom}`;
      break;
    }
    case 'appairage':
      resume = `Approuver l'appareil ${p.params.nom}`;
      break;
    case 'pda.activer':
      resume = `Activer le PDA ${p.params.nom}, empreinte ${p.params.empreinte}`;
      break;
    case 'host.option':
      resume =
        p.params.option === 'code'
          ? 'Montrer le code aux appareils'
          : 'Notifications push sur les appareils';
      break;
    case 'reglage':
      resume = `Confirmations : ${p.params.action} coupée`;
      break;
    case 'essai':
      resume = "Demande d'essai";
      break;
    case 'desarmement':
      resume = 'Désarmer les confirmations';
      break;
  }
  if (Array.from(resume).length > 160) throw new Error('Résumé trop long');
  return resume;
}
