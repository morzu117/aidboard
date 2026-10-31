import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type { ServerDiscussionView } from '../../src/daemon/remote/agents.js';
import type { Server, ServerTest } from '../../src/shared/model.js';
import { startTestDaemon, type TestDaemon, waitFor } from '../helpers/daemon.js';
import { demarrerLabo, type Labo } from './labo.js';

/**
 * Chantier 18, L.3 : les discussions de serveur de bout en bout — daemon réel, vrai ssh, vrai sshd, vrai
 * tmux ; seuls les agents sont faux (enveloppés en `claude` et `codex` sur le serveur, DL5).
 */
let labo: Labo;
beforeAll(() => {
  labo = demarrerLabo();
});
afterAll(() => labo?.arreter());

const daemons: TestDaemon[] = [];
afterEach(async () => {
  for (const t of daemons.splice(0).reverse()) await t.d.stop();
  labo.retablir();
  labo.exec(
    "pkill -u aid -f '/opt/aid-fixtures/' || true; su aid -s /bin/sh -c 'tmux -L aid-relay kill-server' 2>/dev/null || true",
  );
});

type Reponse = { statusCode: number; body: string; json<T>(): T };

interface Monte {
  t: TestDaemon;
  req: (method: string, url: string, payload?: unknown) => Promise<Reponse>;
}

async function daemon(home?: string): Promise<Monte> {
  const t = await startTestDaemon(home, { remote: labo.transport });
  daemons.push(t);
  const req = (method: string, url: string, payload?: unknown) =>
    t.d.app.inject({ method: method as never, url, headers: t.headers, payload: payload as never });
  return { t, req };
}

const arreter = async (m: Monte) => {
  daemons.splice(daemons.indexOf(m.t), 1);
  await m.t.d.stop();
};

/** Un serveur enregistré puis testé : les agents proposés sont ceux que le test a détectés. */
async function creerServeur(m: Monte): Promise<Server> {
  const r = await m.req('POST', '/api/servers', {
    name: 'labo',
    mode: 'ssh_alias',
    target: 'aid-labo',
  });
  expect(r.statusCode).toBe(201);
  const s = r.json<Server>();
  const recus: ServerTest[] = [];
  m.t.store.on('ephemeral', (x: { type: string; test?: ServerTest }) => {
    if (x.type === 'server.test' && x.test) recus.push(structuredClone(x.test));
  });
  await m.req('POST', `/api/servers/${s.id}/test`);
  const fini = await waitFor(() => recus.find((x) => x.finishedAt), 30_000, 'test de connexion');
  expect(fini.ok, fini.raw).toBe(true);
  return s;
}

async function creerDiscussion(m: Monte, serverId: string, kind = 'claude') {
  const r = await m.req('POST', `/api/servers/${serverId}/discussions`, { name: 'Labo', kind });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<ServerDiscussionView>();
}

const ligne = (m: Monte, agentId: string) =>
  m.t.db.prepare('SELECT * FROM server_agents WHERE id = ?').get(agentId) as
    { status: string; tmux_session: string; session_id: string | null } | undefined;

type Entree = { type?: string; kind?: string; role?: string; text?: string };
const fil = (m: Monte, agentId: string): Entree[] =>
  (
    m.t.db
      .prepare('SELECT payload FROM server_agent_messages WHERE agent_id = ? ORDER BY seq')
      .all(agentId) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as Entree);

const assistant = (m: Monte, agentId: string, text: string) =>
  fil(m, agentId).filter((e) => e.type === 'message' && e.role === 'assistant' && e.text === text)
    .length;

async function envoyer(m: Monte, agentId: string, text: string): Promise<void> {
  const r = await m.req('POST', `/api/server-agents/${agentId}/input`, { text });
  expect(r.statusCode, r.body).toBe(202);
}

/** Vu dans le conteneur : sessions du relais, et process des faux agents de l'utilisateur. */
const sessions = () =>
  labo.exec("tmux -L aid-relay ls -F '#S' 2>/dev/null || true", 'aid').split('\n').filter(Boolean);
const agentsDuServeur = () =>
  labo.exec("pgrep -u aid -f '/opt/aid-fixtures/fake-' || true").split('\n').filter(Boolean);

