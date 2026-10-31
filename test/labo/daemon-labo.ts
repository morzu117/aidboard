import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import type { ServerDiscussionView } from '../../src/daemon/remote/agents.js';
import type { Server, ServerTest } from '../../src/shared/model.js';
import { startTestDaemon, type TestDaemon, waitFor } from '../helpers/daemon.js';
import { demarrerLabo, type Labo } from './labo.js';

/**
 * Chantier 18 : le banc des scénarios de bout en bout — un labo par fichier de test, des daemons réels
 * arrêtés après chaque test, le serveur remis en état (rétabli, agents et tmux du relais tués).
 */
export function monterBanc() {
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
      t.d.app.inject({
        method: method as never,
        url,
        headers: t.headers,
        payload: payload as never,
      });
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
    labo
      .exec("tmux -L aid-relay ls -F '#S' 2>/dev/null || true", 'aid')
      .split('\n')
      .filter(Boolean);
  const agentsDuServeur = () =>
    labo.exec("pgrep -u aid -f '/opt/aid-fixtures/fake-' || true").split('\n').filter(Boolean);

  return {
    labo: () => labo,
    daemon,
    arreter,
    creerServeur,
    creerDiscussion,
    ligne,
    fil,
    assistant,
    envoyer,
    sessions,
    agentsDuServeur,
  };
}

export type Banc = ReturnType<typeof monterBanc>;
