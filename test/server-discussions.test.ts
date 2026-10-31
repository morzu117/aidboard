import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { afterEach, expect, test } from 'vitest';
import type { ServerAgentView, ServerDiscussionView } from '../src/daemon/remote/agents.js';
import type { TransportOptions } from '../src/daemon/remote/transport.js';
import { issueRunToken } from '../src/daemon/security.js';
import type { Server } from '../src/shared/model.js';
import { FAKE_SSH, startTestDaemon, type TestDaemon, waitFor } from './helpers/daemon.js';

/** Chantier 17 (R.4) : discussions sur un serveur, de bout en bout dans le daemon — faux ssh, faux tmux, faux agents (D79). */
const FAKE_TMUX = resolve(__dirname, 'fixtures/fake-tmux.sh');
const BINS = {
  claude: resolve(__dirname, 'fixtures/fake-claude-stream.mjs'),
  codex: resolve(__dirname, 'fixtures/fake-codex-appserver.mjs'),
};

const nettoyages: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const n of nettoyages.splice(0).reverse()) await n();
});

function tuer(fichier: string): void {
  try {
    const pid = parseInt(readFileSync(fichier, 'utf8'), 10);
    if (pid > 1) process.kill(pid, 'SIGKILL');
  } catch {
    // déjà mort, ou jamais lancé
  }
}

