import { existsSync } from 'node:fs';
import type { ActionRun, Agent, Run, Topic, Workspace } from '../../shared/model.js';
import type { StateSnapshot } from '../../shared/state.js';
import type { Db } from '../db.js';

type Row = Record<string, unknown>;

export function buildSnapshot(db: Db, all = false): StateSnapshot {
  const workspaces = (db.prepare('SELECT * FROM workspaces ORDER BY name').all() as Row[]).map(
    (r): Workspace => ({
      id: r.id as string,
      name: r.name as string,
      root: r.root as string,
      remote: (r.remote as string | null) ?? null,
      baseBranch: r.base_branch as string,
      worktreesDir: r.worktrees_dir as string,
      createdAt: r.created_at as string,
    }),
  );
  const topics = (
    db
      .prepare("SELECT * FROM topics WHERE (? = 1 OR state != 'archived') ORDER BY created_at, id")
      .all(all ? 1 : 0) as Row[]
  ).map((r): Topic => ({
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
    worktreeMissing: !existsSync(r.worktree as string),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
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
  const agents = (db.prepare('SELECT * FROM agents ORDER BY created_at, id').all() as Row[])
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
      exitCode: r.exit_code as number | null,
      issue: r.issue as number | null,
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
  return { lastEventId: last?.id ?? null, workspaces, topics, runs, agents, actions };
}
