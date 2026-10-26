import { delimiter, join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, expect, test } from 'vitest';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

const STREAM_BIN = join(import.meta.dirname, 'fixtures/bin-stream');
const saved = { PATH: process.env.PATH };
let c: Ctx | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  process.env.PATH = saved.PATH;
  await c?.t.d.stop();
  c = undefined;
});

async function spawnStream(kind: 'claude' | 'codex' = 'claude') {
  process.env.PATH = `${STREAM_BIN}${delimiter}${saved.PATH}`;
  c = await setupWorkspace({ config: { agents: { transport: 'stream' } } });
  const topic = await makeTopic(c);
  return c.t.d.agents.spawn({ topicId: topic.topicId, kind });
}

function sessionSet(agentId: string): boolean {
  const row = c!.t.db.prepare('SELECT session_id FROM agents WHERE id = ?').get(agentId) as {
    session_id: string | null;
  };
  return row.session_id !== null;
}

function lastUserSeq(agentId: string): number {
  const row = c!.t.db
    .prepare(
      "SELECT seq FROM agent_messages WHERE agent_id = ? AND kind = 'message' AND json_extract(payload, '$.role') = 'user' ORDER BY seq DESC LIMIT 1",
    )
    .get(agentId) as { seq: number };
  return row.seq;
}

function markedOf(agentId: string, seq: number): number {
  const row = c!.t.db
    .prepare('SELECT marked FROM agent_messages WHERE agent_id = ? AND seq = ?')
    .get(agentId, seq) as { marked: number };
  return row.marked;
}

const mark = (agentId: string, seq: number, marked: boolean) =>
  c!.t.d.app.inject({
    method: 'PUT',
    url: `/api/agents/${agentId}/messages/${seq}/mark`,
    headers: c!.t.headers,
    payload: { marked },
  });

test('marquer puis démarquer un message utilisateur : 200, colonne à 1 puis 0', async () => {
  const agent = await spawnStream();
  await waitFor(() => sessionSet(agent.id), 5000, 'session');
  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(() => lastUserSeq(agent.id) > 0, 3000, 'message');
  const seq = lastUserSeq(agent.id);

  const r1 = await mark(agent.id, seq, true);
  expect(r1.statusCode).toBe(200);
  expect(r1.json()).toEqual({ seq, marked: true });
  expect(markedOf(agent.id, seq)).toBe(1);

  const r2 = await mark(agent.id, seq, false);
  expect(r2.statusCode).toBe(200);
  expect(r2.json()).toEqual({ seq, marked: false });
  expect(markedOf(agent.id, seq)).toBe(0);
});

test('ligne qui n’est pas un message utilisateur : 422', async () => {
  const agent = await spawnStream();
  await waitFor(() => sessionSet(agent.id), 5000, 'session');
  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(
    () =>
      (
        c!.t.db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_messages WHERE agent_id = ? AND kind = 'message' AND json_extract(payload, '$.role') = 'assistant'",
          )
          .get(agent.id) as { n: number }
      ).n > 0,
    5000,
    'réponse',
  );
  const assistantRow = c!.t.db
    .prepare(
      "SELECT seq FROM agent_messages WHERE agent_id = ? AND kind = 'message' AND json_extract(payload, '$.role') = 'assistant' LIMIT 1",
    )
    .get(agent.id) as { seq: number };
  const r = await mark(agent.id, assistantRow.seq, true);
  expect(r.statusCode).toBe(422);
});

test('agent inconnu : 404 ; seq inconnu : 404 ; corps invalide : 400', async () => {
  const agent = await spawnStream();
  await waitFor(() => sessionSet(agent.id), 5000, 'session');
  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(() => lastUserSeq(agent.id) > 0, 3000, 'message');
  const seq = lastUserSeq(agent.id);

  expect((await mark('ag_nope', seq, true)).statusCode).toBe(404);
  expect((await mark(agent.id, 999999, true)).statusCode).toBe(404);
  const bad = await c!.t.d.app.inject({
    method: 'PUT',
    url: `/api/agents/${agent.id}/messages/${seq}/mark`,
    headers: c!.t.headers,
    payload: { marked: 'oui' },
  });
  expect(bad.statusCode).toBe(400);
});

test('seq non entier ou négatif dans l’URL : 400 avant toute requête', async () => {
  const agent = await spawnStream();
  await waitFor(() => sessionSet(agent.id), 5000, 'session');
  for (const seqParam of ['abc', '0', '1.5']) {
    const r = await c!.t.d.app.inject({
      method: 'PUT',
      url: `/api/agents/${agent.id}/messages/${seqParam}/mark`,
      headers: c!.t.headers,
      payload: { marked: true },
    });
    expect(r.statusCode).toBe(400);
  }
});

test('ligne dont le payload n’est pas du JSON valide : 422, pas 500', async () => {
  const agent = await spawnStream();
  await waitFor(() => sessionSet(agent.id), 5000, 'session');
  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(() => lastUserSeq(agent.id) > 0, 3000, 'message');
  const seq = lastUserSeq(agent.id);
  c!.t.db
    .prepare("UPDATE agent_messages SET payload = 'pas du json' WHERE agent_id = ? AND seq = ?")
    .run(agent.id, seq);

  const r = await mark(agent.id, seq, true);
  expect(r.statusCode).toBe(422);
});

test('/ws/agent : l’historique porte marked:true sur l’item marqué, absent sur les autres', async () => {
  const agent = await spawnStream();
  await waitFor(() => sessionSet(agent.id), 5000, 'session');
  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(() => lastUserSeq(agent.id) > 0, 3000, 'message');
  const seq = lastUserSeq(agent.id);
  expect((await mark(agent.id, seq, true)).statusCode).toBe(200);

  const port = c!.t.d.port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent/${agent.id}`, {
    headers: {
      origin: `http://127.0.0.1:${port}`,
      cookie: `aid_session=${c!.t.d.auth.sessionToken}`,
    },
  });
  sockets.push(ws);
  const messages: Array<{ t: string; [k: string]: unknown }> = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  await waitFor(() => messages.some((m) => m.t === 'history'), 3000, 'history');
  const history = messages.find((m) => m.t === 'history') as unknown as {
    items: Array<{ seq: number; marked?: boolean }>;
  };
  const marked = history.items.find((i) => i.seq === seq);
  expect(marked?.marked).toBe(true);
  for (const i of history.items) if (i.seq !== seq) expect(i.marked).toBeUndefined();
});
