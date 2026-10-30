import type { Db } from '../db.js';
import type { AidEvent } from '../../shared/events.js';
import { AGENT_STATUSES, clip, isSubSession, sanitizeDetail, sanitizePending } from './status.js';
import { MESH_DM_KINDS } from '../../shared/model.js';

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
    status === 'needs_input' || (status === 'idle' && d.reason === 'question')
      ? clip(d.reason, 32)
      : null,
    clip(d.message, 500),
    source,
    e.ts,
    detail && JSON.stringify(detail),
    pending && JSON.stringify(pending),
    e.ts,
    e.agentId,
  );
}

// Un DM du mesh (12.1, D36) : idempotent par son id swarph, en plus de l'ULID de l'événement. Un rejeu ne duplique rien.
function projectMeshDm(tx: Db, e: AidEvent, d: Record<string, unknown>): void {
  if (!Number.isInteger(d.id) || !MESH_DM_KINDS.includes(d.kind as never)) return;
  tx.prepare(
    'INSERT OR IGNORE INTO mesh_inbox (id, thread_id, from_node, to_node, kind, content, created_at, reply_to, obligation_id, seen_at, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
  ).run(
    d.id,
    clip(d.threadId, 200),
    clip(d.from, 200) ?? '',
    clip(d.to, 200) ?? '',
    d.kind,
    typeof d.content === 'string' ? d.content : '',
    clip(d.createdAt, 40) ?? e.ts,
    Number.isInteger(d.replyTo) ? d.replyTo : null,
    clip(d.obligationId, 200),
    e.id,
  );
}

// L'état du mesh (12.1, D36) : une clé par champ, la valeur en JSON ; le dernier événement l'emporte.
const MESH_STATE_KEYS = ['connected', 'tailscale', 'monitor', 'pending', 'since', 'cell'] as const;
function projectMeshState(tx: Db, d: Record<string, unknown>): void {
  const upsert = tx.prepare(
    'INSERT INTO mesh_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  );
  for (const k of MESH_STATE_KEYS) if (d[k] !== undefined) upsert.run(k, JSON.stringify(d[k]));
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
    case 'topic.branch':
      tx.prepare('UPDATE topics SET branch = ?, updated_at = ? WHERE id = ?').run(
        d.branch,
        e.ts,
        e.topicId,
      );
      break;
    case 'topic.pr':
      tx.prepare(
        "UPDATE topics SET state = 'review', pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ?",
      ).run(d.prNumber ?? null, d.prUrl ?? null, e.ts, e.topicId);
      break;
    case 'topic.stash':
      tx.prepare('UPDATE topics SET stash_ref = ?, updated_at = ? WHERE id = ?').run(
        d.stashRef ?? null,
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
    case 'agent.resumed':
      // relance paresseuse (A.6) : la ligne `agents` revient vivante, puis `inputStream` suit son chemin habituel.
      tx.prepare(
        "UPDATE agents SET status = 'starting', exit_code = NULL, pending = NULL, paused_at = NULL, pid = NULL, status_source = 'daemon', status_at = ?, updated_at = ? WHERE id = ?",
      ).run(e.ts, e.ts, e.agentId);
      break;
    case 'agent.status':
      projectStatus(tx, e, d);
      break;
    case 'agent.settings':
      // D69 : le réglage de l'agent, et le défaut du prochain agent du même kind (D67)
      tx.prepare(
        'UPDATE agents SET permission_mode = ?, model = ?, effort = ?, updated_at = ? WHERE id = ?',
      ).run(d.mode ?? null, d.model ?? null, d.effort ?? null, e.ts, e.agentId);
      if (typeof d.kind === 'string' && typeof d.mode === 'string')
        tx.prepare(
          'INSERT INTO agent_defaults (kind, permission_mode, model, effort) VALUES (?, ?, ?, ?) ON CONFLICT(kind) DO UPDATE SET permission_mode = excluded.permission_mode, model = excluded.model, effort = excluded.effort',
        ).run(d.kind, d.mode, d.model ?? null, d.effort ?? null);
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
    case 'mesh.dm':
      projectMeshDm(tx, e, d);
      break;
    case 'mesh.state':
      projectMeshState(tx, d);
      break;
    default:
      break;
  }
}