function vivant(fichier: string): boolean {
  try {
    const pid = parseInt(readFileSync(fichier, 'utf8'), 10);
    if (!(pid > 1)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Un « serveur » neuf (même montage que remote-driver) : HOME distant temporaire, faux tmux en tête du PATH. */
function serveur(): { home: string; transport: TransportOptions & { env: NodeJS.ProcessEnv } } {
  const home = mkdtempSync(join(tmpdir(), 'aid-rdisc-'));
  const bin = join(home, 'faux-bin');
  mkdirSync(bin);
  symlinkSync(FAKE_TMUX, join(bin, 'tmux'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_SSH_HOME: home,
    FAKE_TMUX_DIR: join(home, 'faux-tmux'),
    PATH: `${bin}:${process.env.PATH}`,
  };
  mkdirSync(env.FAKE_TMUX_DIR!);
  writeFileSync(join(home, '.profile'), `PATH='${bin}':"$PATH"\nexport PATH\n`);
  nettoyages.push(() => {
    for (const f of readdirSync(env.FAKE_TMUX_DIR!)) tuer(join(env.FAKE_TMUX_DIR!, f));
    const agents = join(home, '.aid-remote/agents');
    if (existsSync(agents)) for (const id of readdirSync(agents)) tuer(join(agents, id, 'apid'));
    rmSync(home, { recursive: true, force: true });
  });
  return { home, transport: { ssh: FAKE_SSH, env } };
}

type Reponse = { statusCode: number; json<T>(): T };

interface Monte {
  t: TestDaemon;
  home: string;
  transport: TransportOptions;
  req: (method: string, url: string, payload?: unknown) => Promise<Reponse>;
}

async function daemon(
  remote: { home: string; transport: TransportOptions },
  aidHome?: string,
): Promise<Monte> {
  const t = await startTestDaemon(aidHome, { remote: remote.transport, remoteBins: BINS });
  let arrete = false;
  nettoyages.push(async () => {
    if (!arrete) await t.d.stop();
  });
  const req = (method: string, url: string, payload?: unknown) =>
    t.d.app.inject({ method: method as never, url, headers: t.headers, payload: payload as never });
  const m: Monte = { t, home: remote.home, transport: remote.transport, req };
  // arrêt explicite d'un test (redémarrage) : le nettoyage ne le refait pas
  const stop = t.d.stop.bind(t.d);
  t.d.stop = async () => {
    arrete = true;
    await stop();
  };
  return m;
}

async function creerServeur(
  m: Monte,
  detected: string[] | null = ['claude', 'codex'],
): Promise<Server> {
  const r = await m.req('POST', '/api/servers', {
    name: 'vps-test',
    mode: 'ssh_alias',
    target: 'vps',
  });
  expect(r.statusCode).toBe(201);
  const s = r.json<Server>();
  m.t.db
    .prepare('UPDATE servers SET detected_agents = ? WHERE id = ?')
    .run(detected === null ? null : JSON.stringify(detected), s.id);
  return s;
}

async function creerDiscussion(
  m: Monte,
  serverId: string,
  kind = 'claude',
): Promise<ServerDiscussionView> {
  const r = await m.req('POST', `/api/servers/${serverId}/discussions`, { name: 'Essai', kind });
  expect(r.statusCode).toBe(201);
  return r.json<ServerDiscussionView>();
}

const ligne = (m: Monte, agentId: string) =>
  m.t.db.prepare('SELECT * FROM server_agents WHERE id = ?').get(agentId) as
    | { status: string; out_offset: number; tmux_session: string; session_id: string | null }
    | undefined;

/** Mode d'exécution écrit sur l'agent (décision opérateur du 2026-10-31 : pas d'`auto` pour claude sous confirmation). */
const modeDe = (m: Monte, agentId: string) =>
  (
    m.t.db.prepare('SELECT permission_mode FROM server_agents WHERE id = ?').get(agentId) as
      { permission_mode: string } | undefined
  )?.permission_mode;

function fil(m: Monte, agentId: string): { kind: string; role?: string; text?: string }[] {
  return (
    m.t.db
      .prepare('SELECT payload FROM server_agent_messages WHERE agent_id = ? ORDER BY seq')
      .all(agentId) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as { kind: string });
}

const assistant = (m: Monte, agentId: string, text: string) =>
  fil(m, agentId).filter(
    (e) => (e as { type?: string }).type === 'message' && e.role === 'assistant' && e.text === text,
  ).length;

async function envoyer(m: Monte, agentId: string, text: string): Promise<void> {
  const r = await m.req('POST', `/api/server-agents/${agentId}/input`, { text });
  expect(r.statusCode).toBe(202);
}

const apid = (m: Monte, relayId: string) => join(m.home, '.aid-remote/agents', relayId, 'apid');

test('créer une discussion claude, échanger : fil journalisé, offset avancé, statut idle', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const d = await creerDiscussion(m, s.id);
  expect(d).toMatchObject({ serverId: s.id, name: 'Essai', cwd: s.workdir, archived: false });
  expect(d.agents).toHaveLength(1);
  const a = d.agents[0]!;
  expect(a).toMatchObject({ kind: 'claude', tmuxSession: `aid-${a.id}`, pending: null });

  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => assistant(m, a.id, 'echo: bonjour') === 1, 15_000, 'réponse');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  expect(
    fil(m, a.id)
      .filter((e) => e.role === 'user')
      .map((e) => e.text),
  ).toEqual(['bonjour']);
  expect(ligne(m, a.id)!.out_offset).toBeGreaterThan(0);

  const list = (await m.req('GET', `/api/servers/${s.id}/discussions`)).json<
    ServerDiscussionView[]
  >();
  expect(list.map((x) => x.id)).toEqual([d.id]);
  expect((await m.req('GET', `/api/server-agents/${a.id}`)).json<ServerAgentView>().status).toBe(
    'idle',
  );

  const p = await m.req('PATCH', `/api/servers/${s.id}/discussions/${d.id}`, {
    name: ' Renommée ',
    archived: true,
  });
  expect(p.json<ServerDiscussionView>()).toMatchObject({ name: 'Renommée', archived: true });
});

test('agents proposés : seulement ceux détectés au dernier test, serveur jamais testé refusé', async () => {
  const m = await daemon(serveur());
  const jamais = await creerServeur(m, null);
  const r1 = await m.req('POST', `/api/servers/${jamais.id}/discussions`, {
    name: 'x',
    kind: 'claude',
  });
  expect(r1.statusCode).toBe(409);

  m.t.db.prepare("UPDATE servers SET name = 'autre' WHERE id = ?").run(jamais.id);
  const s = await creerServeur(m, ['claude']);
  const r2 = await m.req('POST', `/api/servers/${s.id}/discussions`, { name: 'x', kind: 'codex' });
  expect(r2.statusCode).toBe(409);
  const r3 = await m.req('POST', `/api/servers/${s.id}/discussions`, { name: 'x', kind: 'shell' });
  expect(r3.statusCode).toBe(422);
  const r4 = await m.req('POST', `/api/servers/${s.id}/discussions`, {
    name: '  ',
    kind: 'claude',
  });
  expect(r4.statusCode).toBe(422);
  expect((await m.req('GET', '/api/servers/srv_inconnu/discussions')).statusCode).toBe(404);
  expect(m.t.db.prepare('SELECT COUNT(*) AS n FROM server_discussions').get()).toEqual({ n: 0 });
});

test('pilotage : demande en attente, saisie refusée tant qu’elle court, réponse, entrées invalides', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;

  await envoyer(m, a.id, 'demande permission');
  // `waitFor` n'attend pas une promesse : on guette la base, puis on lit la vue
  await waitFor(() => ligne(m, a.id)?.status === 'needs_input', 15_000, 'needs_input');
  const view = (await m.req('GET', `/api/server-agents/${a.id}`)).json<ServerAgentView>();
  expect(view.pending).not.toBeNull();

  expect(
    (await m.req('POST', `/api/server-agents/${a.id}/input`, { text: 'encore' })).statusCode,
  ).toBe(409);
  expect(
    (await m.req('POST', `/api/server-agents/${a.id}/answer`, { pendingId: 'autre', answer: 'y' }))
      .statusCode,
  ).toBe(409);
  const option = view.pending!.options[0]!;
  const r = await m.req('POST', `/api/server-agents/${a.id}/answer`, {
    pendingId: view.pending!.id,
    answer: option.answer,
  });
  expect(r.statusCode).toBe(202);
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle après réponse');

  expect(
    (await m.req('POST', `/api/server-agents/${a.id}/input`, { text: '   ' })).statusCode,
  ).toBe(422);
  expect(
    (await m.req('POST', `/api/server-agents/${a.id}/input`, { text: 'a\u0007' })).statusCode,
  ).toBe(422);
  expect(
    (await m.req('POST', '/api/server-agents/sa_inconnu/input', { text: 'x' })).statusCode,
  ).toBe(404);
});

test('redémarrage du daemon : claude rattaché à son offset, ni perte ni doublon ; l’agent a survécu', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id)).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 15_000, 'idle');
  const relay = a.id;
  expect(vivant(apid(m1, relay))).toBe(true);

  await m1.t.d.stop();
  // l'agent tourne toujours sur le serveur (D73)
  expect(vivant(apid(m1, relay))).toBe(true);

  const m2 = await daemon(remote, m1.t.home);
  await envoyer(m2, a.id, 'deux');
  await waitFor(() => assistant(m2, a.id, 'echo: deux') === 1, 15_000, 'réponse après redémarrage');
  await waitFor(() => ligne(m2, a.id)?.status === 'idle', 15_000, 'idle');
  expect(assistant(m2, a.id, 'echo: bonjour')).toBe(1);
  // même relais : rattaché, pas relancé
  expect(ligne(m2, a.id)!.tmux_session).toBe(`aid-${relay}`);
  expect(
    fil(m2, a.id)
      .filter((e) => e.role === 'user')
      .map((e) => e.text),
  ).toEqual(['bonjour', 'deux']);
});

