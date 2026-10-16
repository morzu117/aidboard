import type { Db } from '../db.js';
import type { AidEvent } from '../../shared/events.js';
import { AGENT_STATUSES, clip, isSubSession, sanitizeDetail, sanitizePending } from './status.js';

const STOPPED_REASONS = new Set(['user', 'daemon_restart', 'daemon_stop']);
const ENDED = new Set(['done', 'error', 'stopped']);

interface AgentRow {
  status: string;
  status_source: string | null;
  pid: number | null;
}

function projectStatus(tx: Db, e: AidEvent, d: Record<string, unknown>): void {
  const row = tx
    .prepare('SELECT status, status_source, pid FROM agents WHERE id = ?')
    .get(e.agentId) as AgentRow | undefined;
  // un statut rejoué après la fin (spool, hook en retard) ne ressuscite pas l'agent
  if (!row || ENDED.has(row.status)) return;
  // la pause est un geste humain passé par le daemon : un agent ne peut pas se dire en pause
  if (e.source === 'daemon' && typeof d.paused === 'boolean') {
    tx.prepare('UPDATE agents SET paused_at = ?, updated_at = ? WHERE id = ?').run(
      d.paused ? e.ts : null,
      e.ts,
      e.agentId,
    );
    return;
  }
  const status = String(d.status);
  if (!AGENT_STATUSES.has(status)) return;
  const source = e.source === 'heuristic' ? 'heuristic' : e.source === 'daemon' ? 'daemon' : 'hook';
  // un signal sûr a déjà été reçu : l'estimation se tait
  if (source === 'heuristic' && row.status_source === 'hook') return;
  if (isSubSession(d.chain, row.pid)) return;
  const pending = status === 'needs_input' ? sanitizePending(d.pending) : null;
  const detail = source === 'heuristic' ? sanitizeDetail(d) : null;
  tx.prepare(
    'UPDATE agents SET status = ?, status_reason = ?, status_message = ?, status_source = ?, status_at = ?, status_detail = ?, pending = ?, updated_at = ? WHERE id = ?',
  ).run(
    status,
    status === 'needs_input' ? clip(d.reason, 32) : null,
    clip(d.message, 500),
    source,
    e.ts,
    detail && JSON.stringify(detail),
    pending && JSON.stringify(pending),
    e.ts,
    e.agentId,
  );
}

export function project(tx: Db, e: AidEvent): void {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'topic.state':
      tx.prepare(
        'UPDATE topics SET state = COALESCE(?, state), index_state = COALESCE(?, index_state), updated_at = ? WHERE id = ?',
      ).run(d.state ?? null, d.indexState ?? null, e.ts, e.topicId);
      break;
    case 'topic.phase':
      tx.prepare('UPDATE topics SET phase = ?, updated_at = ? WHERE id = ?').run(
        d.phase ?? null,
        e.ts,
        e.topicId,
      );
      break;
    case 'agent.spawned':
      tx.prepare("UPDATE agents SET status = 'starting', pid = ?, updated_at = ? WHERE id = ?").run(
        d.pid ?? null,
        e.ts,
        e.agentId,
      );
      break;
    case 'agent.exited': {
      const status = STOPPED_REASONS.has(String(d.reason))
        ? 'stopped'
        : d.exitCode === 0
          ? 'done'
          : 'error';
      tx.prepare(
        'UPDATE agents SET status = ?, exit_code = ?, pending = NULL, paused_at = NULL, updated_at = ? WHERE id = ?',
      ).run(status, d.exitCode ?? null, e.ts, e.agentId);
      break;
    }
    case 'agent.status':
      projectStatus(tx, e, d);
      break;
    case 'agent.tool': {
      const label = clip(d.label, 200);
      if (label)
        tx.prepare(
          "UPDATE agents SET last_tool = ?, updated_at = ? WHERE id = ? AND status NOT IN ('done', 'error', 'stopped')",
        ).run(label, e.ts, e.agentId);
      break;
    }
    case 'approval.resolved':
      // la réponse donnée, l'agent repart ; refusée, la main revient à l'humain. Le hook suivant corrige.
      tx.prepare(
        "UPDATE agents SET pending = NULL, status = CASE WHEN status = 'needs_input' THEN ? ELSE status END, status_reason = NULL, status_at = ?, updated_at = ? WHERE id = ? AND json_extract(pending, '$.id') = ?",
      ).run(d.option === 'no' ? 'idle' : 'working', e.ts, e.ts, e.agentId, d.pendingId ?? null);
      break;
    case 'run.state':
      tx.prepare('UPDATE runs SET state = ? WHERE id = ?').run(d.state, e.runId);
      break;
    case 'action.started':
      tx.prepare(
        "INSERT OR IGNORE INTO actions (id, topic_id, workspace_id, action, state, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
      ).run(d.actionId, e.topicId ?? null, e.workspaceId, d.action, e.ts);
      break;
    case 'action.finished':
      tx.prepare(
        'UPDATE actions SET state = ?, exit_code = ?, result = ?, finished_at = ?, topic_id = COALESCE(topic_id, ?) WHERE id = ?',
      ).run(
        d.outcome ?? 'failed',
        d.exitCode ?? null,
        d.result === undefined ? null : JSON.stringify(d.result),
        e.ts,
        e.topicId ?? null,
        d.actionId,
      );
      break;
    default:
      break;
  }
}
