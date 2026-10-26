import { delimiter, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { gracefulInterrupt } from '../src/daemon/pty/reprise.js';
import type { PendingRequest } from '../src/shared/model.js';
import { startTestDaemon, waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

const PTY_BIN = join(import.meta.dirname, 'fixtures/bin');
const STREAM_BIN = join(import.meta.dirname, 'fixtures/bin-stream');
const saved = { PATH: process.env.PATH };
let c: Ctx | undefined;

afterEach(async () => {
  process.env.PATH = saved.PATH;
  await c?.t.d.stop();
  c = undefined;
});

async function spawnPty(kind: 'claude') {
  process.env.PATH = `${PTY_BIN}${delimiter}${saved.PATH}`;
  // D63/A.6 : le défaut est passé à `stream` ; ce chemin du fichier vise le terminal PTY.
  c = await setupWorkspace({ config: { agents: { transport: 'pty' } } });
  const topic = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind });
  return { agent, topic };
}

async function spawnStream(kind: 'claude' | 'codex') {
  process.env.PATH = `${STREAM_BIN}${delimiter}${saved.PATH}`;
  c = await setupWorkspace({ config: { agents: { transport: 'stream' } } });
  const topic = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind });
  return { agent, topic };
}

function row(agentId: string) {
  return c!.t.db
    .prepare('SELECT status, pending, session_id FROM agents WHERE id = ?')
    .get(agentId) as { status: string; pending: string | null; session_id: string | null };
}

function pendingOf(agentId: string): PendingRequest | null {
  const p = row(agentId).pending;
  return p ? (JSON.parse(p) as PendingRequest) : null;
}

function messages(agentId: string, kind: string): unknown[] {
  return (
    c!.t.db
      .prepare('SELECT payload FROM agent_messages WHERE agent_id = ? AND kind = ?')
      .all(agentId, kind) as Array<{ payload: string }>
  ).map((m) => JSON.parse(m.payload));
}

function tourLongDemarre(agentId: string): boolean {
  return messages(agentId, 'message').some(
    (m) => (m as { role?: string; text?: string }).text === 'tour long démarré',
  );
}

function interrompu(agentId: string): boolean {
  return messages(agentId, 'turn_end').some((m) => (m as { ok?: boolean }).ok === false);
}

test('transport pty (défaut) : spawn claude reste PTY, aucun changement de comportement', async () => {
  const { agent } = await spawnPty('claude');
  expect(agent.transport).toBe('pty');
  expect(agent.sessionId).toBeNull();
  const live = c!.t.d.agents.get(agent.id);
  expect(live).toBeDefined();
  await waitFor(() => live!.mirror.screen().some((l) => l.includes('PRÊT')), 5000, 'PRÊT');
});

test('transport stream : spawn claude → stream, session_id = l’UUID passé en --session-id', async () => {
  const { agent } = await spawnStream('claude');
  expect(agent.transport).toBe('stream');
  expect(agent.pid).toBeNull();
  expect(agent.sessionId).toBeTruthy();
  const idx = agent.command.indexOf('--session-id');
  expect(idx).toBeGreaterThan(0);
  expect(agent.command[idx + 1]).toBe(agent.sessionId);
  expect(c!.t.d.agents.get(agent.id)).toBeUndefined();
  expect(c!.t.d.agents.getStream(agent.id)).toBeDefined();
});

test('transport stream : spawn codex → session_id = id du thread renvoyé par le faux serveur', async () => {
  const { agent } = await spawnStream('codex');
  expect(agent.transport).toBe('stream');
  expect(agent.sessionId).toBeNull();
  await waitFor(() => row(agent.id).session_id === 'thread-new-fixed', 5000, 'thread.id codex');
});