test('redémarrage du daemon : codex en veille, relancé par reprise de session sous un relais neuf', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id, 'codex')).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 15_000, 'idle');
  const thread = ligne(m1, a.id)!.session_id;
  expect(thread).toBeTruthy();
  await m1.t.d.stop();

  const m2 = await daemon(remote, m1.t.home);
  expect(ligne(m2, a.id)!.status).toBe('idle');
  // l'ancien relais est arrêté au mieux, en tâche de fond
  await waitFor(() => !vivant(apid(m2, a.id)), 15_000, 'ancien relais arrêté');

  await envoyer(m2, a.id, 'deux');
  await waitFor(
    () => ligne(m2, a.id)?.status === 'idle' && assistant(m2, a.id, 'echo: deux') >= 1,
    15_000,
    'reprise',
  );
  const apres = ligne(m2, a.id)!;
  expect(apres.tmux_session).not.toBe(`aid-${a.id}`);
  expect(apres.tmux_session.startsWith(`aid-${a.id}-`)).toBe(true);
  expect(apres.session_id).toBe(thread);
});

test('supprimer une discussion arrête son agent sur le serveur', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const d = await creerDiscussion(m, s.id);
  const a = d.agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  expect(vivant(apid(m, a.id))).toBe(true);

  const r = await m.req('DELETE', `/api/servers/${s.id}/discussions/${d.id}`);
  expect(r.statusCode).toBe(204);
  await waitFor(() => !vivant(apid(m, a.id)), 15_000, 'agent arrêté');
  expect(ligne(m, a.id)).toBeUndefined();
  expect(m.t.db.prepare('SELECT COUNT(*) AS n FROM server_agent_messages').get()).toEqual({ n: 0 });
});

test('supprimer le serveur arrête d’abord ses agents, puis la cascade efface tout', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  const b = (await creerDiscussion(m, s.id, 'codex')).agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await envoyer(m, b.id, 'bonjour');
  await waitFor(
    () => ligne(m, a.id)?.status === 'idle' && ligne(m, b.id)?.status === 'idle',
    15_000,
    'idle',
  );
  expect(vivant(apid(m, a.id)) && vivant(apid(m, b.id))).toBe(true);

  const r = await m.req('DELETE', `/api/servers/${s.id}`);
  expect(r.statusCode).toBe(204);
  expect(vivant(apid(m, a.id))).toBe(false);
  expect(vivant(apid(m, b.id))).toBe(false);
  expect(m.t.db.prepare('SELECT COUNT(*) AS n FROM server_discussions').get()).toEqual({ n: 0 });
  expect(m.t.db.prepare('SELECT COUNT(*) AS n FROM server_agents').get()).toEqual({ n: 0 });
});

