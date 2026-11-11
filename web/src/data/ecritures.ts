import type { ActionEcriture, ParametresEcriture } from '../../../src/shared/ecritures.js';
import { AidApiError } from './api.js';
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
  | 'proxy_lecture_seule'
  | 'demande_trop_grande'
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
  detail?: string;
  current_stage?: string;
  warn?: string;
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
    case 'proxy_lecture_seule':
      return 'Le proxy de ta cellule est en lecture seule : rien ne peut partir.';
    case 'demande_trop_grande':
      return "Trop long pour être confirmé au téléphone : raccourcis le texte. Rien n'est parti.";
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
  propositionSwairm?: number,
): Promise<{ confirmation: string } | ResultatEnvoi> {
  return client
    .request<{ confirmation: string } | ResultatEnvoi>('POST', '/api/swarph/ecrire/envoyer', {
      action,
      params,
      ...(propositionSwairm === undefined ? {} : { propositionSwairm }),
    })
    .catch((e: unknown) => {
      if (e instanceof AidApiError && e.status === 409 && e.body.error === 'proxy_lecture_seule')
        return { code: 'proxy_lecture_seule', open_obligations: [] };
      if (e instanceof AidApiError && e.status === 413 && e.body.error === 'demande_trop_grande')
        return { code: 'demande_trop_grande' as const, open_obligations: [] };
      throw e;
    });
}
