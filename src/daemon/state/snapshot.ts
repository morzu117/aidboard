import { existsSync } from 'node:fs';
import type { ActionRun, Agent, Run, Topic, TopicIndex, Workspace } from '../../shared/model.js';
import type { StateSnapshot } from '../../shared/state.js';
import type { Db } from '../db.js';
import type { StructuralService } from '../structural/service.js';
import type { MeshService } from '../mesh/service.js';

type Row = Record<string, unknown>;

const parseJson = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : null);

// DS7 : jamais stocké, relu en direct (comme gitLiveInfo pour git) — `null` dès que le moteur
// n'a rien d'exploitable (coupé, binaire absent, pas encore initialisé…), sans distinction.
async function topicIndex(engine: StructuralService, worktree: string): Promise<TopicIndex | null> {
  const status = await engine.status(worktree);
  if (status.state === 'unavailable') return null;
  return {
    engine: status.engine,
    indexedAt: status.indexedAt,
    stale: status.state === 'stale',
    pending: status.pending,
    languages: status.languages,
  };
}

export async function buildSnapshot(
  db: Db,
  engine: StructuralService,
  all = false,
  mesh: MeshService | null = null,
  swairmEnabled = false,
): Promise<StateSnapshot> {
  const workspaces = (db.prepare('SELECT * FROM workspaces ORDER BY name').all() as Row[]).map(
    (r): Workspace => ({
      id: r.id as string,
      name: r.name as string,
      root: r.root as string,
      remote: (r.remote as string | null) ?? null,
      baseBranch: r.base_branch as string,
      worktreesDir: r.worktrees_dir as string,
      namespace: (r.namespace as string | null) ?? null,
      createdAt: r.created_at as string,
    }),
  );
  const topicRows = db
    .prepare("SELECT * FROM topics WHERE (? = 1 OR state != 'archived') ORDER BY created_at, id")
    .all(all ? 1 : 0) as Row[];
  const topics = await Promise.all(
    topicRows.map(async (r): Promise<Topic> => ({
      id: r.id as string,
      workspaceId: r.workspace_id as string,
      slug: r.slug as string,
      title: r.title as string,
      type: r.type as Topic['type'],
      branch: r.branch as string,
      base: r.base as string,
      worktree: r.worktree as string,
      state: r.state as Topic['state'],
      phase: r.phase as Topic['phase'],
      indexState: r.index_state as Topic['indexState'],
      index: await topicIndex(engine, r.worktree as string),
      worktreeMissing: !existsSync(r.worktree as string),
      prNumber: r.pr_number as number | null,
      prUrl: r.pr_url as string | null,
      stashRef: r.stash_ref as string | null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    })),
  );
  const topicIds = new Set(topics.map((t) => t.id));
  const runs = (db.prepare('SELECT * FROM runs ORDER BY created_at, id').all() as Row[])
    .filter((r) => topicIds.has(r.topic_id as string))
    .map((r): Run => ({
      id: r.id as string,
      topicId: r.topic_id as string,
      mode: r.mode as Run['mode'],
      state: r.state as string,
      createdAt: r.created_at as string,
    }));
  const runIds = new Set(runs.map((r) => r.id));
  const agents = (
    db
      .prepare('SELECT * FROM agents WHERE closed_at IS NULL ORDER BY created_at, id')
      .all() as Row[]
  )
    .filter((r) => runIds.has(r.run_id as string))
    .map((r): Agent => ({
      id: r.id as string,
      runId: r.run_id as string,
      kind: r.kind as Agent['kind'],
      role: r.role as Agent['role'],
      transport: r.transport as Agent['transport'],
      status: r.status as Agent['status'],
      cwd: r.cwd as string,
      command: JSON.parse(r.command as string) as string[],
      pid: r.pid as number | null,
      sessionId: (r.session_id as string | null) ?? null,
      exitCode: r.exit_code as number | null,
      issue: r.issue as number | null,
      statusReason: (r.status_reason as string | null) ?? null,
      statusMessage: (r.status_message as string | null) ?? null,
      statusSource: (r.status_source as Agent['statusSource']) ?? null,
      statusAt: (r.status_at as string | null) ?? null,
      statusDetail: parseJson(r.status_detail) as Agent['statusDetail'],
      lastTool: (r.last_tool as string | null) ?? null,
      pending: parseJson(r.pending) as Agent['pending'],
      pausedAt: (r.paused_at as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
  const actions = (
    db.prepare('SELECT * FROM actions ORDER BY started_at DESC, id DESC LIMIT 100').all() as Row[]
  )
    .reverse()
    .map((r): ActionRun => ({
      id: r.id as string,
      topicId: r.topic_id as string | null,
      workspaceId: r.workspace_id as string,
      action: r.action as string,
      state: r.state as ActionRun['state'],
      exitCode: r.exit_code as number | null,
      result: r.result ? (JSON.parse(r.result as string) as Record<string, unknown>) : null,
      startedAt: r.started_at as string,
      finishedAt: r.finished_at as string | null,
    }));
  const last = db.prepare('SELECT id FROM events ORDER BY seq DESC LIMIT 1').get() as
    { id: string } | undefined;
  return {
    lastEventId: last?.id ?? null,
    workspaces,
    topics,
    runs,
    agents,
    actions,
    ...(swairmEnabled && { swairm: { enabled: true as const } }),
    // 12.4 : présent seulement quand une cell est configurée (D39)
    ...(mesh && {
      mesh: { state: mesh.current(), inbox: mesh.inbox(), tailscaleManage: mesh.tailscaleManage },
    }),
  };
}
