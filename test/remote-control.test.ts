import { delimiter, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { issueRunToken } from '../src/daemon/security.js';
import type { RemoteControlState } from '../src/shared/agentSettings.js';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

/** Chantier 23 (A.1, D87-D90) : le remote-control d'un agent de sujet, par ses routes, avec le faux claude. */
const STREAM_BIN = join(import.meta.dirname, 'fixtures/bin-stream');
const saved = { PATH: process.env.PATH };
let c: Ctx | undefined;

afterEach(async () => {
  process.env.PATH = saved.PATH;
  delete process.env.FAKE_CLAUDE_RC_REFUSE;
  await c?.t.d.stop();
  c = undefined;
});

async function spawnAgent(kind: 'claude' | 'codex', title = 'Sujet de test') {
  process.env.PATH = `${STREAM_BIN}${delimiter}${saved.PATH}`;
  c = await setupWorkspace({ config: { agents: { transport: 'stream' } } });
  const topic = await makeTopic(c, title);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind });
  if (kind === 'claude')
    await waitFor(
      () =>
        (
          c!.t.db.prepare('SELECT session_id FROM agents WHERE id = ?').get(agent.id) as {
            session_id: string | null;
          }
        ).session_id === agent.sessionId,
      5000,
      'session claude',
    );
  return agent;
}

const rc = (agentId: string, method: 'GET' | 'POST', payload?: unknown, headers = c!.t.headers) =>
  c!.t.d.app.inject({
    method,
    url: `/api/agents/${agentId}/remote-control`,
    headers,
    ...(payload !== undefined && { payload: payload as never }),
  });

const etat = async (agentId: string) => (await rc(agentId, 'GET')).json<RemoteControlState>();

const resumes = (agentId: string) =>
  c!.t.store.since(null).filter((e) => e.type === 'agent.resumed' && e.agentId === agentId).length;

function assistantDit(agentId: string, text: string): boolean {
  return (
    c!.t.db
      .prepare("SELECT payload FROM agent_messages WHERE agent_id = ? AND kind = 'message'")
      .all(agentId) as Array<{ payload: string }>
  ).some((m) => (JSON.parse(m.payload) as { text?: string }).text === text);
}

test('claude : éteint avant tout ; activé → url, puis connecté ; la session porte le titre du sujet ; désactivé → off', async () => {
  const agent = await spawnAgent('claude', 'Titre du sujet');
  const avant = await rc(agent.id, 'GET');
  expect(avant.statusCode).toBe(200);
  expect(avant.json()).toEqual({ status: 'off' });

  const on = await rc(agent.id, 'POST', { enabled: true });
  expect(on.statusCode).toBe(200);
  expect(on.json()).toEqual({
    status: 'connecting',
    url: 'https://claude.ai/code/session_fake1',
  });
  await waitFor(
    () => c!.t.d.agents.remoteControlState(agent.id).status === 'connected',
    5000,
    'connecté',
  );
  expect(await etat(agent.id)).toEqual({
    status: 'connected',
    url: 'https://claude.ai/code/session_fake1',
  });

  c!.t.d.agents.input(agent.id, 'remote-control');
  const vu = `echo: remote-control ${JSON.stringify({ enabled: true, name: 'A-I-D · Titre du sujet' })}`;
  await waitFor(() => assistantDit(agent.id, vu), 5000, 'nom de la session');

  const off = await rc(agent.id, 'POST', { enabled: false });
  expect(off.statusCode).toBe(200);
  expect(off.json()).toEqual({ status: 'off' });
  expect(await etat(agent.id)).toEqual({ status: 'off' });
  expect(resumes(agent.id)).toBe(0);
});

test('codex : unsupported en lecture, 409 à l’activation comme à la désactivation', async () => {
  const agent = await spawnAgent('codex');
  expect(await etat(agent.id)).toEqual({ status: 'unsupported' });
  for (const enabled of [true, false]) {
    const r = await rc(agent.id, 'POST', { enabled });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('remote-control non pris en charge par codex');
  }
  // en veille aussi : refusé sans être réveillé
  await c!.t.d.agents.stop(agent.id, 'user');
  for (const enabled of [false, true]) {
    const r = await rc(agent.id, 'POST', { enabled });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('remote-control non pris en charge par codex');
  }
  expect(c!.t.d.agents.getStream(agent.id)?.exited).toBe(true);
  expect(resumes(agent.id)).toBe(0);
  expect(await etat(agent.id)).toEqual({ status: 'unsupported' });
});

test('agent en veille : désactiver rend off sans le relancer ; activer le relance', async () => {
  const agent = await spawnAgent('claude');
  await rc(agent.id, 'POST', { enabled: true });
  await waitFor(
    () => c!.t.d.agents.remoteControlState(agent.id).status === 'connected',
    5000,
    'connecté',
  );
  await c!.t.d.agents.stop(agent.id, 'user');
  const endormi = c!.t.d.agents.getStream(agent.id);
  expect(endormi?.exited).toBe(true);
  // D89 : rien n'a survécu au process
  expect(await etat(agent.id)).toEqual({ status: 'off' });

  const off = await rc(agent.id, 'POST', { enabled: false });
  expect(off.statusCode).toBe(200);
  expect(off.json()).toEqual({ status: 'off' });
  expect(c!.t.d.agents.getStream(agent.id)).toBe(endormi);
  expect(resumes(agent.id)).toBe(0);

  const on = await rc(agent.id, 'POST', { enabled: true });
  expect(on.statusCode).toBe(200);
  expect(on.json()).toEqual({
    status: 'connecting',
    url: 'https://claude.ai/code/session_fake1',
  });
  expect(resumes(agent.id)).toBe(1);
  const reveille = c!.t.d.agents.getStream(agent.id);
  expect(reveille).not.toBe(endormi);
  expect(reveille?.exited).toBe(false);
});

test('refus de claude → 502 avec son message', async () => {
  const refus = 'Remote Control is not enabled for this account';
  process.env.FAKE_CLAUDE_RC_REFUSE = refus;
  const agent = await spawnAgent('claude');
  const r = await rc(agent.id, 'POST', { enabled: true });
  expect(r.statusCode).toBe(502);
  expect(r.body).toContain(refus);
  expect(await etat(agent.id)).toEqual({ status: 'error', error: refus });
});

test('entrées refusées : corps invalide 400, agent inconnu 404, token de run 403', async () => {
  const agent = await spawnAgent('claude');
  for (const payload of [{}, { enabled: 'oui' }, { enabled: true, name: 'x' }, []]) {
    const r = await rc(agent.id, 'POST', payload);
    expect(r.statusCode, JSON.stringify(payload)).toBe(400);
  }
  expect(await etat(agent.id)).toEqual({ status: 'off' });
  expect((await rc('ag_inconnu', 'GET')).statusCode).toBe(404);
  expect((await rc('ag_inconnu', 'POST', { enabled: true })).statusCode).toBe(404);

  const run = (
    c!.t.db.prepare('SELECT run_id FROM agents WHERE id = ?').get(agent.id) as { run_id: string }
  ).run_id;
  const headers = { ...c!.t.headers, authorization: `Bearer ${issueRunToken(c!.t.d.auth, run)}` };
  expect((await rc(agent.id, 'GET', undefined, headers)).statusCode).toBe(403);
  expect((await rc(agent.id, 'POST', { enabled: true }, headers)).statusCode).toBe(403);
  expect(await etat(agent.id)).toEqual({ status: 'off' });
});
