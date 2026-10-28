import { delimiter, join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, expect, test } from 'vitest';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

const STREAM_BIN = join(import.meta.dirname, 'fixtures/bin-stream');
const PTY_BIN = join(import.meta.dirname, 'fixtures/bin');
const saved = { PATH: process.env.PATH };
let c: Ctx | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  process.env.PATH = saved.PATH;
  await c?.t.d.stop();
  c = undefined;
});

type Msg = { t: string; [k: string]: unknown };
type SpawnedAgent = { id: string; sessionId: string | null };

class Client {
  readonly texts: Msg[] = [];
  closeCode: number | null = null;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => this.texts.push(JSON.parse(String(data))));
    ws.on('close', (code) => (this.closeCode = code));
  }

  static async open(
    agentId: string,
    opts: { after?: number; headers?: Record<string, string> } = {},
  ): Promise<Client> {
    const port = c!.t.d.port;
    const qs = opts.after !== undefined ? `?after=${opts.after}` : '';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent/${agentId}${qs}`, {
      headers: opts.headers ?? {
        origin: `http://127.0.0.1:${port}`,
        cookie: `aid_session=${c!.t.d.auth.sessionToken}`,
      },
    });
    sockets.push(ws);
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('unexpected-response', (_r, res) =>
        reject(Object.assign(new Error('refusé'), { status: res.statusCode })),
      );
      ws.once('error', reject);
    });
    return client;
  }

  find = (t: string) => this.texts.filter((m) => m.t === t);
  last = (t: string) => this.find(t).at(-1);
  hello = () => waitFor(() => this.find('hello')[0], 3000, 'hello');
}

async function spawnStream(kind: 'claude' | 'codex' = 'claude'): Promise<SpawnedAgent> {
  process.env.PATH = `${STREAM_BIN}${delimiter}${saved.PATH}`;
  c = await setupWorkspace({ config: { agents: { transport: 'stream' } } });
  const topic = await makeTopic(c);
  return c.t.d.agents.spawn({ topicId: topic.topicId, kind });
}

async function spawnPty(): Promise<SpawnedAgent> {
  process.env.PATH = `${PTY_BIN}${delimiter}${saved.PATH}`;
  // D63/A.6 : le défaut est passé à `stream` ; ce test vise justement le 409 sur un agent PTY.
  c = await setupWorkspace({ config: { agents: { transport: 'pty' } } });
  const topic = await makeTopic(c);
  return c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'claude' });
}

function rowStatus(agentId: string): string {
  return (
    c!.t.db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string }
  ).status;
}

function sessionSet(agent: SpawnedAgent): boolean {
  const row = c!.t.db.prepare('SELECT session_id FROM agents WHERE id = ?').get(agent.id) as {
    session_id: string | null;
  };
  return row.session_id === agent.sessionId;
}

function subscriberCount(agentId: string): number {
  const agents = c!.t.d.agents as unknown as { streamSubscribers: Map<string, Set<unknown>> };
  return agents.streamSubscribers.get(agentId)?.size ?? 0;
}

test('agent inconnu : 404', async () => {
  await spawnStream();
  await expect(Client.open('ag_nexiste_pas')).rejects.toMatchObject({ status: 404 });
});

test('agent PTY : 409 (canal réservé aux agents conversationnels)', async () => {
  const agent = await spawnPty();
  await expect(Client.open(agent.id)).rejects.toMatchObject({ status: 409 });
});

test('sans cookie ou avec une origine étrangère : refusé', async () => {
  const agent = await spawnStream();
  await expect(
    Client.open(agent.id, { headers: { origin: `http://127.0.0.1:${c!.t.d.port}` } }),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    Client.open(agent.id, {
      headers: { origin: 'http://evil.com', cookie: `aid_session=${c!.t.d.auth.sessionToken}` },
    }),
  ).rejects.toMatchObject({ status: 403 });
});

