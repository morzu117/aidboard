import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, expect, test } from 'vitest';
import { waitFor } from './helpers/daemon.js';
import { Replica } from './helpers/replica.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

const FAKE_AGENT = join(import.meta.dirname, 'fixtures/fake-agent.sh');
const saved = process.env.SHELL;
let c: Ctx;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  process.env.SHELL = saved;
  await c?.t.d.stop();
});

type Msg = { t: string; [k: string]: unknown };

class Client {
  readonly texts: Msg[] = [];
  readonly replica = new Replica();
  closeCode: number | null = null;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) this.replica.feed(data as Buffer);
      else this.texts.push(JSON.parse(String(data)));
    });
    ws.on('close', (code) => (this.closeCode = code));
  }

  static async open(agentId: string, headers?: Record<string, string>): Promise<Client> {
    const port = c.t.d.port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty/${agentId}`, {
      headers: headers ?? {
        origin: `http://127.0.0.1:${port}`,
        cookie: `aid_session=${c.t.d.auth.sessionToken}`,
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

  send = (m: object) => this.ws.send(JSON.stringify(m));
  find = (t: string) => this.texts.filter((m) => m.t === t);
  last = (t: string) => this.find(t).at(-1);
  hello = () => waitFor(() => this.find('hello')[0], 3000, 'hello');
  seen = async (needle: string, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await this.replica.flush();
      if (this.replica.text().includes(needle)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
}

async function start(shell: string) {
  process.env.SHELL = shell;
  c = await setupWorkspace();
  const { topicId } = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId, kind: 'shell' });
  return { agent, live: c.t.d.agents.get(agent.id)! };
}

const never = (client: Client, needle: string, ms = 400) =>
  new Promise<boolean>((r) =>
    setTimeout(
      async () => (await client.replica.flush(), r(!client.replica.text().includes(needle))),
      ms,
    ),
  );

test('hello : le premier client est propriétaire, avec la taille, le statut et le mode de rejeu', async () => {
  const { agent } = await start('/bin/sh');
  const a = await Client.open(agent.id);
  expect(await a.hello()).toMatchObject({
    cols: 120,
    rows: 32,
    owner: true,
    status: 'starting',
    replay: 'live',
  });
});

test('la saisie du propriétaire atteint le PTY et la sortie revient', async () => {
  const { agent } = await start('/bin/sh');
  const a = await Client.open(agent.id);
  a.send({ t: 'in', d: 'echo "RE""PONSE"\n' });
  expect(await a.seen('REPONSE')).toBe(true);
});

test('deux clients : seul le propriétaire écrit ; après claim, la propriété et la taille passent', async () => {
  const { agent } = await start('/bin/sh');
  const a = await Client.open(agent.id);
  await a.hello();
  const b = await Client.open(agent.id);
  expect((await b.hello()).owner).toBe(false);

  b.send({ t: 'in', d: 'echo "DE-""B"\n' });
  expect(await never(b, 'DE-B')).toBe(true);
  expect(await never(a, 'DE-B', 100)).toBe(true);

  b.send({ t: 'claim' });
  await waitFor(() => b.last('owner'), 3000, 'owner pour B');
  expect(b.last('owner')).toMatchObject({ owner: true });
  await waitFor(() => a.last('owner'), 3000, 'owner pour A');
  expect(a.last('owner')).toMatchObject({ owner: false });
  expect(a.last('size')).toMatchObject({ cols: 120, rows: 32 });

  b.send({ t: 'in', d: 'echo "DE2-""B"\n' });
  expect(await a.seen('DE2-B')).toBe(true);
  expect(await b.seen('DE2-B')).toBe(true);

  a.send({ t: 'in', d: 'echo "DE-""A"\n' });
  expect(await never(b, 'DE-A')).toBe(true);
});

test('resize du propriétaire : le PTY et l’autre client suivent ; non propriétaire et tailles absurdes ignorés', async () => {
  const { agent, live } = await start('/bin/sh');
  const a = await Client.open(agent.id);
  await a.hello();
  const b = await Client.open(agent.id);
  await b.hello();

  b.send({ t: 'resize', cols: 50, rows: 10 });
  await new Promise((r) => setTimeout(r, 200));
  expect(live.size).toEqual({ cols: 120, rows: 32 });

  a.send({ t: 'resize', cols: 100, rows: 40 });
  await waitFor(() => b.last('size'), 3000, 'size pour B');
  expect(b.last('size')).toMatchObject({ cols: 100, rows: 40 });
  expect(live.size).toEqual({ cols: 100, rows: 40 });

  for (const bad of [
    { cols: 0, rows: 0 },
    { cols: 1, rows: 40 },
    { cols: 9999, rows: 40 },
  ])
    a.send({ t: 'resize', ...bad });
  await new Promise((r) => setTimeout(r, 200));
  expect(live.size).toEqual({ cols: 100, rows: 40 });
});

test('le propriétaire qui part passe la main au client le plus récent', async () => {
  const { agent } = await start('/bin/sh');
  const a = await Client.open(agent.id);
  await a.hello();
  const b = await Client.open(agent.id);
  await b.hello();
  const d = await Client.open(agent.id);
  await d.hello();
  a.ws.close();
  await waitFor(() => d.last('owner'), 3000, 'nouveau propriétaire');
  expect(d.last('owner')).toMatchObject({ owner: true });
  expect(b.last('owner')).toBeUndefined();
});

