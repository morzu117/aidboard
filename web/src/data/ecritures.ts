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