test('hello puis historique, puis flux direct : seq strictement croissants, sans doublon', async () => {
  const agent = await spawnStream('claude');
  const client = await Client.open(agent.id);
  await client.hello();
  await waitFor(() => client.find('history').length > 0, 3000, 'history');
  await waitFor(() => sessionSet(agent), 5000, 'session');

  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(
    () => client.find('event').some((e) => (e.event as { role?: string }).role === 'assistant'),
    5000,
    'assistant',
  );

  const historyItems = (client.last('history') as unknown as { items: Array<{ seq: number }> })
    .items;
  const directSeqs = client.find('event').map((e) => e.seq as number);
  const seqs = [...historyItems.map((i) => i.seq), ...directSeqs];
  for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  expect(new Set(seqs).size).toBe(seqs.length);

  const directEvents = client.find('event').map((e) => e.event as { role?: string; text?: string });
  expect(directEvents.some((e) => e.role === 'user' && e.text === 'bonjour')).toBe(true);
  expect(directEvents.some((e) => e.role === 'assistant')).toBe(true);
});

test('reconnexion avec after = dernier seq : aucun doublon, message envoyé pendant la déconnexion rattrapé par history', async () => {
  const agent = await spawnStream('claude');
  await waitFor(() => sessionSet(agent), 5000, 'session');
  const a = await Client.open(agent.id);
  await a.hello();
  await waitFor(() => a.find('history').length > 0, 3000, 'history1');
  const items0 = (a.last('history') as unknown as { items: Array<{ seq: number }> }).items;
  const afterInit = items0.reduce((max, i) => Math.max(max, i.seq), 0);
  a.ws.close();
  await waitFor(() => a.closeCode !== null, 3000, 'fermeture');

  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(() => rowStatus(agent.id) === 'idle', 5000, 'idle');

  const b = await Client.open(agent.id, { after: afterInit });
  await waitFor(() => b.find('history').length > 0, 3000, 'history2');
  const items = (
    b.last('history') as unknown as {
      items: Array<{ seq: number; event: { role?: string; text?: string } }>;
    }
  ).items;
  expect(items.some((i) => i.event.role === 'user' && i.event.text === 'bonjour')).toBe(true);
  expect(items.some((i) => i.event.role === 'assistant')).toBe(true);
  const seqs = items.map((i) => i.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs.every((s) => s > afterInit)).toBe(true);
  expect(b.find('event')).toHaveLength(0);
});

test('deux clients simultanés reçoivent les mêmes seq', async () => {
  const agent = await spawnStream('claude');
  await waitFor(() => sessionSet(agent), 5000, 'session');
  const a = await Client.open(agent.id);
  await a.hello();
  const b = await Client.open(agent.id);
  await b.hello();

  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(
    () => a.find('event').some((e) => (e.event as { role?: string }).role === 'assistant'),
    5000,
    'a assistant',
  );
  await waitFor(
    () => b.find('event').some((e) => (e.event as { role?: string }).role === 'assistant'),
    5000,
    'b assistant',
  );
  expect(a.find('event').map((e) => e.seq)).toEqual(b.find('event').map((e) => e.seq));
});

test('stop() : event exit direct, puis message exit normalisé reason user', async () => {
  const agent = await spawnStream('claude');
  await waitFor(() => sessionSet(agent), 5000, 'session');
  const client = await Client.open(agent.id);
  await client.hello();

  await c!.t.d.agents.stop(agent.id, 'user');
  await waitFor(() => client.last('exit'), 3000, 'exit');
  expect(client.find('event').some((e) => (e.event as { type?: string }).type === 'exit')).toBe(
    true,
  );
  expect(client.last('exit')).toMatchObject({ reason: 'user' });
  await waitFor(() => client.closeCode !== null, 3000, 'fermeture');
  expect(client.closeCode).toBe(1000);
});

test('connexion après la fin de l’agent : hello exited, history complet, exit, aucun direct', async () => {
  const agent = await spawnStream('claude');
  await waitFor(() => sessionSet(agent), 5000, 'session');
  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(() => rowStatus(agent.id) === 'idle', 5000, 'idle');
  await c!.t.d.agents.stop(agent.id, 'user');

  const total = (
    c!.t.db
      .prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE agent_id = ?')
      .get(agent.id) as {
      n: number;
    }
  ).n;

  const client = await Client.open(agent.id);
  expect(await client.hello()).toMatchObject({ exited: true });
  await waitFor(() => client.find('history').length > 0, 3000, 'history');
  expect((client.last('history') as unknown as { items: unknown[] }).items).toHaveLength(total);
  await waitFor(() => client.last('exit'), 3000, 'exit');
  expect(client.find('event')).toHaveLength(0);
  await waitFor(() => client.closeCode !== null, 3000, 'fermeture');
  expect(client.closeCode).toBe(1000);
});