test('un message invalide ou trop gros est ignoré sans couper la connexion', async () => {
  const { agent } = await start('/bin/sh');
  const a = await Client.open(agent.id);
  await a.hello();
  a.ws.send('pas du json');
  a.ws.send(Buffer.from([1, 2, 3]));
  a.send({ t: 'in', d: 'x'.repeat(70_000) });
  a.send({ t: 'in', d: 42 });
  a.send({ t: 'in', d: 'echo "ENCORE""LA"\n' });
  expect(await a.seen('ENCOREL' + 'A')).toBe(true);
  expect(a.closeCode).toBeNull();
});

test('un client qui ne lit plus est coupé et le PTY continue pour les autres', async () => {
  const { agent, live } = await start('/bin/sh');
  const slow = await Client.open(agent.id);
  await slow.hello();
  slow.ws.pause();
  const other = await Client.open(agent.id);
  await other.hello();
  // 24 Mo : largement au-delà de SLOW_CLIENT_BYTES (4 Mio) plus ce que les tampons TCP du
  // noyau absorbent (jusqu'à ~10 Mo sous Linux), sans parser 60 Mo deux fois par xterm (miroir
  // du daemon et réplique du test) — c'était ce qui dépassait 8 s sous charge.
  slow.send({
    t: 'in',
    d: 'yes xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | head -c 24000000; echo "FIN""FLOT"\n',
  });
  expect(await other.seen('FINFLOT', 20_000)).toBe(true);
  const count = () =>
    (c.t.d.app as unknown as { websocketServer: { clients: Set<unknown> } }).websocketServer.clients
      .size;
  await waitFor(() => count() === 1, 8000, 'le client lent est retiré');
  expect(live.exited).toBe(false);
  slow.ws.terminate();

  const fresh = await Client.open(agent.id);
  await fresh.hello();
  fresh.send({ t: 'claim' });
  fresh.send({ t: 'in', d: 'echo "TOUJOURS""VIVANT"\n' });
  expect(await fresh.seen('TOUJOURSVIVANT')).toBe(true);
  // Ses propres attentes vont jusqu'à 20 s : le budget du test doit les couvrir — sous charge
  // (runner CI, machine occupée) les 5 s par défaut tombaient en timeout.
}, 60_000);

test('la sortie de l’agent est annoncée aux clients connectés et à ceux qui arrivent après', async () => {
  const { agent } = await start(FAKE_AGENT);
  const a = await Client.open(agent.id);
  await a.hello();
  expect(await a.seen('PRÊT')).toBe(true);
  a.send({ t: 'in', d: 'fail\n' });
  await waitFor(() => a.last('exit'), 5000, 'exit');
  expect(a.last('exit')).toMatchObject({ exitCode: 3, reason: 'exit' });

  const late = await Client.open(agent.id);
  await waitFor(() => late.last('exit'), 3000, 'exit tardif');
  expect(late.last('exit')).toMatchObject({ exitCode: 3 });
  late.send({ t: 'in', d: 'ignoré\n' });
});

test('reconnexion : un nouveau client retrouve l’écran plein écran de l’agent', async () => {
  const { agent } = await start(FAKE_AGENT);
  const a = await Client.open(agent.id);
  await a.hello();
  expect(await a.seen('PRÊT')).toBe(true);
  a.send({ t: 'in', d: 'mémoire\n' });
  expect(await a.seen('> mémoire')).toBe(true);
  a.ws.close();
  await waitFor(() => a.closeCode !== null, 3000, 'fermeture');

  const b = await Client.open(agent.id);
  await b.hello();
  expect(await b.seen('> mémoire')).toBe(true);
  expect(b.replica.text()).toContain('|  FAKE AGENT        |');
  expect(b.replica.term.buffer.active.type).toBe('alternate');
});

test('après un redémarrage (plus de miroir en mémoire), l’écran est reconstruit depuis le journal et déclaré approximatif', async () => {
  const { agent, live } = await start('/bin/sh');
  const a = await Client.open(agent.id);
  await a.hello();
  a.send({ t: 'in', d: 'echo "MAR""QUEUR"; exit 0\n' });
  await waitFor(() => live.exited, 5000, 'sortie');
  a.ws.close();
  c.t.d.agents.forget(agent.id);

  const b = await Client.open(agent.id);
  expect(await b.hello()).toMatchObject({ replay: 'log', owner: false, status: 'done' });
  expect(await b.seen('MARQUEUR')).toBe(true);
  await waitFor(() => b.last('exit'), 3000, 'exit');
});

test('agent inconnu : 404 à la poignée de main ; jeton de run : 403', async () => {
  const { agent } = await start('/bin/sh');
  await expect(Client.open('ag_nexiste_pas')).rejects.toMatchObject({ status: 404 });
  const token = c.t.d.auth.runTokens.keys().next().value as string;
  await expect(
    Client.open(agent.id, {
      origin: `http://127.0.0.1:${c.t.d.port}`,
      authorization: `Bearer ${token}`,
    }),
  ).rejects.toMatchObject({ status: 403 });
});

test('sans cookie ou avec une origine étrangère : refusé', async () => {
  const { agent } = await start('/bin/sh');
  await expect(
    Client.open(agent.id, { origin: `http://127.0.0.1:${c.t.d.port}` }),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    Client.open(agent.id, {
      origin: 'http://evil.com',
      cookie: `aid_session=${c.t.d.auth.sessionToken}`,
    }),
  ).rejects.toMatchObject({ status: 403 });
});