test('input : ligne stdin côté faux agent, lignes agent_messages user puis assistant, statut working puis idle', async () => {
  const { agent } = await spawnStream('claude');
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');

  c!.t.d.agents.input(agent.id, 'bonjour');
  expect(row(agent.id).status).toBe('working');

  await waitFor(() => row(agent.id).status === 'idle', 5000, 'fin du tour');
  const messages = c!.t.db
    .prepare('SELECT kind, payload FROM agent_messages WHERE agent_id = ? ORDER BY seq')
    .all(agent.id) as Array<{ kind: string; payload: string }>;
  const parsed = messages.map((m) => JSON.parse(m.payload) as { role?: string; text?: string });
  expect(parsed.some((p) => p.role === 'user' && p.text === 'bonjour')).toBe(true);
  expect(parsed.some((p) => p.role === 'assistant' && p.text === 'echo: bonjour')).toBe(true);
});

test('demande de permission : statut needs_input + pending, answer(yes) → approval.resolved, id périmé → 409', async () => {
  const { agent } = await spawnStream('claude');
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');

  c!.t.d.agents.input(agent.id, 'demande permission');
  await waitFor(() => row(agent.id).status === 'needs_input', 5000, 'demande de permission');
  const pending = pendingOf(agent.id)!;
  expect(pending).toMatchObject({ kind: 'permission' });

  expect(() => c!.t.d.agents.answer(agent.id, 'id-perime', 'yes')).toThrow();

  c!.t.d.agents.answer(agent.id, pending.id, 'yes');
  await waitFor(() => row(agent.id).status === 'idle', 5000, 'fin du tour');
  const resolved = c!.t.store
    .since(null)
    .find((e) => e.type === 'approval.resolved' && e.agentId === agent.id);
  expect(resolved).toMatchObject({ data: { pendingId: pending.id, option: 'yes', by: 'human' } });
  expect(c!.t.d.agents.screen(agent.id, 6)).toContain('fait');
});

test('interrupt : tour terminé, statut idle ; setPaused → 409 ; interrupt sur un agent PTY → 409', async () => {
  const { agent } = await spawnStream('claude');
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');

  c!.t.d.agents.input(agent.id, 'tour long');
  await waitFor(
    () => row(agent.id).status === 'working' && tourLongDemarre(agent.id),
    5000,
    'tour long démarré',
  );
  c!.t.d.agents.interrupt(agent.id);
  await waitFor(() => row(agent.id).status === 'idle', 5000, 'idle après interruption');
  expect(interrompu(agent.id)).toBe(true);

  expect(() => c!.t.d.agents.setPaused(agent.id, true)).toThrow(
    'pas de pause pour un agent conversationnel',
  );

  const { agent: ptyAgent } = await spawnPty('claude');
  expect(() => c!.t.d.agents.interrupt(ptyAgent.id)).toThrow(
    'interruption réservée aux agents conversationnels',
  );
});

test('stop : agent.exited reason user, statut stopped ; stopAll arrête aussi les agents stream', async () => {
  const { agent } = await spawnStream('claude');
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');

  await c!.t.d.agents.stop(agent.id, 'user');
  expect(row(agent.id).status).toBe('stopped');
  const exited = c!.t.store
    .since(null)
    .find((e) => e.type === 'agent.exited' && e.agentId === agent.id);
  expect(exited).toMatchObject({ data: { reason: 'user' } });

  const { agent: second } = await spawnStream('claude');
  await c!.t.d.agents.stopAll('daemon_stop', 5000);
  expect(row(second.id).status).toBe('stopped');
});

test('screen() d’un agent stream rend la fin du dernier message assistant', async () => {
  const { agent } = await spawnStream('claude');
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');
  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(() => row(agent.id).status === 'idle', 5000, 'fin du tour');
  expect(c!.t.d.agents.screen(agent.id, 6)).toEqual(['echo: bonjour']);
});

