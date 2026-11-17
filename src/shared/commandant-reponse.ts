/** Codes fermés du contrat : aucun corps distant ne devient un résultat signé. */
export const CODES_REFUS_COMMANDANT = [
  'digest_mismatch',
  'not_pending',
  'needs_sso',
  'cockpit_not_allowed',
  'not_found',
  'bad_decision',
  'bad_answer',
  'digest_required',
  'champ_requis',
  'cockpit_credential_unknown',
  'cockpit_credential_revoked',
  'cockpit_credential_expired',
] as const;
export type CodeRefusCommandant = (typeof CODES_REFUS_COMMANDANT)[number];
export const HTTP_REFUS_COMMANDANT: Record<CodeRefusCommandant, number> = {
  digest_mismatch: 409,
  not_pending: 409,
  needs_sso: 403,
  cockpit_not_allowed: 403,
  not_found: 404,
  bad_decision: 400,
  bad_answer: 400,
  digest_required: 400,
  champ_requis: 422,
  cockpit_credential_unknown: 401,
  cockpit_credential_revoked: 401,
  cockpit_credential_expired: 401,
};
export const CONSIGNE_IDENTIFIANT_COMMANDANT =
  'crée un nouvel identifiant dans le Command Center, puis colle-le ici';
const MESSAGES_COMMANDANT: Record<string, string> = {
  not_pending: 'La demande a déjà reçu une réponse ailleurs',
  digest_mismatch: 'La demande a changé côté passerelle : relis-la',
  needs_sso: 'Cette question demande ta session SSO : réponds dans le Command Center',
  cockpit_not_allowed: 'La passerelle ne permet pas cette réponse depuis le cockpit',
  not_found: 'La demande n’existe plus côté passerelle : relis la file',
  bad_decision: 'La passerelle refuse ce type de réponse : relis la demande',
  bad_answer: 'La passerelle refuse cette réponse : corrige-la et recommence',
  digest_required: 'La passerelle exige le digest complet : relis la demande',
  champ_requis: 'Un champ requis manque à la réponse : relis la demande et recommence',
  cockpit_credential_expired: CONSIGNE_IDENTIFIANT_COMMANDANT,
  cockpit_credential_revoked: CONSIGNE_IDENTIFIANT_COMMANDANT,
  cockpit_credential_unknown: CONSIGNE_IDENTIFIANT_COMMANDANT,
  delai: 'La passerelle met trop de temps à répondre : réessaie',
  taille: 'La réponse de la passerelle est trop volumineuse',
  reseau: 'La passerelle est injoignable : réessaie',
  connexion: 'La réponse n’est pas confirmée : vérifie la demande avant de recommencer',
  format: 'La réponse rendue est illisible : vérifie la demande avant de recommencer',
  json: 'La réponse de la passerelle est illisible : réessaie',
  http: 'La passerelle refuse la lecture : réessaie',
  gateway: 'L’adresse de la passerelle est invalide ou non sécurisée',
  identifiant: 'L’identifiant cockpit est indisponible : vérifie les Réglages swarph',
  requete: 'La demande de lecture est invalide : relis la file',
  commandant_parametres: 'Les paramètres de la réponse sont invalides : relis la demande',
  commandant_bad_answer: 'La réponse sort des règles : corrige-la et recommence',
  commandant_type: 'Cette action se confirme dans l’onglet Command de swarph-desktop',
  commandant_not_pending: 'La demande a déjà reçu une réponse ailleurs',
  commandant_needs_sso: 'Cette question demande ta session SSO : réponds dans le Command Center',
  commandant_limites:
    'Cette question dépasse les limites du cockpit : réponds dans le Command Center',
  commandant_digest_mismatch: 'La demande a changé côté passerelle : relis-la',
  commandant_indisponible: 'Le cockpit est indisponible pour ce mesh',
  confirmation_requise: 'Active les confirmations sur le Mac avant de répondre',
  confirmation_impossible: 'Allume le PDA et active un téléphone avant de recommencer',
  demande_trop_grande: 'Cette réponse est trop longue pour le PDA : raccourcis-la et recommence',
};
const RAISONS_ILLISIBLES: Record<string, string> = {
  digest: 'le digest ne correspond pas',
  summary: 'le résumé sort des règles',
  forme: 'la forme de la demande est invalide',
  why: 'le motif sort des règles',
  question: 'la question ne correspond pas aux paramètres',
  options: 'les options ne correspondent pas aux paramètres',
  head_sha: 'la tête ne correspond pas aux paramètres',
  needs_sso: 'la session requise ne correspond pas aux paramètres',
  statut: 'le statut est inconnu',
  date: 'une date est invalide',
};
export function identifiantCommandantARefaire(code?: string | null): boolean {
  return [
    'cockpit_credential_expired',
    'cockpit_credential_revoked',
    'cockpit_credential_unknown',
  ].includes((code ?? '').replace(/^commandant_/, ''));
}
export function messageErreurCommandant(code: string, http?: number): string {
  const simple = code.replace(/^commandant_/, '');
  const raison = code.startsWith('commandant_illisible_')
    ? RAISONS_ILLISIBLES[code.slice('commandant_illisible_'.length)]
    : undefined;
  const message =
    MESSAGES_COMMANDANT[code] ??
    (code.startsWith('commandant_') ? MESSAGES_COMMANDANT[simple] : undefined);
  if (!message && !raison) return `Lecture ou réponse impossible${http ? ` (HTTP ${http})` : ''}.`;
  const statut = http ?? HTTP_REFUS_COMMANDANT[simple as CodeRefusCommandant];
  return `${raison ? `La demande est illisible : ${raison}` : message} (${statut ? `${statut} ` : ''}${code}).`;
}
export function libelleReponseCommandant(resultat: string | null, code?: string | null): string {
  if (resultat === 'perimee')
    return 'Périmée : la demande a changé. Relis-la avant de recommencer.';
  if (resultat === 'executee') return 'Répondu';
  if (resultat === 'echouee' && code === 'envoyee_rendu_inattendu')
    return "La passerelle a accepté l'envoi, mais sa réponse ne correspond pas : la réponse est peut-être enregistrée. Relis la demande avant de recommencer.";
  if (resultat === 'echouee') return messageErreurCommandant(code ?? 'connexion');
  return '';
}
export function ageCommandant(creation: number, maintenant: number): string {
  const minutes = Math.max(0, Math.floor((maintenant - creation) / 60_000));
  if (minutes < 60) return `il y a ${minutes} min`;
  const heures = Math.floor(minutes / 60);
  return heures < 24 ? `il y a ${heures} h` : `il y a ${Math.floor(heures / 24)} j`;
}