test('relance d’un agent en veille : serveur injoignable → 502, l’ancien relais reste la référence', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id, 'codex')).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 15_000, 'idle');
  await m1.t.d.stop();

  const m2 = await daemon(remote, m1.t.home);
  remote.transport.env.FAKE_SSH_FAIL = '1';
  const r = await m2.req('POST', `/api/server-agents/${a.id}/input`, { text: 'deux' });
  expect(r.statusCode).toBe(502);
  expect(ligne(m2, a.id)!.tmux_session).toBe(`aid-${a.id}`);
  expect(
    fil(m2, a.id)
      .filter((e) => e.role === 'user')
      .map((e) => e.text),
  ).toEqual(['bonjour']);

  delete remote.transport.env.FAKE_SSH_FAIL;
  await envoyer(m2, a.id, 'deux');
  await waitFor(() => assistant(m2, a.id, 'echo: deux') >= 1, 15_000, 'reprise');
});

test('supprimer une discussion dont le pilote est sorti en erreur arrête quand même l’agent distant', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const d = await creerDiscussion(m1, s.id);
  const a = d.agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 15_000, 'idle');
  // pilote sorti en erreur faute de lien : statut fini, agent toujours vivant sur le serveur
  m1.t.db.prepare("UPDATE server_agents SET status = 'error' WHERE id = ?").run(a.id);
  await m1.t.d.stop();

  const m2 = await daemon(remote, m1.t.home);
  expect(vivant(apid(m2, a.id))).toBe(true);
  expect((await m2.req('DELETE', `/api/servers/${s.id}/discussions/${d.id}`)).statusCode).toBe(204);
  expect(vivant(apid(m2, a.id))).toBe(false);
});

test('redémarrage pendant une demande : plus de demande fantôme, le tour est interrompu', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id)).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 15_000, 'idle');
  await envoyer(m1, a.id, 'demande permission');
  await waitFor(() => ligne(m1, a.id)?.status === 'needs_input', 15_000, 'needs_input');
  await m1.t.d.stop();

  const m2 = await daemon(remote, m1.t.home);
  expect(ligne(m2, a.id)!.status).toBe('working');
  expect(
    (await m2.req('GET', `/api/server-agents/${a.id}`)).json<ServerAgentView>().pending,
  ).toBeNull();
  expect((await m2.req('POST', `/api/server-agents/${a.id}/interrupt`)).statusCode).toBe(202);
});

test('répertoire de la discussion : chemin absolu ou sous ~, sans caractère de contrôle', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  for (const cwd of ['relatif', '-rf', '/a\rb', '/a\u0000b'])
    expect(
      (await m.req('POST', `/api/servers/${s.id}/discussions`, { name: 'x', kind: 'claude', cwd }))
        .statusCode,
      JSON.stringify(cwd),
    ).toBe(422);
});

test('réservé à l’administrateur : un token de run est refusé sur les discussions et leurs agents', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  const headers = { ...m.t.headers, authorization: `Bearer ${issueRunToken(m.t.d.auth, 'run_1')}` };
  for (const [method, url] of [
    ['GET', `/api/servers/${s.id}/discussions`],
    ['POST', `/api/servers/${s.id}/discussions`],
    ['GET', `/api/server-agents/${a.id}`],
    ['POST', `/api/server-agents/${a.id}/input`],
    ['POST', `/api/server-agents/${a.id}/interrupt`],
    ['GET', `/ws/server-agent/${a.id}`],
  ] as const)
    expect((await m.t.d.app.inject({ method, url, headers })).statusCode, url).toBe(403);
});

// ---- canal WS

class Client {
  texts: Record<string, unknown>[] = [];
  closeCode: number | null = null;
  private constructor(readonly ws: WebSocket) {}

  static open(m: Monte, agentId: string, after?: number): Promise<Client> {
    const port = m.t.d.port;
    const q = after === undefined ? '' : `?after=${after}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/server-agent/${agentId}${q}`, {
      headers: {
        origin: `http://127.0.0.1:${port}`,
        cookie: `aid_session=${m.t.d.auth.sessionToken}`,
      },
    });
    const client = new Client(ws);
    ws.on('message', (data) =>
      client.texts.push(JSON.parse(String(data)) as Record<string, unknown>),
    );
    ws.on('close', (code) => (client.closeCode = code));
    nettoyages.push(() => ws.close());
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(client));
      ws.once('unexpected-response', (_req, res) => reject({ status: res.statusCode }));
      ws.once('error', reject);
    });
  }

  find = (t: string) => this.texts.filter((m) => m.t === t);
}