test('route POST /api/agents/:id/interrupt', async () => {
  process.env.PATH = `${STREAM_BIN}${delimiter}${saved.PATH}`;
  c = await setupWorkspace({ config: { agents: { transport: 'stream' } } });
  const topic = await makeTopic(c);
  const spawned = await c.t.d.app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: c.t.headers,
    payload: { topicId: topic.topicId, kind: 'claude' },
  });
  const agent = spawned.json<{ id: string; sessionId: string }>();
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');
  c.t.d.agents.input(agent.id, 'tour long');
  await waitFor(
    () => row(agent.id).status === 'working' && tourLongDemarre(agent.id),
    5000,
    'tour long démarré',
  );
  const r = await c.t.d.app.inject({
    method: 'POST',
    url: `/api/agents/${agent.id}/interrupt`,
    headers: c.t.headers,
  });
  expect(r.statusCode).toBe(202);
  await waitFor(() => row(agent.id).status === 'idle', 5000, 'idle après interruption');
  expect(interrompu(agent.id)).toBe(true);

  expect(
    (
      await c.t.d.app.inject({
        method: 'POST',
        url: `/api/agents/ag_nope/interrupt`,
        headers: c.t.headers,
      })
    ).statusCode,
  ).toBe(404);
});

test('DELETE /api/agents/:id sur un agent stream vivant : 202 puis arrêté ; DELETE à nouveau : 200 puis libéré', async () => {
  const { agent } = await spawnStream('claude');
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');

  const r1 = await c!.t.d.app.inject({
    method: 'DELETE',
    url: `/api/agents/${agent.id}`,
    headers: c!.t.headers,
  });
  expect(r1.statusCode).toBe(202);
  await waitFor(() => row(agent.id).status === 'stopped', 5000, 'arrêt');
  expect(c!.t.d.agents.getStream(agent.id)?.exited).toBe(true);

  const r2 = await c!.t.d.app.inject({
    method: 'DELETE',
    url: `/api/agents/${agent.id}`,
    headers: c!.t.headers,
  });
  expect(r2.statusCode).toBe(200);
  const closed = c!.t.db.prepare('SELECT closed_at FROM agents WHERE id = ?').get(agent.id) as {
    closed_at: string | null;
  };
  expect(closed.closed_at).not.toBeNull();
  expect(c!.t.d.agents.getStream(agent.id)).toBeUndefined();
});

test('archivage du sujet : un agent stream terminé de ce sujet est libéré', async () => {
  const { agent, topic } = await spawnStream('claude');
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');
  await c!.t.d.agents.stop(agent.id, 'user');
  expect(c!.t.d.agents.getStream(agent.id)?.exited).toBe(true);

  c!.t.store.append({
    source: 'daemon',
    type: 'topic.state',
    topicId: topic.topicId,
    data: { state: 'archived' },
  });
  expect(c!.t.d.agents.getStream(agent.id)).toBeUndefined();
});

test('reprise (A.6) : le faux claude sort de lui-même, le message suivant relance sous le même agentId, en resume, seq continu, un seul message user', async () => {
  const { agent } = await spawnStream('claude');
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');
  const sid = agent.sessionId!;

  c!.t.d.agents.input(agent.id, 'crash');
  await waitFor(() => c!.t.d.agents.getStream(agent.id)?.exited === true, 5000, 'sortie');
  const seqAvant = (
    c!.t.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM agent_messages WHERE agent_id = ?')
      .get(agent.id) as { maxSeq: number }
  ).maxSeq;

  c!.t.d.agents.input(agent.id, 'bonjour');
  expect(row(agent.id).status).toBe('working');
  await waitFor(() => row(agent.id).status === 'idle', 5000, 'fin du tour après relance');

  // même id de session reprise par --resume (test/conversation-claude.test.ts prouve l'argument au niveau pilote)
  expect(row(agent.id).session_id).toBe(sid);
  const seqApres = (
    c!.t.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM agent_messages WHERE agent_id = ?')
      .get(agent.id) as { maxSeq: number }
  ).maxSeq;
  expect(seqApres).toBeGreaterThan(seqAvant);
  const bonjours = messages(agent.id, 'message').filter(
    (m) =>
      (m as { role?: string; text?: string }).role === 'user' &&
      (m as { text?: string }).text === 'bonjour',
  );
  expect(bonjours).toHaveLength(1);
  expect(
    messages(agent.id, 'message').some(
      (m) =>
        (m as { role?: string; text?: string }).role === 'assistant' &&
        (m as { text?: string }).text === 'echo: bonjour',
    ),
  ).toBe(true);
});

