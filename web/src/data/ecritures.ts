import type { ActionEcriture, ParametresEcriture } from '../../../src/shared/ecritures.js';
import type { AidClient } from './client.js';

export type ApercuEcriture =
  | {
      ok: true;
      aBlanc: true;
      argv: string[];
      resume: string;
      texte: string;
      rappel: { obligations: number[] } | { indisponible: true } | null;
    }
  | { ok: false; kind: 'schema' | 'nettoyage'; message: string };

export function apercuEcriture<A extends ActionEcriture>(
  action: A,
  params: ParametresEcriture[A],
  client: AidClient,
): Promise<ApercuEcriture> {
  return client.request('POST', '/api/swarph/ecrire/apercu', { action, params });
}

export type CodeEnvoi =
  | 'obligation-close'
  | 'succes'
  | 'proxy_unavailable'
  | 'connexion'
  | 'upstream_unreachable'
  | 'upstream_ambiguous'
  | 'delai'
  | 'interrompu'
  | 'format'
  | 'upstream_error'
  | 'verb_not_allowed'
  | 'bad_args'
  | 'peer_not_allowed';

export interface ResultatEnvoi {
  code: CodeEnvoi;
  id?: number;
  open_obligations: number[];
  status?: number;
}

export function envoiIncertain(resultat: ResultatEnvoi): boolean {
  return ['upstream_ambiguous', 'delai', 'interrompu', 'format', 'obligation-close'].includes(
    resultat.code,
  );
}

export function libelleEnvoi(resultat: ResultatEnvoi): string {
  if (envoiIncertain(resultat))
    return 'Envoi incertain : il est peut-être parti. Relis le fil avant de réessayer.';
  switch (resultat.code) {
    case 'succes':
      return 'Parti.';
    case 'proxy_unavailable':
    case 'connexion':
      return "Le proxy de ta cellule ne répond pas. Rien n'est parti.";
    case 'upstream_unreachable':
      return "Le gateway est injoignable. Rien n'est parti.";
    case 'upstream_error':
      return `Le gateway a refusé (statut ${resultat.status ?? 'inconnu'}).`;
    default:
      return `Le proxy a refusé cette écriture (${resultat.code}). C'est un défaut d'A-I-D ou de configuration.`;
  }
}

export function envoyerEcriture<A extends ActionEcriture>(
  action: A,
  params: ParametresEcriture[A],
  client: AidClient,
): Promise<{ confirmation: string } | ResultatEnvoi> {
  return client.request('POST', '/api/swarph/ecrire/envoyer', { action, params });
}
