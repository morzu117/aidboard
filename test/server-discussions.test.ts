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
import { afterEach, expect, test, vi } from 'vitest';
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

const CONFIRMATION = ['Autoriser', 'Refuser', 'Toujours autoriser dans ce dossier'];

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

test('« Toujours autoriser » ne vaut que dans le dossier de la discussion (décision du 2026-10-31)', async () => {
  const remote = serveur();
  mkdirSync(join(remote.home, 'autre'));
  const m = await daemon(remote);
  const s = await creerServeur(m);
  const d = await creerDiscussion(m, s.id);
  const a = d.agents[0]!;
  const v1 = await carte(m, a.id, 'rm -f x');
  expect(v1.pending!.options.map((o) => o.label)).toEqual(CONFIRMATION);
  await repondre(m, v1, 'always');
  await waitFor(() => assistant(m, a.id, 'exécutée: rm -f x') === 1, 15_000, 'toujours');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  const regles = (await m.req('GET', `/api/servers/${s.id}`)).json<Server>().rules;
  expect(regles.map((r) => [r.cwd, r.pattern])).toEqual([[d.cwd, 'rm -f x']]);

  // autre dossier du même serveur : la même commande redemande
  const r = await m.req('POST', `/api/servers/${s.id}/discussions`, {
    name: 'Ailleurs',
    kind: 'claude',
    cwd: '~/autre',
  });
  expect(r.statusCode).toBe(201);
  const b = r.json<ServerDiscussionView>().agents[0]!;
  const v2 = await carte(m, b.id, 'rm -f x');
  expect(v2.pending!.confirm).toEqual({ server: 'vps-test' });
  await repondre(m, v2, 'no');
  await waitFor(() => assistant(m, b.id, 'refusée: rm -f x') === 1, 15_000, 'refus ailleurs');

  // dans le dossier d'origine, la règle répond seule
  await envoyer(m, a.id, 'commande: rm -f x');
  await waitFor(() => assistant(m, a.id, 'exécutée: rm -f x') === 2, 15_000, 'par règle');
});

test('arrêt non confirmé par un serveur injoignable : 409, la discussion reste, « quand même » la supprime (décision D.2)', async () => {
  const remote = serveur();
  const m = await daemon(remote);
  const s = await creerServeur(m);
  const d = await creerDiscussion(m, s.id);
  const a = d.agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');

  remote.transport.env.FAKE_SSH_FAIL = '1';
  const r = await m.req('DELETE', `/api/servers/${s.id}/discussions/${d.id}`);
  expect(r.statusCode).toBe(409);
  expect(r.json<{ error: string; unconfirmed: number }>()).toEqual({
    error: 'arrêt non confirmé par le serveur (1 agent) : il y tourne peut-être encore',
    unconfirmed: 1,
  });
  expect(vivant(apid(m, a.id))).toBe(true);
  expect(ligne(m, a.id)).toBeDefined();

  const forcee = await m.req('DELETE', `/api/servers/${s.id}/discussions/${d.id}?force=1`);
  expect(forcee.statusCode).toBe(204);
  expect(ligne(m, a.id)).toBeUndefined();
  delete remote.transport.env.FAKE_SSH_FAIL;
});

test('supprimer un serveur injoignable dont un agent en veille tourne : 409, puis supprimé une fois joignable (décision D.2)', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id, 'codex')).agents[0]!;
  const b = (await creerDiscussion(m1, s.id)).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await envoyer(m1, b.id, 'bonjour');
  await waitFor(
    () => ligne(m1, a.id)?.status === 'idle' && ligne(m1, b.id)?.status === 'idle',
    15_000,
    'idle',
  );
  await m1.t.d.stop();

  // injoignable avant le redémarrage : sinon l'arrêt du relais codex au démarrage (reattachAll) gagne la course
  remote.transport.env.FAKE_SSH_FAIL = '1';
  const m2 = await daemon(remote, m1.t.home);
  const r = await m2.req('DELETE', `/api/servers/${s.id}`);
  expect(r.statusCode).toBe(409);
  expect(r.json<{ unconfirmed: number }>().unconfirmed).toBe(2);
  expect(r.json<{ error: string }>().error).toContain('(2 agents)');
  expect((await m2.req('GET', `/api/servers/${s.id}`)).statusCode).toBe(200);
  expect(vivant(apid(m2, a.id)) && vivant(apid(m2, b.id))).toBe(true);

  // le refus lève la fermeture : le serveur revenu, la suppression ordinaire arrête et efface
  delete remote.transport.env.FAKE_SSH_FAIL;
  expect((await m2.req('DELETE', `/api/servers/${s.id}`)).statusCode).toBe(204);
  expect(vivant(apid(m2, a.id)) || vivant(apid(m2, b.id))).toBe(false);
  expect(m2.t.db.prepare('SELECT COUNT(*) AS n FROM server_agents').get()).toEqual({ n: 0 });
});

