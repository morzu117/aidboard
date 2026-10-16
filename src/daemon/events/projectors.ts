import type { Db } from '../db.js';
import type { AidEvent } from '../../shared/events.js';

const STOPPED_REASONS = new Set(['user', 'daemon_restart', 'daemon_stop']);

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
      tx.prepare('UPDATE agents SET status = ?, exit_code = ?, updated_at = ? WHERE id = ?').run(
        status,
        d.exitCode ?? null,
        e.ts,
        e.agentId,
      );
      break;
    }
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