test('/ws/server-agent : 404 sur un agent inconnu ; historique, puis événements en direct', async () => {
  const m = await daemon(serveur());
  await expect(Client.open(m, 'sa_inconnu')).rejects.toMatchObject({ status: 404 });
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');

  const c = await Client.open(m, a.id);
  await waitFor(() => c.find('history').length > 0, 5_000, 'history');
  expect(c.find('hello')[0]).toMatchObject({ status: 'idle', exited: false });
  const items = (
    c.find('history')[0] as { items: { seq: number; event: { role?: string; text?: string } }[] }
  ).items;
  expect(items.some((i) => i.event.role === 'user' && i.event.text === 'bonjour')).toBe(true);
  expect(items.some((i) => i.event.role === 'assistant' && i.event.text === 'echo: bonjour')).toBe(
    true,
  );
  const last = Math.max(...items.map((i) => i.seq));

  await envoyer(m, a.id, 'deux');
  await waitFor(
    () =>
      c
        .find('event')
        .some((e) => (e.event as { role?: string; text?: string }).text === 'echo: deux'),
    15_000,
    'événement en direct',
  );
  const evs = c.find('event') as {
    seq: number;
    event: { type: string; role?: string; text?: string };
  }[];
  // le message de l'opérateur passe aussi par le canal, comme pour un agent de sujet
  expect(evs.some((e) => e.event.role === 'user' && e.event.text === 'deux')).toBe(true);
  const seqs = evs.filter((e) => e.event.type !== 'thinking').map((e) => e.seq);
  expect(seqs.every((x) => x > last)).toBe(true);
  expect(new Set(seqs).size).toBe(seqs.length);
  const enBase = (
    m.t.db
      .prepare('SELECT seq FROM server_agent_messages WHERE agent_id = ? AND seq > ? ORDER BY seq')
      .all(a.id, last) as { seq: number }[]
  ).map((r) => r.seq);
  expect(seqs).toEqual(enBase);
});

test('/ws/server-agent : codex en veille après un redémarrage — même réponse qu’un agent de sujet en veille', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id, 'codex')).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 15_000, 'idle');
  await m1.t.d.stop();

  const m2 = await daemon(remote, m1.t.home);
  const c = await Client.open(m2, a.id);
  await waitFor(() => c.closeCode !== null, 5_000, 'fermeture');
  expect(c.find('hello')[0]).toMatchObject({ status: 'idle', exited: true });
  expect(c.find('history')).toHaveLength(1);
  expect(c.find('exit')[0]).toMatchObject({ reason: 'daemon_restart' });
});

// ---- R.5 (D77) : confirmations des commandes destructives

async function reglerServeur(m: Monte, id: string, patch: Partial<Server>): Promise<void> {
  const r = await m.req('PATCH', `/api/servers/${id}`, patch);
  expect(r.statusCode).toBe(200);
}

/** Envoie une commande au faux agent, attend la carte : la vue de l'agent avec sa demande en cours. */
async function carte(m: Monte, agentId: string, command: string): Promise<ServerAgentView> {
  await envoyer(m, agentId, `commande: ${command}`);
  await waitFor(() => ligne(m, agentId)?.status === 'needs_input', 15_000, `carte ${command}`);
  const view = (await m.req('GET', `/api/server-agents/${agentId}`)).json<ServerAgentView>();
  expect(view.pending).not.toBeNull();
  return view;
}

async function repondre(m: Monte, view: ServerAgentView, answer: string): Promise<void> {
  const r = await m.req('POST', `/api/server-agents/${view.id}/answer`, {
    pendingId: view.pending!.id,
    answer,
  });
  expect(r.statusCode).toBe(202);
}

const evenements = (m: Monte, agentId: string, type: string) =>
  fil(m, agentId).filter((e) => (e as { type?: string }).type === type) as unknown as Record<
    string,
    unknown
  >[];

const CONFIRMATION = ['Autoriser', 'Refuser', 'Toujours autoriser sur ce serveur'];

test('claude sous confirmation : le destructif demande confirmation, « Toujours autoriser » écrit une règle du serveur', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  await reglerServeur(m, s.id, { permissionMode: 'auto' });
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  // décision opérateur du 2026-10-31 : sous confirmation, claude n'est jamais en `auto` — ramené à `default`
  expect(modeDe(m, a.id)).toBe('default');

  // non destructif : une carte ordinaire, pas une confirmation
  const v0 = await carte(m, a.id, 'ls -la');
  expect(v0.pending!.confirm).toBeUndefined();
  await repondre(m, v0, 'yes');
  await waitFor(() => assistant(m, a.id, 'exécutée: ls -la') === 1, 15_000, 'ls');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');

  // commande composée : la règle `ask` passée en `--settings` la rattrape, la carte porte la commande
  const v1 = await carte(m, a.id, 'echo debut && rm -f x');
  expect(v1.pending).toMatchObject({
    command: 'echo debut && rm -f x',
    byRule: true,
    confirm: { server: 'vps-test' },
  });
  expect(v1.pending!.options.map((o) => o.label)).toEqual(CONFIRMATION);
  await repondre(m, v1, 'no');
  await waitFor(() => assistant(m, a.id, 'refusée: echo debut && rm -f x') === 1, 15_000, 'refus');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');

  const v2 = await carte(m, a.id, 'sudo -n true');
  await repondre(m, v2, 'always');
  await waitFor(() => assistant(m, a.id, 'exécutée: sudo -n true') === 1, 15_000, 'toujours');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  const regles = (await m.req('GET', `/api/servers/${s.id}`)).json<Server>().rules;
  expect(regles.map((r) => r.pattern)).toEqual(['sudo -n true']);

  // même commande : la règle répond seule, la carte reste au fil comme autorisée d'office
  await envoyer(m, a.id, 'commande: sudo -n true');
  await waitFor(() => assistant(m, a.id, 'exécutée: sudo -n true') === 2, 15_000, 'par règle');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  expect(evenements(m, a.id, 'request_answered').map((e) => [e.answer, e.auto])).toEqual([
    ['yes', undefined],
    ['no', undefined],
    ['always', undefined],
    ['yes', true],
  ]);
  expect(evenements(m, a.id, 'request')).toHaveLength(4);

  // la règle vaut pour la commande exacte, pas pour une voisine
  const v3 = await carte(m, a.id, 'sudo true');
  expect(v3.pending!.confirm).toEqual({ server: 'vps-test' });
  await repondre(m, v3, 'yes');
  await waitFor(() => assistant(m, a.id, 'exécutée: sudo true') === 1, 15_000, 'autorisée');
});