test('supprimer quand même un serveur injoignable : les lignes partent, l’agent peut y tourner encore (décision D.2)', async () => {
  const remote = serveur();
  const m = await daemon(remote);
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  const fichier = apid(m, a.id);

  remote.transport.env.FAKE_SSH_FAIL = '1';
  expect((await m.req('DELETE', `/api/servers/${s.id}?force=1`)).statusCode).toBe(204);
  expect((await m.req('GET', `/api/servers/${s.id}`)).statusCode).toBe(404);
  expect(m.t.db.prepare('SELECT COUNT(*) AS n FROM server_agents').get()).toEqual({ n: 0 });
  expect(vivant(fichier)).toBe(true);
  delete remote.transport.env.FAKE_SSH_FAIL;
  process.kill(parseInt(readFileSync(fichier, 'utf8'), 10), 'SIGTERM');
  // le relais écrit la fin de l'agent dans son dossier : attendue, sans quoi le nettoyage efface en même temps
  await waitFor(() => existsSync(join(fichier, '..', 'exit')), 5_000, 'exit');
});

test('entrées refusées : discussion inconnue, renommage vide ou trop long, réponse inconnue, agent arrêté', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  // dossier blanc : le dossier de travail du serveur
  const r0 = await m.req('POST', `/api/servers/${s.id}/discussions`, {
    name: 'Blanc',
    kind: 'claude',
    cwd: '   ',
  });
  expect(r0.json<ServerDiscussionView>().cwd).toBe(s.workdir);
  const d = r0.json<ServerDiscussionView>();
  const a = d.agents[0]!;
  expect((await m.req('GET', `/api/servers/${s.id}/discussions/sd_inconnue`)).statusCode).toBe(404);
  const url = `/api/servers/${s.id}/discussions/${d.id}`;
  expect((await m.req('PATCH', url, { name: '  ' })).statusCode).toBe(422);
  expect((await m.req('PATCH', url, { name: 'x'.repeat(121) })).statusCode).toBe(422);
  // une seule des deux : l'autre garde sa valeur
  expect(
    (await m.req('PATCH', url, { archived: true })).json<ServerDiscussionView>(),
  ).toMatchObject({
    name: 'Blanc',
    archived: true,
  });
  expect(
    (await m.req('PATCH', url, { name: 'Renommée' })).json<ServerDiscussionView>(),
  ).toMatchObject({ name: 'Renommée', archived: true });
  expect(
    (await m.req('PATCH', url, { archived: false })).json<ServerDiscussionView>().archived,
  ).toBe(false);

  await envoyer(m, a.id, 'demande permission');
  await waitFor(() => ligne(m, a.id)?.status === 'needs_input', 15_000, 'needs_input');
  const pending = (await m.req('GET', `/api/server-agents/${a.id}`)).json<ServerAgentView>()
    .pending!;
  const inconnue = await m.req('POST', `/api/server-agents/${a.id}/answer`, {
    pendingId: pending.id,
    answer: 'peut',
  });
  expect(inconnue.statusCode).toBe(422);
  expect(inconnue.json<{ error: string }>().error).toBe('réponse inconnue pour cette demande');
  await repondre(
    m,
    (await m.req('GET', `/api/server-agents/${a.id}`)).json<ServerAgentView>(),
    'yes',
  );
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');

  // agent fini sur le serveur, pilote sorti : interrompre n'a plus de cible
  process.kill(parseInt(readFileSync(apid(m, a.id), 'utf8'), 10), 'SIGKILL');
  await waitFor(() => ['done', 'error'].includes(ligne(m, a.id)?.status ?? ''), 15_000, 'fini');
  const r = await m.req('POST', `/api/server-agents/${a.id}/interrupt`);
  expect(r.statusCode).toBe(409);
  expect(r.json<{ error: string }>().error).toBe('agent arrêté sur le serveur');
});

