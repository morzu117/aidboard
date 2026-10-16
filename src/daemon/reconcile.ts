import type { Db } from './db.js';
import type { EventStore } from './events/store.js';

const LIVE = ['starting', 'working', 'needs_input', 'idle'];

// Les PTY sont des enfants du daemon : à son démarrage, ce qui était vivant ne l'est plus.
export function reconcile(db: Db, store: EventStore): void {
  const agents = db
    .prepare(
      `SELECT a.id, a.run_id, r.topic_id, t.workspace_id FROM agents a
       JOIN runs r ON r.id = a.run_id JOIN topics t ON t.id = r.topic_id
       WHERE a.status IN (${LIVE.map(() => '?').join(',')})`,
    )
    .all(...LIVE) as Array<{ id: string; run_id: string; topic_id: string; workspace_id: string }>;
  for (const a of agents) {
    store.append({
      source: 'daemon',
      type: 'agent.exited',
      workspaceId: a.workspace_id,
      topicId: a.topic_id,
      runId: a.run_id,
      agentId: a.id,
      data: { exitCode: null, reason: 'daemon_restart' },
    });
  }
  const actions = db
    .prepare("SELECT id, topic_id, workspace_id FROM actions WHERE state = 'running'")
    .all() as Array<{ id: string; topic_id: string | null; workspace_id: string }>;
  for (const a of actions) {
    store.append({
      source: 'daemon',
      type: 'action.finished',
      workspaceId: a.workspace_id,
      ...(a.topic_id && { topicId: a.topic_id }),
      data: { actionId: a.id, outcome: 'failed', exitCode: null, reason: 'daemon_restart' },
    });
  }
}
