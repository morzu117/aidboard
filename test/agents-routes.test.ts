import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openDb } from '../src/daemon/db.js';
import type { Agent } from '../src/shared/model.js';
import type { StateSnapshot } from '../src/shared/state.js';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, postAction, setupWorkspace, finished } from './helpers/topics.js';

const saved = process.env.SHELL;
let c: Ctx;
afterEach(async () => {
  process.env.SHELL = saved;
  await c?.t.d.stop();
});

async function boot() {
  process.env.SHELL = '/bin/sh';
  c = await setupWorkspace();
  return makeTopic(c);
}

const post = (payload: unknown) =>
  c.t.d.app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: c.t.headers,
    payload: payload as never,
  });
const del = (id: string) =>
  c.t.d.app.inject({ method: 'DELETE', url: `/api/agents/${id}`, headers: c.t.headers });
const state = async () =>
  (await c.t.d.app.inject({ url: '/api/state', headers: c.t.headers })).json<StateSnapshot>();

test('POST /api/agents : 201, l’agent apparaît dans l’état, DELETE l’arrête', async () => {
  const { topicId } = await boot();
  const r = await post({ topicId, kind: 'shell' });
  expect(r.statusCode).toBe(201);
  const agent = r.json<Agent>();
  expect(agent).toMatchObject({ kind: 'shell', status: 'starting', transport: 'pty' });
  expect((await state()).agents.map((a) => a.id)).toEqual([agent.id]);

  expect((await del(agent.id)).statusCode).toBe(202);
  await waitFor(
    () => c.t.store.since(null).find((e) => e.type === 'agent.exited' && e.agentId === agent.id),
    8000,
    'sortie',
  );
  expect((await state()).agents[0]).toMatchObject({ status: 'stopped' });
  expect((await del(agent.id)).statusCode).toBe(409);
});

test('erreurs : sujet inconnu 404, kind invalide 400, binaire absent 422, agent inconnu 404', async () => {
  const { topicId } = await boot();
  expect((await post({ topicId: 'tp_nope', kind: 'shell' })).statusCode).toBe(404);
  expect((await post({ topicId, kind: 'vim' })).statusCode).toBe(400);
  expect((await post({ topicId, kind: 'shell', extra: 1 })).statusCode).toBe(400);
  const path = process.env.PATH;
  process.env.PATH = '/nexiste/pas';
  const r = await post({ topicId, kind: 'codex' });
  process.env.PATH = path;
  expect(r.statusCode).toBe(422);
  expect(r.json().error).toContain('introuvable dans le PATH');
  expect((await del('ag_nope')).statusCode).toBe(404);
});

test('un jeton d’agent ne peut ni lancer ni arrêter un agent', async () => {
  const { topicId } = await boot();
  const agent = (await post({ topicId, kind: 'shell' })).json<Agent>();
  const token = c.t.d.auth.runTokens.keys().next().value as string;
  const h = { host: c.t.headers.host!, authorization: `Bearer ${token}` };
  const spawn = await c.t.d.app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: h,
    payload: { topicId, kind: 'shell' },
  });
  expect(spawn.statusCode).toBe(403);
  expect(
    (await c.t.d.app.inject({ method: 'DELETE', url: `/api/agents/${agent.id}`, headers: h }))
      .statusCode,
  ).toBe(403);
});

test('archiver un sujet libère les miroirs de ses agents terminés', async () => {
  const { topicId } = await boot();
  const agent = (await post({ topicId, kind: 'shell' })).json<Agent>();
  c.t.d.agents.get(agent.id)!.pty.write('exit\n');
  await waitFor(() => c.t.d.agents.get(agent.id)?.exited, 8000, 'sortie');
  const r = await postAction(c, topicId, 'topic.cleanup');
  await finished(c.t, r.json().actionId);
  expect(c.t.d.agents.get(agent.id)).toBeUndefined();
});

test('arrêter le daemon arrête tous les agents avec la raison daemon_stop', async () => {
  const { topicId } = await boot();
  const a = (await post({ topicId, kind: 'shell' })).json<Agent>();
  const b = (await post({ topicId, kind: 'shell' })).json<Agent>();
  const home = c.t.home;
  await c.t.d.stop();
  for (const pid of [a.pid!, b.pid!]) expect(() => process.kill(pid, 0)).toThrow();
  const db = openDb(join(home, 'state.db'));
  const rows = db.prepare('SELECT status FROM agents ORDER BY id').all();
  const reasons = db.prepare("SELECT data FROM events WHERE type = 'agent.exited'").all() as Array<{
    data: string;
  }>;
  db.close();
  expect(rows).toEqual([{ status: 'stopped' }, { status: 'stopped' }]);
  expect(reasons.map((r) => JSON.parse(r.data).reason)).toEqual(['daemon_stop', 'daemon_stop']);
});