test('/ws/server-agent : historique après `after`, lignes corrompues ignorées, marquées, borné en octets', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  const msg = m.t.db.prepare(
    'INSERT INTO server_agent_messages (agent_id, seq, kind, payload, at, marked) VALUES (?, ?, ?, ?, ?, ?)',
  );
  msg.run(a.id, 1001, 'assistant', '{pas du json', 't', 0);
  msg.run(
    a.id,
    1002,
    'assistant',
    JSON.stringify({ type: 'message', role: 'assistant', text: 'm' }),
    't',
    1,
  );
  type Hist = { items: { seq: number; marked?: boolean }[]; truncated: boolean };
  const hist = async (after?: number) => {
    const c = await Client.open(m, a.id, after);
    await waitFor(() => c.find('history').length > 0, 5_000, 'history');
    c.ws.close();
    return c.find('history')[0] as unknown as Hist;
  };
  // après 1000 : la ligne corrompue tombe, la marquée le dit
  expect((await hist(1000)).items).toEqual([
    { seq: 1002, at: 't', event: expect.any(Object), marked: true },
  ]);
  // `after` illisible ou négatif : tout l'historique
  const tout = await hist(-4);
  expect(tout.items.length).toBeGreaterThan(1);
  expect(tout.truncated).toBe(false);
  expect((await hist(Number.NaN)).items).toEqual(tout.items);

  // au-delà de 4 Mo d'historique : les plus récents seulement, `truncated`
  const gros = JSON.stringify({
    type: 'message',
    role: 'assistant',
    text: 'x'.repeat(1024 * 1024),
  });
  for (let i = 0; i < 5; i++) msg.run(a.id, 2000 + i, 'assistant', gros, 't', 0);
  const borne = await hist(1999);
  expect(borne.truncated).toBe(true);
  // chacun un peu plus d'1 Mo : trois tiennent sous la borne
  expect(borne.items.map((i) => i.seq)).toEqual([2002, 2003, 2004]);
});

test('/ws/server-agent : l’agent s’arrête pendant l’abonnement — exit avec sa raison, puis fermeture ; fini avant : exit tout de suite', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const d = await creerDiscussion(m, s.id);
  const a = d.agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');

  const c = await Client.open(m, a.id);
  await waitFor(() => c.find('history').length > 0, 5_000, 'history');
  process.kill(parseInt(readFileSync(apid(m, a.id), 'utf8'), 10), 'SIGKILL');
  await waitFor(() => c.closeCode !== null, 15_000, 'fermeture');
  expect(c.closeCode).toBe(1000);
  expect(c.find('event').some((e) => (e.event as { type: string }).type === 'exit')).toBe(true);
  expect(c.find('exit')[0]).toMatchObject({ reason: 'exit' });

  // pilote sorti : le même canal répond `exited` et l'exit enregistré
  const c2 = await Client.open(m, a.id);
  await waitFor(() => c2.closeCode !== null, 5_000, 'fermeture');
  expect(c2.find('hello')[0]).toMatchObject({ exited: true });
  expect(c2.find('exit')[0]).toMatchObject({ reason: 'exit' });
});

test('chantier 19, S.4 : daemon redémarré serveur éteint — claude jamais en erreur, rattaché au même relais une fois revenu', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id)).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 15_000, 'idle');
  await m1.t.d.stop();

  remote.transport.env.FAKE_SSH_FAIL = '1';
  const m2 = await daemon(remote, m1.t.home);
  // plusieurs tentatives de rattachement échouent (1 s, 2 s…) : l'agent reste en cours, pas fini
  await new Promise((r) => setTimeout(r, 3_500));
  expect(ligne(m2, a.id)!.status).not.toBe('error');
  expect(vivant(apid(m2, a.id))).toBe(true);
  delete remote.transport.env.FAKE_SSH_FAIL;
  await envoyer(m2, a.id, 'deux');
  await waitFor(() => assistant(m2, a.id, 'echo: deux') === 1, 20_000, 'réponse');
  // rattaché, pas relancé : même relais, l'agent d'avant a répondu
  expect(ligne(m2, a.id)!.tmux_session).toBe(`aid-${a.id}`);
  expect(assistant(m2, a.id, 'echo: bonjour')).toBe(1);
}, 40_000);