test('confirmation désactivée sur le serveur : claude en auto exécute le destructif sans demander', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  await reglerServeur(m, s.id, { permissionMode: 'auto', confirmDestructive: false });
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  await envoyer(m, a.id, 'commande: rm -f x');
  await waitFor(() => assistant(m, a.id, 'exécutée sans demande: rm -f x') === 1, 15_000, 'rm');
  expect(evenements(m, a.id, 'request')).toHaveLength(0);
});

test('claude en default : une demande ordinaire reste une carte ordinaire', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  const v = await carte(m, a.id, 'ls');
  expect(v.pending!.confirm).toBeUndefined();
  expect(v.pending!.command).toBe('ls');
  expect(v.pending!.options.map((o) => o.answer)).toEqual(['yes', 'always', 'no']);
  await repondre(m, v, 'yes');
  await waitFor(() => assistant(m, a.id, 'exécutée: ls') === 1, 15_000, 'ls');
  expect(m.t.db.prepare('SELECT COUNT(*) AS n FROM server_rules').get()).toEqual({ n: 0 });
});

test('codex en auto : lancé en untrusted, le non destructif passe seul, le destructif demande confirmation', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  await reglerServeur(m, s.id, { permissionMode: 'auto' });
  const a = (await creerDiscussion(m, s.id, 'codex')).agents[0]!;

  await envoyer(m, a.id, 'commande: ls');
  // soumise par codex (untrusted) puis acceptée par le daemon : rien au fil
  await waitFor(() => assistant(m, a.id, 'exécutée: ls') === 1, 15_000, 'ls');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  expect(evenements(m, a.id, 'request')).toHaveLength(0);

  // la commande telle qu'écrite (`commandActions`), pas l'enveloppe `/bin/zsh -lc`
  const v1 = await carte(m, a.id, 'rm -f x');
  expect(v1.pending).toMatchObject({ command: 'rm -f x', confirm: { server: 'vps-test' } });
  expect(v1.pending!.options.map((o) => o.label)).toEqual(CONFIRMATION);
  await repondre(m, v1, 'always');
  await waitFor(() => assistant(m, a.id, 'exécutée: rm -f x') === 1, 15_000, 'toujours');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');

  await envoyer(m, a.id, 'commande: rm -f x');
  await waitFor(() => assistant(m, a.id, 'exécutée: rm -f x') === 2, 15_000, 'par règle');
  expect(evenements(m, a.id, 'request_answered').map((e) => [e.answer, e.auto])).toEqual([
    ['always', undefined],
    ['yes', true],
  ]);

  const v2 = await carte(m, a.id, 'git push --force');
  await repondre(m, v2, 'no');
  await waitFor(() => assistant(m, a.id, 'refusée: git push --force') === 1, 15_000, 'refus');
});

test('codex en default avec confirmation : untrusted soumet tout, le non destructif en carte ordinaire', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id, 'codex')).agents[0]!;
  const v = await carte(m, a.id, 'ls');
  expect(v.pending!.confirm).toBeUndefined();
  expect(v.pending!.command).toBe('ls');
  await repondre(m, v, 'yes');
  await waitFor(() => assistant(m, a.id, 'exécutée: ls') === 1, 15_000, 'ls');
});

