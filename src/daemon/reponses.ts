import { Type } from '@sinclair/typebox';
import { ASK_TEXT_ANSWER } from '../shared/question.js';
import type { PendingRequest } from '../shared/model.js';
import type { Db } from './db.js';
import { AidHttpError } from './errors.js';
import type { EventStore } from './events/store.js';
import type { AgentManager } from './pty/manager.js';

export const CorpsReponseAppareil = Type.Object(
  { pendingId: Type.String(), option: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
export type ReponseAppareil = { pendingId: string; option: number };

// D190 : aucune donnée de la question ne vient de l'appareil, hormis l'index proposé.
export function repondreAppareil(
  deps: { db: Db; store: EventStore; agents: Pick<AgentManager, 'answer'> },
  id: string,
  corps: ReponseAppareil,
  appareil: { id: string; nom: string },
) {
  const agent = deps.db
    .prepare(
      `SELECT g.transport, g.permission_mode, g.pending, g.run_id, r.topic_id, t.workspace_id
      FROM agents g JOIN runs r ON r.id = g.run_id
      JOIN topics t ON t.id = r.topic_id WHERE g.id = ?`,
    )
    .get(id) as
    | {
        transport: string;
        permission_mode: string | null;
        pending: string | null;
        run_id: string;
        topic_id: string;
        workspace_id: string;
      }
    | undefined;
  if (!agent) return { status: 404, corps: { error: 'agent inconnu' } };
  const refuser = (raison: 'mode' | 'nature') => {
    deps.store.append({
      source: 'daemon',
      type: 'appareil.refus',
      agentId: id,
      runId: agent.run_id,
      topicId: agent.topic_id,
      workspaceId: agent.workspace_id,
      data: {
        appareilId: appareil.id,
        nom: appareil.nom,
        route: '/api/appareils/agents/:id/reponse',
        raison,
      },
    });
    return { status: 403, corps: { raison } };
  };
  if (agent.permission_mode !== 'default' && agent.permission_mode !== 'plan')
    return refuser('mode');
  const pending = agent.pending ? (JSON.parse(agent.pending) as PendingRequest) : null;
  // Le stream ne fournit pas de mode vivant : sortir du plan interdit ce repli.
  if (agent.transport === 'stream') {
    if (agent.permission_mode !== 'default') return refuser('mode');
  } else if (
    pending &&
    (!pending.modeVivantA || !['default', 'plan'].includes(pending.modeVivant ?? ''))
  ) {
    return refuser('mode');
  }
  if (!pending) {
    // Une demande consommée se distingue d'un agent qui n'a jamais posé cette question.
    const tranchee = deps.db
      .prepare(
        `SELECT 1 FROM events WHERE agent_id = ? AND type = 'approval.resolved'
        AND json_extract(data, '$.pendingId') = ? LIMIT 1`,
      )
      .get(id, corps.pendingId);
    if (tranchee) return { status: 409, corps: { raison: 'deja_tranchee' } };
  }
  if (!pending || pending.kind !== 'question') return refuser('nature');
  if (pending.id !== corps.pendingId) return { status: 409, corps: { raison: 'perimee' } };
  const option = pending.options[corps.option];
  if (!option || option.answer === ASK_TEXT_ANSWER.answer)
    return { status: 400, corps: { raison: 'option' } };
  try {
    deps.agents.answer(id, corps.pendingId, option.answer);
  } catch (erreur) {
    if (erreur instanceof AidHttpError && erreur.extra.raison === 'deja_tranchee')
      return { status: 409, corps: { raison: 'deja_tranchee' } };
    throw erreur;
  }
  deps.store.append({
    source: 'daemon',
    type: 'appareil.ecriture',
    agentId: id,
    runId: agent.run_id,
    topicId: agent.topic_id,
    workspaceId: agent.workspace_id,
    data: {
      appareilId: appareil.id,
      nom: appareil.nom,
      route: '/api/appareils/agents/:id/reponse',
    },
  });
  return { status: 200, corps: { ok: true } };
}
