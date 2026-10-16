import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { WorkspaceQueue } from '../src/daemon/actions/queue.js';
import { scriptEnv, startAction, type ActionContext } from '../src/daemon/actions/service.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const script = (name: string) => join(import.meta.dirname, 'fixtures/scripts', name);

async function ctx(): Promise<ActionContext> {
  t = await startTestDaemon();
  t.db
    .prepare(
      "INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at) VALUES ('ws_1','a','/a','main','/w','t0')",
    )
    .run();
  return { store: t.store, paths: resolvePaths(t.home), queue: new WorkspaceQueue() };
}

const base = {
  workspaceId: 'ws_1',
  action: 'test.action',
  cwd: '/tmp',
  env: { ...process.env },
  timeoutMs: 10_000,
};

test('started, sortie éphémère, finished : l’action est tracée de bout en bout', async () => {
  const c = await ctx();
  const ephemeral: string[] = [];
  t.store.on('ephemeral', (m) => ephemeral.push(m.line as string));
  const { actionId, done } = startAction(c, { ...base, script: script('ok.sh') });
  expect(t.db.prepare('SELECT state FROM actions WHERE id = ?').get(actionId)).toEqual({
    state: 'running',
  });
  await done;
  expect(t.db.prepare('SELECT state, exit_code FROM actions WHERE id = ?').get(actionId)).toEqual({
    state: 'succeeded',
    exit_code: 0,
  });
  expect(ephemeral.sort()).toEqual(['bonjour', 'erreur']);
  expect(t.store.since(null).map((e) => e.type)).toEqual(['action.started', 'action.finished']);
  expect(readFileSync(join(t.home, 'logs/actions', `${actionId}.log`), 'utf8')).toContain(
    'bonjour',
  );
});

test('needs_human et failed se retrouvent dans la table', async () => {
  const c = await ctx();
  const a = startAction(c, { ...base, script: script('human.sh') });
  const b = startAction(c, { ...base, script: script('fail.sh') });
  await Promise.all([a.done, b.done]);
  const states = t.db.prepare('SELECT id, state FROM actions').all() as Array<{
    id: string;
    state: string;
  }>;
  expect(Object.fromEntries(states.map((s) => [s.id, s.state]))).toEqual({
    [a.actionId]: 'needs_human',
    [b.actionId]: 'failed',
  });
});

test('afterSuccess écrit ses événements avant action.finished et fournit le topicId', async () => {
  const c = await ctx();
  const { done } = startAction(c, {
    ...base,
    script: script('result.sh'),
    afterSuccess: (out) => {
      t.store.append({
        source: 'action',
        type: 'cost',
        workspaceId: 'ws_1',
        data: { vu: out.result },
      });
      return { topicId: 'tp_9' };
    },
  });
  await done;
  const events = t.store.since(null);
  expect(events.map((e) => e.type)).toEqual(['action.started', 'cost', 'action.finished']);
  expect(events[2]).toMatchObject({
    topicId: 'tp_9',
    data: { outcome: 'succeeded', result: { a: 1, b: 'x' } },
  });
});

test('afterSuccess qui lève : l’action est failed avec la cause dans la queue', async () => {
  const c = await ctx();
  const { actionId, done } = startAction(c, {
    ...base,
    script: script('ok.sh'),
    afterSuccess: () => {
      throw new Error('insertion impossible');
    },
  });
  await done;
  expect(t.db.prepare('SELECT state FROM actions WHERE id = ?').get(actionId)).toEqual({
    state: 'failed',
  });
  const fin = t.store.since(null).find((e) => e.type === 'action.finished')!;
  expect((fin.data.tail as string[]).join('\n')).toContain('insertion impossible');
});

test('le journal d’une action existe même quand le script échoue', async () => {
  const c = await ctx();
  const { actionId, done } = startAction(c, { ...base, script: script('fail.sh') });
  await done;
  expect(existsSync(join(t.home, 'logs/actions', `${actionId}.log`))).toBe(true);
});

test('scriptEnv retire les clés à ne pas transmettre et verrouille git', () => {
  const env = scriptEnv(
    { ANTHROPIC_API_KEY: 'x', PATH: '/bin', HOME: '/h' },
    ['ANTHROPIC_API_KEY'],
    { AID_SLUG: 's' },
  );
  expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', AID_SLUG: 's', GIT_TERMINAL_PROMPT: '0' });
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
});