test('« Toujours autoriser » répond aussi aux demandes en file que la nouvelle règle couvre', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  await reglerServeur(m, s.id, { permissionMode: 'auto' });
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  await envoyer(m, a.id, 'commandes: rm -f x ;; rm -f x ;; rm -f y');
  await waitFor(() => evenements(m, a.id, 'request').length === 3, 15_000, 'trois demandes');
  const v = (await m.req('GET', `/api/server-agents/${a.id}`)).json<ServerAgentView>();
  expect(v.pending!.command).toBe('rm -f x');
  await repondre(m, v, 'always');
  // la seconde `rm -f x` est passée par la règle ; reste `rm -f y`, en carte
  await waitFor(() => evenements(m, a.id, 'request_answered').length === 2, 15_000, 'file');
  const v2 = (await m.req('GET', `/api/server-agents/${a.id}`)).json<ServerAgentView>();
  expect(v2.pending!.command).toBe('rm -f y');
  expect(evenements(m, a.id, 'request_answered').map((e) => [e.answer, e.auto])).toEqual([
    ['always', undefined],
    ['yes', true],
  ]);
  await repondre(m, v2, 'no');
  await waitFor(() => assistant(m, a.id, 'refusée: rm -f y') === 1, 15_000, 'fin');
  expect(assistant(m, a.id, 'exécutée: rm -f x')).toBe(2);
});

/** Chantier 17 (R.6) : le composer d'une discussion — repères, options, réglages. */
test('repères : seul un message utilisateur du fil se marque ; seq, agent et message vérifiés', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  const rows = m.t.db
    .prepare('SELECT seq, payload FROM server_agent_messages WHERE agent_id = ? ORDER BY seq')
    .all(a.id) as { seq: number; payload: string }[];
  const role = (r: { payload: string }) => (JSON.parse(r.payload) as { role?: string }).role;
  const user = rows.find((r) => role(r) === 'user')!;
  const autre = rows.find((r) => role(r) !== 'user')!;
  const marque = (seq: number | string, marked = true, id = a.id) =>
    m.req('PUT', `/api/server-agents/${id}/messages/${seq}/mark`, { marked });

  expect((await marque(user.seq)).json()).toEqual({ seq: user.seq, marked: true });
  const lu = () =>
    (
      m.t.db
        .prepare('SELECT marked FROM server_agent_messages WHERE agent_id = ? AND seq = ?')
        .get(a.id, user.seq) as { marked: number }
    ).marked;
  expect(lu()).toBe(1);
  expect((await marque(user.seq, false)).statusCode).toBe(200);
  expect(lu()).toBe(0);
  expect((await marque(autre.seq)).statusCode).toBe(422);
  expect((await marque(0)).statusCode).toBe(400);
  expect((await marque('1x')).statusCode).toBe(400);
  expect((await marque(9999)).statusCode).toBe(404);
  expect((await marque(user.seq, true, 'sa_inconnu')).statusCode).toBe(404);
});

test('options et réglages : modes du serveur, modèle et effort validés, écrits sur l’agent', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  const options = (await m.req('GET', `/api/server-agents/${a.id}/options`)).json<{
    modes: { id: string }[];
    models: { id: string }[];
  }>();
  // sous confirmation (défaut du serveur), claude n'a pas d'`auto` (décision opérateur du 2026-10-31)
  expect(options.modes.map((x) => x.id)).toEqual(['default', 'acceptEdits', 'plan']);
  expect(options.models.map((x) => x.id)).toContain('opus');

  const r = await m.req('PATCH', `/api/server-agents/${a.id}/settings`, {
    mode: 'acceptEdits',
    model: 'opus',
    effort: 'high',
  });
  expect(r.json()).toEqual({ mode: 'acceptEdits', model: 'opus', effort: 'high' });
  const vue = (await m.req('GET', `/api/server-agents/${a.id}`)).json<ServerAgentView>();
  expect([vue.permissionMode, vue.model, vue.effort]).toEqual(['acceptEdits', 'opus', 'high']);
  // un champ absent garde sa valeur ; `null` revient au défaut de la CLI
  expect(
    (await m.req('PATCH', `/api/server-agents/${a.id}/settings`, { model: null })).json(),
  ).toEqual({ mode: 'acceptEdits', model: null, effort: 'high' });

  for (const body of [{ mode: 'bypassPermissions' }, { model: 'gpt-0' }, { effort: 'énorme' }])
    expect((await m.req('PATCH', `/api/server-agents/${a.id}/settings`, body)).statusCode).toBe(
      422,
    );
  expect(
    (await m.req('PATCH', `/api/server-agents/${a.id}/settings`, { couleur: 'x' })).statusCode,
  ).toBe(400);
  expect((await m.req('GET', '/api/server-agents/sa_inconnu/options')).statusCode).toBe(404);
});

