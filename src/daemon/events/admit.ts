import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { EVENT_SOURCES, EVENT_TYPES } from '../../shared/events.js';
import type { Db } from '../db.js';

// Ce qu'un agent peut dire de lui-même : jamais l'état du sujet, jamais une validation.
const AGENT_SOURCES = new Set(['hook:claude', 'codex:json', 'heuristic']);
const AGENT_TYPES = new Set([
  'agent.status',
  'agent.tool',
  'approval.requested',
  'files.changed',
  'cost',
  'run.command',
]);

// une union de littéraux, pas un Type.Unsafe : Value.Check (rejeu du spool) ne sait pas vérifier ce dernier
const oneOf = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));

export const EventBody = Type.Object(
  {
    v: Type.Optional(Type.Literal(1)),
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    ts: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    source: oneOf(EVENT_SOURCES),
    type: oneOf(EVENT_TYPES),
    workspaceId: Type.Optional(Type.String()),
    topicId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type EventBody = Static<typeof EventBody>;

export const isEventBody = (v: unknown): v is EventBody => Value.Check(EventBody, v);

/**
 * Un événement venu d'un agent (POST avec le token de son run, ou fichier du spool) : source et type autorisés,
 * agent du même run, et le sujet comme le workspace repris du run, jamais de l'agent. Rend l'erreur, ou null.
 */
export function admitAgentEvent(db: Db, body: EventBody, runId: string): string | null {
  if (!AGENT_SOURCES.has(body.source) || !AGENT_TYPES.has(body.type))
    return 'type ou source réservés au daemon';
  const run = db
    .prepare(
      'SELECT r.id AS run_id, t.id AS topic_id, t.workspace_id FROM runs r JOIN topics t ON t.id = r.topic_id WHERE r.id = ?',
    )
    .get(runId) as { run_id: string; topic_id: string; workspace_id: string } | undefined;
  if (!run) return 'run inconnu';
  if (body.agentId) {
    const own = db
      .prepare('SELECT 1 FROM agents WHERE id = ? AND run_id = ?')
      .get(body.agentId, runId);
    if (!own) return 'agent étranger';
  }
  body.runId = run.run_id;
  body.topicId = run.topic_id;
  body.workspaceId = run.workspace_id;
  return null;
}
