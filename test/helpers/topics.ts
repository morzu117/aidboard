import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDaemon, waitFor, type TestDaemon } from './daemon.js';
import { makeOriginAndClone } from './git.js';

export const FAKE_CODEGRAPH = join(import.meta.dirname, '../fixtures/fake-codegraph.sh');

export interface Ctx {
  t: TestDaemon;
  clone: string;
  origin: string;
  ws: { id: string; name: string; worktreesDir: string };
}

export async function setupWorkspace(
  opts: { codegraph?: boolean; bin?: string; editor?: string[]; local?: boolean } = {},
): Promise<Ctx> {
  const t = await startTestDaemon(undefined, {
    codegraphBin: opts.bin ?? FAKE_CODEGRAPH,
    config: opts.editor ? { editor: opts.editor } : undefined,
  });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aid-tc-')));
  const repo = makeOriginAndClone(dir, { codegraph: opts.codegraph, local: opts.local });
  const res = await t.d.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: t.headers,
    payload: { path: repo.clone },
  });
  return { t, ...repo, ws: res.json() };
}

export function finished(t: TestDaemon, actionId: string) {
  return waitFor(
    () =>
      t.store.since(null).find((e) => e.type === 'action.finished' && e.data.actionId === actionId),
    15_000,
    `fin de ${actionId}`,
  );
}

export function postCreate(c: Ctx, title: string, extra: Record<string, unknown> = {}) {
  return c.t.d.app.inject({
    method: 'POST',
    url: '/api/topics',
    headers: c.t.headers,
    payload: { workspaceId: c.ws.id, title, type: 'feat', ...extra },
  });
}

export async function makeTopic(c: Ctx, title = 'Sujet de test') {
  const r = await postCreate(c, title);
  const { actionId, slug, branch } = r.json<{ actionId: string; slug: string; branch: string }>();
  const fin = await finished(c.t, actionId);
  if (fin.data.outcome !== 'succeeded')
    throw new Error(`création échouée : ${JSON.stringify(fin.data)}`);
  return { slug, branch, wt: join(c.ws.worktreesDir, slug), topicId: fin.topicId! };
}

export function postAction(
  c: Ctx,
  topicId: string,
  action: string,
  body?: Record<string, unknown>,
) {
  return c.t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/${action}`,
    headers: c.t.headers,
    payload: (body ?? {}) as never,
  });
}