test('codex sous confirmation passé en auto depuis le composer : le daemon trie, le destructif reste en carte', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id, 'codex')).agents[0]!;
  const v = await carte(m, a.id, 'ls');
  await repondre(m, v, 'yes');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');

  const r = await m.req('PATCH', `/api/server-agents/${a.id}/settings`, { mode: 'auto' });
  expect(r.statusCode).toBe(200);
  await envoyer(m, a.id, 'commande: ls -la');
  await waitFor(() => assistant(m, a.id, 'exécutée: ls -la') === 1, 15_000, 'ls -la');
  expect(evenements(m, a.id, 'request')).toHaveLength(1);
  const v2 = await carte(m, a.id, 'rm -f x');
  expect(v2.pending!.confirm).toEqual({ server: 'vps-test' });
});

test('Reconnecter : relance un agent en veille sans message, 502 si le serveur ne répond pas', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id, 'codex')).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 15_000, 'idle');
  await m1.t.d.stop();

  const m2 = await daemon(remote, m1.t.home);
  remote.transport.env.FAKE_SSH_FAIL = '1';
  expect((await m2.req('POST', `/api/server-agents/${a.id}/reconnect`)).statusCode).toBe(502);
  delete remote.transport.env.FAKE_SSH_FAIL;
  expect((await m2.req('POST', `/api/server-agents/${a.id}/reconnect`)).statusCode).toBe(202);
  // relancé sous un relais neuf, avant tout message
  const relais = ligne(m2, a.id)!.tmux_session;
  expect(relais).not.toBe(`aid-${a.id}`);
  // déjà vivant : rien à relancer
  expect((await m2.req('POST', `/api/server-agents/${a.id}/reconnect`)).statusCode).toBe(202);
  expect(ligne(m2, a.id)!.tmux_session).toBe(relais);
  await envoyer(m2, a.id, 'deux');
  await waitFor(() => assistant(m2, a.id, 'echo: deux') >= 1, 15_000, 'après reconnexion');
  expect((await m2.req('POST', '/api/server-agents/sa_inconnu/reconnect')).statusCode).toBe(404);
});

test('réglages d’un codex en veille : catalogue inconnu, seul le champ envoyé est validé (revue R.6)', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id, 'codex')).agents[0]!;
  await m1.t.d.stop();
  const m2 = await daemon(remote, m1.t.home);
  // un modèle choisi avant le redémarrage, que le catalogue (vide tant que codex n'a pas parlé) ne connaît pas
  m2.t.db.prepare("UPDATE server_agents SET model = 'gpt-x' WHERE id = ?").run(a.id);
  const r = await m2.req('PATCH', `/api/server-agents/${a.id}/settings`, { mode: 'auto' });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ mode: 'auto', model: 'gpt-x', effort: null });
  expect(
    (await m2.req('PATCH', `/api/server-agents/${a.id}/settings`, { model: 'gpt-y' })).statusCode,
  ).toBe(422);
});

test('claude sous confirmation : `auto` ni proposé ni accepté ; sans confirmation, proposé (décision du 2026-10-31)', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  const r = await m.req('PATCH', `/api/server-agents/${a.id}/settings`, { mode: 'auto' });
  expect(r.statusCode).toBe(422);
  expect(modeDe(m, a.id)).toBe('default');

  await reglerServeur(m, s.id, { permissionMode: 'auto', confirmDestructive: false });
  const b = (await creerDiscussion(m, s.id)).agents[0]!;
  expect(modeDe(m, b.id)).toBe('auto');
  const modes = (await m.req('GET', `/api/server-agents/${b.id}/options`)).json<{
    modes: { id: string }[];
  }>().modes;
  expect(modes.map((x) => x.id)).toContain('auto');

  // codex sous confirmation garde son `auto` : le daemon trie tout ce qu'il soumet (`untrusted`)
  await reglerServeur(m, s.id, { confirmDestructive: true });
  const c = (await creerDiscussion(m, s.id, 'codex')).agents[0]!;
  expect(modeDe(m, c.id)).toBe('auto');
});

test('claude lancé en `auto` puis confirmation activée : ramené à `default` à sa relance', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  await reglerServeur(m1, s.id, { permissionMode: 'auto', confirmDestructive: false });
  const a = (await creerDiscussion(m1, s.id)).agents[0]!;
  expect(modeDe(m1, a.id)).toBe('auto');
  await envoyer(m1, a.id, 'commande: rm -f avant');
  await waitFor(
    () => assistant(m1, a.id, 'exécutée sans demande: rm -f avant') === 1,
    15_000,
    'auto',
  );
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 15_000, 'idle');
  await reglerServeur(m1, s.id, { confirmDestructive: true });
  await m1.t.d.stop();

  const m2 = await daemon(remote, m1.t.home);
  await waitFor(() => modeDe(m2, a.id) === 'default', 15_000, 'mode ramené');
  const v = await carte(m2, a.id, 'rm -f x');
  expect(v.pending!.confirm).toEqual({ server: 'vps-test' });
  await repondre(m2, v, 'no');
}, 40_000);