test('claude : échange, redémarrage du daemon rattaché, coupure réseau en plein tour, suppression', async () => {
  const m1 = await daemon();
  const s = await creerServeur(m1);
  const d = await creerDiscussion(m1, s.id);
  const a = d.agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => assistant(m1, a.id, 'echo: bonjour') === 1, 20_000, 'réponse');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 20_000, 'idle');
  expect(sessions()).toEqual([`aid-${a.id}`]);
  const pids = agentsDuServeur();
  expect(pids).toHaveLength(1);

  // le daemon s'arrête : l'agent continue sur le serveur (D73) ; le suivant se rattache au même relais
  await arreter(m1);
  expect(agentsDuServeur()).toEqual(pids);
  const m2 = await daemon(m1.t.home);
  await envoyer(m2, a.id, 'deux');
  await waitFor(() => assistant(m2, a.id, 'echo: deux') === 1, 20_000, 'réponse après redémarrage');
  await waitFor(() => ligne(m2, a.id)?.status === 'idle', 20_000, 'idle');
  expect(agentsDuServeur()).toEqual(pids);
  expect(assistant(m2, a.id, 'echo: bonjour')).toBe(1);

  // coupure en plein tour : les connexions tombent, le serveur refuse un temps, puis revient
  await envoyer(m2, a.id, 'tour long');
  await waitFor(() => assistant(m2, a.id, 'tour long démarré') === 1, 20_000, 'tour long');
  labo.couper();
  await waitFor(
    () => fil(m2, a.id).some((e) => e.type === 'connection_lost'),
    20_000,
    'perte de lien',
  );
  await new Promise((r) => setTimeout(r, 1_500));
  labo.retablir();
  await waitFor(
    () => fil(m2, a.id).some((e) => e.type === 'connection_resumed'),
    30_000,
    'lien rétabli',
  );
  expect(agentsDuServeur()).toEqual(pids);
  expect((await m2.req('POST', `/api/server-agents/${a.id}/interrupt`)).statusCode).toBeLessThan(
    300,
  );
  await waitFor(() => ligne(m2, a.id)?.status === 'idle', 20_000, 'tour interrompu');
  expect(assistant(m2, a.id, 'tour long démarré')).toBe(1);
  expect(
    fil(m2, a.id)
      .filter((e) => e.role === 'user')
      .map((e) => e.text),
  ).toEqual(['bonjour', 'deux', 'tour long']);

  expect((await m2.req('DELETE', `/api/servers/${s.id}/discussions/${d.id}`)).statusCode).toBe(204);
  await waitFor(() => agentsDuServeur().length === 0, 20_000, 'agent arrêté sur le serveur');
  expect(sessions()).toEqual([]);
});

test('codex : échange, redémarrage du daemon, reprise du fil sous un relais neuf', async () => {
  const m1 = await daemon();
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id, 'codex')).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(
    () => ligne(m1, a.id)?.status === 'idle' && assistant(m1, a.id, 'echo: bonjour') >= 1,
    20_000,
    'réponse',
  );
  const thread = ligne(m1, a.id)!.session_id;
  expect(thread).toBeTruthy();
  await arreter(m1);

  const m2 = await daemon(m1.t.home);
  // l'ancien relais est arrêté au démarrage (reattachAll) : plus d'agent ni de session sur le serveur
  await waitFor(
    () => agentsDuServeur().length === 0 && sessions().length === 0,
    20_000,
    'ancien relais',
  );
  await envoyer(m2, a.id, 'deux');
  await waitFor(
    () => ligne(m2, a.id)?.status === 'idle' && assistant(m2, a.id, 'echo: deux') >= 1,
    20_000,
    'reprise',
  );
  const apres = ligne(m2, a.id)!;
  expect(apres.session_id).toBe(thread);
  expect(apres.tmux_session.startsWith(`aid-${a.id}-`)).toBe(true);
  expect(sessions()).toEqual([apres.tmux_session]);
});

test('supprimer un serveur coupé : 409, l’agent tourne encore ; revenu, la suppression l’arrête (D.2)', async () => {
  const m = await daemon();
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 20_000, 'idle');

  labo.couper();
  const r = await m.req('DELETE', `/api/servers/${s.id}`);
  expect(r.statusCode, r.body).toBe(409);
  expect(r.json<{ unconfirmed: number }>().unconfirmed).toBe(1);
  expect(agentsDuServeur()).toHaveLength(1);
  expect((await m.req('GET', `/api/servers/${s.id}`)).statusCode).toBe(200);

  labo.retablir();
  expect((await m.req('DELETE', `/api/servers/${s.id}`)).statusCode).toBe(204);
  await waitFor(() => agentsDuServeur().length === 0, 20_000, 'agent arrêté');
  expect(sessions()).toEqual([]);
});
