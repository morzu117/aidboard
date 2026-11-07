import { Type } from '@sinclair/typebox';
import type { Agent } from '../shared/model.js';
import type { Db } from './db.js';
import type { EventStore } from './events/store.js';

export const CorpsMarqueTour = Type.Object(
  {
    tourId: Type.String({ minLength: 1 }),
    etat: Type.Union([Type.Literal('relu'), Type.Literal('a_reprendre')]),
  },
  { additionalProperties: false },
);
export type MarqueTour = { tourId: string; etat: 'relu' | 'a_reprendre' };

export function lireMarqueTour(db: Db, id: string): Agent['marqueTour'] {
  const ligne = db
    .prepare(
      `SELECT m.tour_id AS tourId, m.etat, m.par,
    CASE WHEN m.par = 'mac' THEN 'Mac' ELSE COALESCE(p.nom, 'Appareil') END AS parNom, m.a
    FROM tours_marques m JOIN agents g ON g.id = m.agent_id
    LEFT JOIN appareils p ON p.id = m.par
    WHERE g.id = ? AND g.kind != 'shell' AND g.closed_at IS NULL
    AND (g.status = 'error' OR (g.status = 'idle' AND COALESCE(g.status_reason, '') != 'question'))
    AND m.tour_id = g.status_at`,
    )
    .get(id);
  return (ligne as Agent['marqueTour'] | undefined) ?? null;
}

// D189, D191 : validation et écritures synchrones, sans attente entre le contrôle et l'événement.
export function marquerTour(
  db: Db,
  store: EventStore,
  id: string,
  corps: MarqueTour,
  appareil?: { id: string; nom: string },
) {
  const agent = db
    .prepare(
      `SELECT g.*, r.topic_id, t.workspace_id FROM agents g
    JOIN runs r ON r.id = g.run_id JOIN topics t ON t.id = r.topic_id WHERE g.id = ?`,
    )
    .get(id) as
    | {
        kind: string;
        status: string;
        status_reason: string | null;
        status_at: string | null;
        closed_at: string | null;
        run_id: string;
        topic_id: string;
        workspace_id: string;
      }
    | undefined;
  if (!agent) return { status: 404, corps: { error: 'agent inconnu' } };
  if (
    agent.closed_at ||
    agent.kind === 'shell' ||
    !agent.status_at ||
    !(
      (agent.status === 'idle' && agent.status_reason !== 'question') ||
      agent.status === 'error'
    ) ||
    agent.status_at !== corps.tourId
  )
    return { status: 409, corps: { raison: 'perimee' } };
  const contexte = {
    source: 'daemon' as const,
    agentId: id,
    runId: agent.run_id,
    topicId: agent.topic_id,
    workspaceId: agent.workspace_id,
  };
  store.append({
    ...contexte,
    type: 'tour.marque',
    data: { ...corps, par: appareil?.id ?? 'mac', parNom: appareil?.nom ?? 'Mac' },
  });
  if (appareil)
    store.append({
      ...contexte,
      type: 'appareil.ecriture',
      data: { appareilId: appareil.id, nom: appareil.nom, route: '/api/appareils/agents/:id/tour' },
    });
  return { status: 200, corps: { marque: appareil ? corps.etat : lireMarqueTour(db, id) } };
}