test('chantier 19, S.4 : Reconnecter un claude fini faute de lien qui tourne encore — rattaché à son offset, pas relancé', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id)).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 15_000, 'idle');
  // pilote sorti en erreur faute de lien : statut fini, agent toujours vivant sur le serveur
  m1.t.db.prepare("UPDATE server_agents SET status = 'error' WHERE id = ?").run(a.id);
  await m1.t.d.stop();

  const m2 = await daemon(remote, m1.t.home);
  const pid = readFileSync(apid(m2, a.id), 'utf8');
  expect((await m2.req('POST', `/api/server-agents/${a.id}/reconnect`)).statusCode).toBe(202);
  expect(ligne(m2, a.id)).toMatchObject({ status: 'idle', tmux_session: `aid-${a.id}` });
  await envoyer(m2, a.id, 'deux');
  await waitFor(() => assistant(m2, a.id, 'echo: deux') === 1, 15_000, 'réponse');
  // le même agent : ni relancé, ni sa sortie déjà lue rejouée
  expect(readFileSync(apid(m2, a.id), 'utf8')).toBe(pid);
  expect(assistant(m2, a.id, 'echo: bonjour')).toBe(1);
  // déjà rattaché : rien de plus
  expect((await m2.req('POST', `/api/server-agents/${a.id}/reconnect`)).statusCode).toBe(202);
  expect(ligne(m2, a.id)!.tmux_session).toBe(`aid-${a.id}`);
}, 30_000);

test('chantier 19, S.4 : Reconnecter un claude dont l’agent est arrêté sur le serveur — relancé sous un relais neuf', async () => {
  const remote = serveur();
  const m1 = await daemon(remote);
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id)).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 15_000, 'idle');
  m1.t.db.prepare("UPDATE server_agents SET status = 'error' WHERE id = ?").run(a.id);
  await m1.t.d.stop();
  tuer(apid(m1, a.id));

  const m2 = await daemon(remote, m1.t.home);
  await waitFor(() => !vivant(apid(m2, a.id)), 5_000, 'agent arrêté');
  expect((await m2.req('POST', `/api/server-agents/${a.id}/reconnect`)).statusCode).toBe(202);
  expect(ligne(m2, a.id)!.tmux_session).not.toBe(`aid-${a.id}`);
}, 30_000);

test('chantier 19, S.5 : premier tour mort avant sa fin, session déjà créée — la relance reprend la session (--resume)', async () => {
  const remote = serveur();
  remote.transport.env.FAKE_CLAUDE_STRICT = '1';
  const m = await daemon(remote);
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  // l'agent meurt au premier message : la session existe chez claude, aucun `turn_end` au fil
  await envoyer(m, a.id, 'crash');
  await waitFor(() => ligne(m, a.id)?.status === 'error', 15_000, 'agent mort');
  await envoyer(m, a.id, 'deux');
  await waitFor(() => assistant(m, a.id, 'echo: deux') === 1, 15_000, 'réponse après relance');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  expect(fil(m, a.id).filter((e) => (e as { type?: string }).type === 'exit')).toHaveLength(1);
}, 30_000);

test('chantier 19, S.5 : session inconnue du serveur malgré un tour fini — la relance repart sur une session neuve', async () => {
  const remote = serveur();
  remote.transport.env.FAKE_CLAUDE_STRICT = '1';
  const m = await daemon(remote);
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  // les sessions de claude effacées sur le serveur, puis l'agent arrêté
  rmSync(join(remote.home, '.fake-claude-sessions'), { recursive: true, force: true });
  await envoyer(m, a.id, 'crash');
  await waitFor(() => ligne(m, a.id)?.status === 'error', 15_000, 'agent mort');
  rmSync(join(remote.home, '.fake-claude-sessions'), { recursive: true, force: true });
  await envoyer(m, a.id, 'trois');
  await waitFor(() => assistant(m, a.id, 'echo: trois') === 1, 15_000, 'réponse après relance');
}, 30_000);

test('chantier 19, S.5 : relance refusée dans les deux sens — une seule nouvelle tentative, puis l’erreur', async () => {
  const remote = serveur();
  remote.transport.env.FAKE_CLAUDE_STRICT = '1';
  const m = await daemon(remote);
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  await envoyer(m, a.id, 'crash');
  await waitFor(() => ligne(m, a.id)?.status === 'error', 15_000, 'agent mort');
  // le binaire de reprise ne démarre plus du tout : ni --session-id ni --resume
  remote.transport.env.FAKE_CLAUDE_REFUSE = '1';
  await envoyer(m, a.id, 'deux');
  await waitFor(
    () => fil(m, a.id).filter((e) => (e as { type?: string }).type === 'exit').length === 2,
    15_000,
    'seconde fin',
  );
  await waitFor(() => ligne(m, a.id)?.status === 'error', 15_000, 'erreur');
  await new Promise((r) => setTimeout(r, 1_000));
  expect(fil(m, a.id).filter((e) => (e as { type?: string }).type === 'exit')).toHaveLength(2);
}, 30_000);

