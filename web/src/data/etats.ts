import type { BoardObligation, BoardStep } from '../../../src/shared/board.js';
import type { ActionEtat, ParametresEtat } from '../../../src/shared/etats.js';
import type { AidClient } from './client.js';
import type { ResultatEnvoi } from './ecritures.js';

// D275 : attendre evidence_json et skipped dans la PR proxy 702.
export const CLOTURE_PAR_CONDITION = false;
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
): Promise<{ confirmation: string } | ResultatEnvoi> {
  return client.request('POST', '/api/swarph/etat/envoyer', { action, params });
}