test('truncated : au-delà de 2000 lignes, seules les 2000 dernières sont rendues', async () => {
  const agent = await spawnStream('claude');
  await waitFor(() => sessionSet(agent), 5000, 'session');
  await c!.t.d.agents.stop(agent.id, 'user');

  c!.t.db.prepare('DELETE FROM agent_messages WHERE agent_id = ?').run(agent.id);
  const insert = c!.t.db.prepare(
    'INSERT INTO agent_messages (agent_id, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?)',
  );
  for (let i = 1; i <= 2005; i++) {
    insert.run(
      agent.id,
      i,
      'message',
      JSON.stringify({ type: 'message', role: 'assistant', text: `m${i}` }),
      't0',
    );
  }

  const client = await Client.open(agent.id);
  await waitFor(() => client.find('history').length > 0, 3000, 'history');
  const history = client.last('history') as unknown as {
    items: Array<{ seq: number }>;
    truncated: boolean;
  };
  expect(history.truncated).toBe(true);
  expect(history.items).toHaveLength(2000);
  expect(history.items[0]!.seq).toBe(6);
  expect(history.items.at(-1)!.seq).toBe(2005);
});

test('truncated par taille : seules les lignes les plus récentes qui tiennent sous 4 Mo sont rendues', async () => {
  const agent = await spawnStream('claude');
  await waitFor(() => sessionSet(agent), 5000, 'session');
  await c!.t.d.agents.stop(agent.id, 'user');

  c!.t.db.prepare('DELETE FROM agent_messages WHERE agent_id = ?').run(agent.id);
  const insert = c!.t.db.prepare(
    'INSERT INTO agent_messages (agent_id, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?)',
  );
  const big = JSON.stringify({ type: 'message', role: 'assistant', text: 'x'.repeat(1_500_000) });
  for (let i = 1; i <= 3; i++) insert.run(agent.id, i, 'message', big, 't0');

  const client = await Client.open(agent.id);
  await waitFor(() => client.find('history').length > 0, 3000, 'history');
  const history = client.last('history') as unknown as {
    items: Array<{ seq: number }>;
    truncated: boolean;
  };
  expect(history.truncated).toBe(true);
  expect(history.items.map((i) => i.seq)).toEqual([2, 3]);
});

test('ligne de payload corrompue : ignorée, hello/history/exit restent fonctionnels', async () => {
  const agent = await spawnStream('claude');
  await waitFor(() => sessionSet(agent), 5000, 'session');
  await c!.t.d.agents.stop(agent.id, 'user');

  c!.t.db
    .prepare(
      "INSERT INTO agent_messages (agent_id, seq, kind, payload, at) VALUES (?, 999999, 'message', ?, ?)",
    )
    .run(agent.id, '{not json', 't0');

  const client = await Client.open(agent.id);
  expect(await client.hello()).toMatchObject({ exited: true });
  await waitFor(() => client.find('history').length > 0, 3000, 'history');
  const history = client.last('history') as unknown as { items: Array<{ seq: number }> };
  expect(history.items.some((i) => i.seq === 999999)).toBe(false);
  await waitFor(() => client.last('exit'), 3000, 'exit');
});

test('après fermeture du socket, plus aucun abonné pour cet agent', async () => {
  const agent = await spawnStream('claude');
  await waitFor(() => sessionSet(agent), 5000, 'session');
  const client = await Client.open(agent.id);
  await client.hello();
  await waitFor(() => subscriberCount(agent.id) === 1, 3000, 'abonné');
  client.ws.close();
  await waitFor(() => subscriberCount(agent.id) === 0, 3000, 'désabonné');
});