test('chantier 19, S.6 : confirmation changée pendant que l’agent tourne — signalée, jusqu’à la relance qui la prend', async () => {
  const remote = serveur();
  const m = await daemon(remote);
  const s = await creerServeur(m);
  await reglerServeur(m, s.id, { confirmDestructive: false });
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  const vue = async () =>
    (await m.req('GET', `/api/server-agents/${a.id}`)).json<ServerAgentView>().staleConfirm;
  expect(await vue()).toBe(false);

  await reglerServeur(m, s.id, { confirmDestructive: true });
  expect(await vue()).toBe(true);
  // la discussion rend la même vue
  const d = (
    await m.req('GET', `/api/servers/${s.id}/discussions/${a.discussionId}`)
  ).json<ServerDiscussionView>();
  expect(d.agents[0]!.staleConfirm).toBe(true);
  // revenu au réglage du lancement : plus d'écart
  await reglerServeur(m, s.id, { confirmDestructive: false });
  expect(await vue()).toBe(false);

  await reglerServeur(m, s.id, { confirmDestructive: true });
  await envoyer(m, a.id, 'crash');
  await waitFor(() => ligne(m, a.id)?.status === 'error', 15_000, 'agent mort');
  // fini : rien ne tourne avec l'ancien réglage
  expect(await vue()).toBe(false);
  await envoyer(m, a.id, 'commande: rm -f x');
  await waitFor(() => ligne(m, a.id)?.status === 'needs_input', 15_000, 'carte');
  expect(await vue()).toBe(false);
}, 30_000);

test('chantier 19, S.7 : demande perdue en route — tracée sans identifiants, refusée auprès de l’agent, jamais en attente sans carte', async () => {
  const lignes: string[] = [];
  const espion = vi.spyOn(console, 'error').mockImplementation((l: unknown) => {
    lignes.push(String(l));
  });
  nettoyages.push(() => espion.mockRestore());
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  // la base refuse le passage en attente : l'événement `request` lève en plein traitement
  m.t.db.exec(
    `CREATE TRIGGER panne BEFORE UPDATE OF status ON server_agents WHEN NEW.status = 'needs_input'
     BEGIN SELECT RAISE(ABORT, 'panne simulée https://deploy:jeton-secret@git.exemple/x'); END`,
  );
  await envoyer(m, a.id, 'commande: ls');
  await waitFor(() => assistant(m, a.id, 'refusée: ls') === 1, 15_000, 'refus');
  expect(
    (await m.req('GET', `/api/server-agents/${a.id}`)).json<ServerAgentView>().pending,
  ).toBeNull();
  const trace = lignes.find((l) => l.includes('événement request non traité'));
  expect(trace).toBe(
    `serveurs : événement request non traité (agent ${a.id}) : panne simulée https://git.exemple/x`,
  );
  expect(lignes.join('\n')).not.toContain('jeton-secret');
}, 30_000);

test('chantier 19, S.7 : écriture au fil en échec — tracée, le lien fermé, le message suivant relance', async () => {
  const lignes: string[] = [];
  const espion = vi.spyOn(console, 'error').mockImplementation((l: unknown) => {
    lignes.push(String(l));
  });
  nettoyages.push(() => espion.mockRestore());
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  m.t.db.exec(
    `CREATE TRIGGER panne BEFORE INSERT ON server_agent_messages WHEN json_extract(NEW.payload, '$.text') = 'echo: un'
     BEGIN SELECT RAISE(ABORT, 'disque plein'); END`,
  );
  await envoyer(m, a.id, 'un');
  await waitFor(
    () => lignes.some((l) => l.startsWith('serveurs : écriture au fil (message)')),
    15_000,
    'trace',
  );
  expect(lignes.find((l) => l.startsWith('serveurs : écriture au fil'))).toBe(
    `serveurs : écriture au fil (message) (agent ${a.id}) : disque plein`,
  );
  m.t.db.exec('DROP TRIGGER panne');
  await envoyer(m, a.id, 'deux');
  await waitFor(() => assistant(m, a.id, 'echo: deux') >= 1, 15_000, 'relancé');
}, 30_000);

