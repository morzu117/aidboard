import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { type Db, openDb } from '../src/daemon/db.js';
import { admitAgentEvent } from '../src/daemon/events/admit.js';
import { project } from '../src/daemon/events/projectors.js';
import { EventStore } from '../src/daemon/events/store.js';
import { EVENT_SOURCES, EVENT_TYPES } from '../src/shared/events.js';

// Chantier 12.1 (D36) : `mesh.dm` et `mesh.state`, source `swarph`, projetés dans mesh_inbox et mesh_state.

function setup() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'aid-mesh-')), 'state.db'));
  return { db, store: new EventStore(db) };
}

const dm = (id: number, kind = 'question', extra: Record<string, unknown> = {}) => ({
  id,
  threadId: `th_${id}`,
  from: 'mesh-gw',
  to: 'morzu-mac',
  kind,
  content: `message ${id}`,
  createdAt: `2026-10-20T10:00:${String(id % 60).padStart(2, '0')}+02:00`,
  replyTo: null,
  obligationId: null,
  ...extra,
});

const etat = (over: Record<string, unknown> = {}) => ({
  connected: true,
  tailscale: 'running',
  monitor: 'running',
  pending: 0,
  since: '2026-10-20T10:00:00+02:00',
  cell: 'morzu-mac',
  ...over,
});

test('le schéma connaît la source swarph et les deux types mesh', () => {
  expect(EVENT_SOURCES).toContain('swarph');
  expect(EVENT_TYPES).toContain('mesh.dm');
  expect(EVENT_TYPES).toContain('mesh.state');
  const { db } = setup();
  expect(db.pragma('user_version', { simple: true })).toBe(13);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  expect(tables).toEqual(expect.arrayContaining(['mesh_inbox', 'mesh_state']));
});

test('un mesh.dm rejoué deux fois (deux ULID, même id swarph) ne fait qu’une ligne', () => {
  const { store, db } = setup();
  const a = store.append({ source: 'swarph', type: 'mesh.dm', data: dm(73544) });
  const b = store.append({ source: 'swarph', type: 'mesh.dm', data: dm(73544) });
  expect(a.id).not.toBe(b.id);
  const rows = db.prepare('SELECT * FROM mesh_inbox').all() as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: 73544,
    thread_id: 'th_73544',
    from_node: 'mesh-gw',
    to_node: 'morzu-mac',
    kind: 'question',
    content: 'message 73544',
    created_at: '2026-10-20T10:00:44+02:00',
    reply_to: null,
    obligation_id: null,
    seen_at: null,
    event_id: a.id,
  });
});

test('un DM sans id entier ou d’un kind inconnu n’est pas projeté', () => {
  const { store, db } = setup();
  store.append({ source: 'swarph', type: 'mesh.dm', data: dm(1, 'broadcast') });
  store.append({ source: 'swarph', type: 'mesh.dm', data: { ...dm(2), id: '2' } });
  store.append({ source: 'swarph', type: 'mesh.dm', data: { ...dm(3), id: 3.5 } });
  expect(db.prepare('SELECT COUNT(*) AS n FROM mesh_inbox').get()).toEqual({ n: 0 });
  // les événements, eux, sont bien au journal : le journal est la source de vérité
  expect(store.since(null)).toHaveLength(3);
});

test('mesh.state : le dernier événement l’emporte, champ par champ', () => {
  const { store, db } = setup();
  const lire = () =>
    Object.fromEntries(
      (db.prepare('SELECT k, v FROM mesh_state').all() as { k: string; v: string }[]).map((r) => [
        r.k,
        JSON.parse(r.v) as unknown,
      ]),
    );
  store.append({ source: 'swarph', type: 'mesh.state', data: etat() });
  expect(lire()).toEqual(etat());
  store.append({
    source: 'swarph',
    type: 'mesh.state',
    data: etat({ connected: false, monitor: 'stale', pending: 16, since: null }),
  });
  expect(lire()).toEqual(etat({ connected: false, monitor: 'stale', pending: 16, since: null }));
  // une clé inconnue est ignorée, une clé absente ne touche pas la précédente
  store.append({ source: 'swarph', type: 'mesh.state', data: { pending: 2, bidule: 1 } });
  expect(lire()).toEqual(etat({ connected: false, monitor: 'stale', pending: 2, since: null }));
});

test('reconstruction : rejouer le journal redonne mesh_inbox et mesh_state', () => {
  const { store, db } = setup();
  const kinds = ['fyi', 'status', 'question', 'answer', 'unblock'];
  for (let i = 1; i <= 25; i++) {
    store.append({
      source: 'swarph',
      type: 'mesh.dm',
      data: dm(i, kinds[i % 5], i % 4 === 0 ? { replyTo: i - 1, obligationId: `ob_${i}` } : {}),
    });
    if (i % 5 === 0) store.append({ source: 'swarph', type: 'mesh.dm', data: dm(i) }); // doublon
    if (i % 7 === 0)
      store.append({ source: 'swarph', type: 'mesh.state', data: etat({ pending: i }) });
  }
  const dump = () => ({
    inbox: db.prepare('SELECT * FROM mesh_inbox ORDER BY id').all(),
    state: db.prepare('SELECT * FROM mesh_state ORDER BY k').all(),
  });
  const before = dump();
  expect(before.inbox).toHaveLength(25);
  expect(before.state.find((r) => (r as { k: string }).k === 'pending')).toEqual({
    k: 'pending',
    v: '21',
  });
  db.exec('DELETE FROM mesh_inbox; DELETE FROM mesh_state;');
  for (const e of store.since(null)) project(db, e);
  expect(dump()).toEqual(before);
});

test('un agent ne peut pas émettre un événement mesh : source et type réservés au daemon', () => {
  const { db } = setup();
  seed(db);
  expect(admitAgentEvent(db, { source: 'swarph', type: 'mesh.dm', data: dm(1) }, 'run_1')).toBe(
    'type ou source réservés au daemon',
  );
  expect(
    admitAgentEvent(db, { source: 'hook:claude', type: 'mesh.state', data: etat() }, 'run_1'),
  ).toBe('type ou source réservés au daemon');
});

function seed(db: Db) {
  db.prepare(
    "INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at) VALUES ('ws_1','a','/a','main','/w','t0')",
  ).run();
  db.prepare(
    "INSERT INTO topics VALUES ('tp_1','ws_1','s','T','feat','feat/s','main','/w/s','draft',NULL,'disabled','t0','t0',NULL,NULL,NULL)",
  ).run();
  db.prepare("INSERT INTO runs VALUES ('run_1','tp_1','standard','open','t0')").run();
}
