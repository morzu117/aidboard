import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { type LiveRemote, RemoteAgentManager } from '../src/daemon/remote/agents.js';
import { ServerConnections } from '../src/daemon/remote/connection.js';
import type { ConversationEvent } from '../src/shared/conversation.js';
import type { ServerStatus } from '../src/shared/model.js';

// Chantier 25 (D106) : l'agrégat des agents d'un serveur, porté par son état de connexion. Rien ne part sur le
// réseau : la base est temporaire et les agents « vivants » sont posés à la main dans le gestionnaire.

function monter() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'aid-vps-')), 'state.db'));
  const t = '2026-11-05T10:00:00Z';
  for (const id of ['srv_a', 'srv_b'])
    db.prepare(
      `INSERT INTO servers (id, name, mode, target, color, created_at, updated_at)
       VALUES (?, ?, 'command', 'true', '#5de0a1', ?, ?)`,
    ).run(id, id, t, t);
  for (const [id, server] of [
    ['sd_1', 'srv_a'],
    ['sd_2', 'srv_a'],
    ['sd_3', 'srv_b'],
  ])
    db.prepare(
      `INSERT INTO server_discussions (id, server_id, name, cwd, created_at, updated_at)
       VALUES (?, ?, ?, '~', ?, ?)`,
    ).run(id, server, id, t, t);
  const store = new EventStore(db);
  const manager = new RemoteAgentManager({ db, transport: {} });
  const prive = manager as unknown as {
    live: Map<string, LiveRemote>;
    noterSuivi: (live: LiveRemote, ev: ConversationEvent) => void;
  };
  const vivant = (id: string, discussionId: string, exited = false) => {
    const live = { id, discussionId, exited } as LiveRemote;
    prive.live.set(id, live);
    return live;
  };
  const evenement = (live: LiveRemote, ev: ConversationEvent) =>
    prive.noterSuivi.call(manager, live, ev);
  return { db, store, manager, vivant, evenement };
}

test('D106 : vivants, suivi coupé jusqu’à la reprise, reprise échouée jusqu’au prochain événement', () => {
  const { manager, vivant, evenement } = monter();
  const a1 = vivant('ag_1', 'sd_1');
  const a2 = vivant('ag_2', 'sd_2');
  vivant('ag_3', 'sd_2', true);
  const b1 = vivant('ag_4', 'sd_3');
  expect(manager.resumeServeur('srv_a')).toEqual({
    vivants: 2,
    suiviCoupe: 0,
    repriseEchouee: 0,
    dernierEvenement: null,
    discussion: null,
  });
  const annonces: string[] = [];
  manager.onSuivi = (id) => annonces.push(id);
  evenement(a1, { type: 'connection_lost', at: 'x' });
  evenement(a2, { type: 'resume_failed', reason: 'session introuvable' });
  evenement(b1, { type: 'connection_lost', at: 'x' });
  const r = manager.resumeServeur('srv_a');
  expect(r).toMatchObject({ vivants: 2, suiviCoupe: 1, repriseEchouee: 1 });
  expect(r.dernierEvenement).not.toBeNull();
  expect(['sd_1', 'sd_2']).toContain(r.discussion);
  expect(manager.resumeServeur('srv_b')).toMatchObject({ vivants: 1, suiviCoupe: 1 });
  // un seul appel par changement d'état, avec le serveur de l'agent
  expect(annonces).toEqual(['srv_a', 'srv_a', 'srv_b']);
  // une seconde perte sans reprise : même état, pas de nouvel appel
  evenement(a1, { type: 'connection_lost', at: 'x' });
  expect(annonces).toHaveLength(3);
  // la reprise rend le suivi ; la fin du pilote garde l'échec ; un message le clôt
  evenement(a1, { type: 'connection_resumed', at: 'x', afterMs: 10, sessionFound: true });
  evenement(a2, { type: 'exit', code: 1, signal: null } as ConversationEvent);
  expect(manager.resumeServeur('srv_a')).toMatchObject({ suiviCoupe: 0, repriseEchouee: 1 });
  evenement(a2, { type: 'session', sessionId: 's' } as ConversationEvent);
  expect(manager.resumeServeur('srv_a')).toMatchObject({ suiviCoupe: 0, repriseEchouee: 0 });
});

test('D106 : l’état de connexion porte l’agrégat ; annoncer le renvoie en éphémère', () => {
  const { db, store } = monter();
  const connections = new ServerConnections({ db, store, transport: {} });
  expect(connections.status('srv_a').agents).toBeUndefined();
  connections.suivreAgents((id) => ({
    vivants: id === 'srv_a' ? 2 : 0,
    suiviCoupe: 1,
    repriseEchouee: 0,
    dernierEvenement: null,
    discussion: null,
  }));
  expect(connections.status('srv_a').agents).toMatchObject({ vivants: 2, suiviCoupe: 1 });
  expect(
    connections.statusesRefreshing(Infinity).find((s) => s.serverId === 'srv_b')?.agents?.vivants,
  ).toBe(0);
  const recus: ServerStatus[] = [];
  store.on('ephemeral', (m: { type: string; status?: ServerStatus }) => {
    if (m.type === 'server.status' && m.status) recus.push(m.status);
  });
  connections.annoncer('srv_a');
  connections.annoncer('srv_inconnu');
  expect(recus.map((s) => [s.serverId, s.agents?.vivants])).toEqual([['srv_a', 2]]);
  connections.dispose();
});

test('D110 : la vue d’un agent porte son suivi seulement quand il a lâché', () => {
  const { manager, vivant, evenement } = monter();
  const vue = (id: string) =>
    (manager as unknown as { suiviVue: (id: string) => object }).suiviVue.call(manager, id);
  const a = vivant('ag_1', 'sd_1');
  expect(vue('ag_1')).toEqual({});
  evenement(a, { type: 'connection_lost', at: 'x' });
  expect(vue('ag_1')).toEqual({ suivi: 'coupe' });
  evenement(a, { type: 'resume_failed', reason: 'session introuvable' });
  expect(vue('ag_1')).toEqual({ suivi: 'echec' });
  evenement(a, { type: 'connection_resumed', at: 'x', afterMs: 5, sessionFound: true });
  expect(vue('ag_1')).toEqual({});
});
