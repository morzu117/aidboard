import { afterEach, expect, test } from 'vitest';
import type { Server } from '../src/shared/model.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
});

const req = (method: 'POST' | 'DELETE', url: string, payload?: unknown) =>
  t!.d.app.inject({ method, url, headers: t!.headers, payload: payload as never });

/** Un serveur, une discussion, un agent et deux messages, écrits directement en base (les routes arrivent en R.4). */
async function peupler(nom: string): Promise<{ serverId: string; agentId: string }> {
  const s = (
    await req('POST', '/api/servers', { name: nom, mode: 'ssh_alias', target: 'vps' })
  ).json<Server>();
  const discussionId = `sd_${nom}`;
  const agentId = `sa_${nom}`;
  t!.db
    .prepare(
      'INSERT INTO server_discussions (id, server_id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(discussionId, s.id, 'maintenance-nginx', '~', 't', 't');
  t!.db
    .prepare(
      `INSERT INTO server_agents (id, discussion_id, kind, session_id, status, tmux_session, permission_mode,
         created_at, updated_at) VALUES (?, ?, 'claude', NULL, 'idle', ?, 'default', 't', 't')`,
    )
    .run(agentId, discussionId, `aid-${agentId}`);
  const msg = t!.db.prepare(
    'INSERT INTO server_agent_messages (agent_id, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?)',
  );
  msg.run(agentId, 1, 'user', '{"text":"bonjour"}', 't');
  msg.run(agentId, 2, 'assistant', '{"text":"salut"}', 't');
  return { serverId: s.id, agentId };
}

const compte = (table: string) =>
  (t!.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('schéma R.1 : défauts d’un agent et d’un message, même forme que agent_messages', async () => {
  t = await startTestDaemon();
  const { agentId } = await peupler('vps-ovh');
  expect(
    t.db.prepare('SELECT out_offset, model, effort FROM server_agents WHERE id = ?').get(agentId),
  ).toEqual({
    out_offset: 0,
    model: null,
    effort: null,
  });
  expect(
    t.db.prepare('SELECT archived FROM server_discussions WHERE id = ?').get('sd_vps-ovh'),
  ).toEqual({ archived: 0 });
  const colonnes = (table: string) =>
    (t!.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  expect(colonnes('server_agent_messages')).toEqual(colonnes('agent_messages'));
  // (agent_id, seq) est la clé : un message rejoué ne double pas le fil
  expect(() =>
    t!.db
      .prepare(
        'INSERT INTO server_agent_messages (agent_id, seq, kind, payload, at) VALUES (?, 1, ?, ?, ?)',
      )
      .run(agentId, 'user', '{}', 't'),
  ).toThrow(/UNIQUE|PRIMARY KEY/);
});

test('une discussion exige un serveur existant, un agent une discussion existante', async () => {
  t = await startTestDaemon();
  expect(() =>
    t!.db
      .prepare(
        "INSERT INTO server_discussions (id, server_id, name, cwd, created_at, updated_at) VALUES ('sd_x', 'srv_absent', 'x', '~', 't', 't')",
      )
      .run(),
  ).toThrow(/FOREIGN KEY/);
  expect(() =>
    t!.db
      .prepare(
        `INSERT INTO server_agents (id, discussion_id, kind, status, permission_mode, created_at, updated_at)
         VALUES ('sa_x', 'sd_absente', 'claude', 'idle', 'default', 't', 't')`,
      )
      .run(),
  ).toThrow(/FOREIGN KEY/);
});

test('supprimer un serveur supprime ses discussions, leurs agents et leurs fils — et seulement les siens', async () => {
  t = await startTestDaemon();
  const a = await peupler('vps-ovh');
  await peupler('build');
  expect(compte('server_agent_messages')).toBe(4);

  expect((await req('DELETE', `/api/servers/${a.serverId}`)).statusCode).toBe(204);
  expect(compte('server_discussions')).toBe(1);
  expect(compte('server_agents')).toBe(1);
  expect(compte('server_agent_messages')).toBe(2);
  expect(t.db.prepare('SELECT 1 FROM server_agents WHERE id = ?').get(a.agentId)).toBeUndefined();
});
