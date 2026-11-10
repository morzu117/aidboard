import type { BoardObligation, BoardStep } from '../../../src/shared/board.js';
import type { ActionEtat, ParametresEtat } from '../../../src/shared/etats.js';
import { AidApiError } from './api.js';
import type { AidClient } from './client.js';
import type { ResultatEnvoi as EnvoiEcriture } from './ecritures.js';
export type ResultatEtat = Pick<EnvoiEcriture, 'code' | 'status'>;

// D275 levé : la PR proxy 702 accepte evidence_json et skipped.
export const CLOTURE_PAR_CONDITION = true;
export type ActionPossible = 'prendre' | 'refuser' | 'clore';

export function actionsPossibles(
  obligation: BoardObligation,
  etape: BoardStep | null | undefined,
  cell: string,
): ActionPossible[] {
  if (obligation.status !== 'open') return [];
  const actions: ActionPossible[] = [];
  if (
    obligation.takenAt === null &&
    (obligation.holder === cell || (obligation.holder === null && etape?.eligible.includes(cell)))
  )
    actions.push('prendre', 'refuser');
  if (
    obligation.holder === cell &&
    obligation.unclosableReason === null &&
    (CLOTURE_PAR_CONDITION || obligation.conditions.length === 0)
  )
    actions.push('clore');
  return actions;
}

export function envoyerEtat<A extends ActionEtat>(
  action: A,
  params: ParametresEtat[A],
  client: AidClient,
): Promise<{ confirmation: string } | ResultatEtat> {
  return client
    .request<{ confirmation: string } | ResultatEtat>('POST', '/api/swarph/etat/envoyer', {
      action,
      params,
    })
    .catch((e: unknown) => {
      if (e instanceof AidApiError && e.status === 409 && e.body.error === 'proxy_lecture_seule')
        return { code: 'proxy_lecture_seule' };
      throw e;
    });
}

export function confirmationEtatRequise(erreur: unknown): boolean {
  return (
    erreur instanceof AidApiError &&
    erreur.status === 409 &&
    erreur.body.error === 'confirmation_requise'
  );
}