test('chantier 20, M.2 : un secret au fil est masqué — base, vue, socket ; l’agent l’a reçu en clair', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  const jeton = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const masque = 'ghp_[secret masqué]';
  const client = await Client.open(m, a.id);
  const recus = () => client.texts.map((t) => JSON.stringify(t));

  await envoyer(m, a.id, `mon jeton ${jeton}`);
  await waitFor(() => assistant(m, a.id, `echo: mon jeton ${masque}`) === 1, 15_000, 'réponse');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  // l'opérateur l'a tapé : masqué au fil (DM4)
  expect(fil(m, a.id).find((e) => e.role === 'user')?.text).toBe(`mon jeton ${masque}`);
  const brut = (
    m.t.db.prepare('SELECT payload FROM server_agent_messages WHERE agent_id = ?').all(a.id) as {
      payload: string;
    }[]
  )
    .map((r) => r.payload)
    .join('\n');
  expect(brut).not.toContain('A1b2C3');
  await waitFor(
    () => recus().some((r) => r.includes(`echo: mon jeton ${masque}`)),
    5_000,
    'socket',
  );
  expect(recus().join('\n')).not.toContain('A1b2C3');

  // l'agent l'a reçu en clair : sa réponse, sur le serveur, le porte ; seule la sortie du relais le garde
  const relais = readdirSync(join(m.home, '.aid-remote/agents'));
  const sorties = relais.map((r) =>
    readFileSync(join(m.home, '.aid-remote/agents', r, 'out'), 'utf8'),
  );
  expect(sorties.join('')).toContain(`echo: mon jeton ${jeton}`);

  // une carte : la commande masquée dans la vue de l'agent comme au fil
  const v = await carte(m, a.id, `curl -H "Authorization: token ${jeton}" https://api.exemple`);
  expect(v.pending!.command).toBe(`curl -H "Authorization: token ${masque}" https://api.exemple`);
  expect(JSON.stringify(v)).not.toContain('A1b2C3');
  await repondre(m, v, 'no');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  expect(
    (
      m.t.db.prepare('SELECT payload FROM server_agent_messages WHERE agent_id = ?').all(a.id) as {
        payload: string;
      }[]
    ).some((r) => r.payload.includes('A1b2C3')),
  ).toBe(false);
}, 40_000);

test('chantier 20, M.3 : une commande qui portait un secret — ni « Toujours autoriser », ni règle écrite ou appliquée', async () => {
  const m = await daemon(serveur());
  const s = await creerServeur(m);
  const d = await creerDiscussion(m, s.id);
  const a = d.agents[0]!;
  const commande = 'sudo git push https://deploy:motdepasse@git.exemple/o/r.git';
  const masquee = 'sudo git push https://[secret masqué]@git.exemple/o/r.git';
  // une règle identique au caractère près à la commande masquée ne s'applique pas
  m.t.db
    .prepare(
      'INSERT INTO server_rules (id, server_id, cwd, pattern, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('sr_piege', s.id, d.cwd, masquee, new Date().toISOString());

  const v = await carte(m, a.id, commande);
  expect(v.pending).toMatchObject({ command: masquee, confirm: { server: 'vps-test' } });
  expect(v.pending!.options.map((o) => o.label)).toEqual(['Autoriser', 'Refuser']);
  const toujours = await m.req('POST', `/api/server-agents/${a.id}/answer`, {
    pendingId: v.pending!.id,
    answer: 'always',
  });
  expect(toujours.statusCode).toBe(422);
  await repondre(m, v, 'yes');
  await waitFor(() => assistant(m, a.id, `exécutée: ${masquee}`) === 1, 15_000, 'autorisée');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 15_000, 'idle');
  const regles = (await m.req('GET', `/api/servers/${s.id}`)).json<Server>().rules;
  expect(regles.map((r) => r.id)).toEqual(['sr_piege']);
  expect(JSON.stringify(regles)).not.toContain('motdepasse');

  // une commande sans secret garde ses trois boutons
  const ordinaire = await carte(m, a.id, 'sudo -n true');
  expect(ordinaire.pending!.options.map((o) => o.label)).toEqual(CONFIRMATION);
}, 40_000);