test('reprise (A.6) : cycle arrêt/redémarrage du daemon simulé, un second manager relance sous le même agentId', async () => {
  const { agent } = await spawnStream('claude');
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');
  const sid = agent.sessionId!;

  await c!.t.d.agents.stopAll('daemon_stop', 2000);
  const home = c!.t.home;
  await c!.t.d.stop();
  const t2 = await startTestDaemon(home, { config: { agents: { transport: 'stream' } } });
  c = { ...c!, t: t2 };

  expect(t2.d.agents.getStream(agent.id)).toBeUndefined();
  t2.d.agents.input(agent.id, 'bonjour');
  await waitFor(() => row(agent.id).status === 'idle', 5000, 'fin du tour après redémarrage');
  expect(row(agent.id).session_id).toBe(sid);
});

test('reprise (A.6) codex : sans session_id → thread/start (nouveau thread) ; avec → thread/resume (même id restitué)', async () => {
  const { agent } = await spawnStream('codex');
  await waitFor(() => row(agent.id).session_id === 'thread-new-fixed', 5000, 'thread.id codex');

  // « mort avant le premier `session` » : simulé en base, la course exacte n'est pas reproductible
  // via le faux serveur (le crash du tour ne joue que pendant `turn/start`, jamais la poignée de main).
  await c!.t.d.agents.stop(agent.id, 'user');
  c!.t.db.prepare('UPDATE agents SET session_id = NULL WHERE id = ?').run(agent.id);
  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(() => row(agent.id).status === 'idle', 5000, 'fin du tour (sans session)');
  expect(row(agent.id).session_id).toBe('thread-new-fixed');

  // un id semé, distinct de celui que `thread/start` renverrait : s'il ressort inchangé, c'est que
  // `thread/resume` l'a restitué tel quel (le faux serveur échoue systématiquement le paramètre reçu).
  await c!.t.d.agents.stop(agent.id, 'user');
  c!.t.db
    .prepare("UPDATE agents SET session_id = 'thread-seeded-sentinel' WHERE id = ?")
    .run(agent.id);
  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(() => row(agent.id).status === 'idle', 5000, 'fin du tour (avec session)');
  expect(row(agent.id).session_id).toBe('thread-seeded-sentinel');
});

test('reprise (A.6) : sujet archivé → 409 au message clair, rien relancé', async () => {
  const { agent, topic } = await spawnStream('claude');
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');
  await c!.t.d.agents.stop(agent.id, 'user');

  c!.t.store.append({
    source: 'daemon',
    type: 'topic.state',
    topicId: topic.topicId,
    data: { state: 'archived' },
  });

  expect(() => c!.t.d.agents.input(agent.id, 'bonjour')).toThrow('le sujet est archivé');
  expect(c!.t.d.agents.getStream(agent.id)).toBeUndefined();
});

test('reprise (A.6) : gracefulInterrupt ignore les agents stream vivants — aucun résumé demandé, manifeste sans eux', async () => {
  const { agent } = await spawnStream('claude');
  await waitFor(() => row(agent.id).session_id === agent.sessionId, 5000, 'session claude');
  const avant = messages(agent.id, 'message').length;

  const entries = await gracefulInterrupt(c!.t.d.agents, 500);

  expect(entries).toEqual([]);
  expect(messages(agent.id, 'message')).toHaveLength(avant);
  expect(c!.t.d.agents.getStream(agent.id)?.exited).toBe(false);
});
