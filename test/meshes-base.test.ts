import { mkdtempSync, readdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { migrate, type Db } from '../src/daemon/db.js';
import { activerMesh, archiverMesh } from '../src/daemon/mesh/identite.js';
import { EventStore } from '../src/daemon/events/store.js';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { MeshService } from '../src/daemon/mesh/service.js';
import { propositionsAid, creerReleveAid } from '../src/daemon/aid/propositions.js';
import { propositionsSwairm } from '../src/daemon/swairm/propositions.js';

const lignes = {
  mesh_inbox: {
    id: 1,
    thread_id: 'principal',
    from_node: 'principal',
    to_node: 'perso',
    kind: 'question',
    content: 'exemple',
    created_at: '2026-11-12',
    reply_to: 2,
    obligation_id: 'exemple',
    seen_at: '2026-11-12',
    event_id: 'exemple',
    decided_at: '2026-11-12',
  },
  mesh_state: { k: 'since', v: '"2026-11-12"' },
  aid_etats: { sujet: 'principal', carte: 1, phase: 'review', etat: 'active', pr: 2 },
  aid_propositions: {
    id: 1,
    sujet: 'principal',
    carte: 1,
    etape: 'review',
    cree_a: '2026-11-12',
    fermee_a: null,
    confirmation: 'exemple',
  },
  swairm_propositions: {
    id: 1,
    projet: 'principal',
    sujet: 'principal',
    etat: 'merged',
    titre: 'exemple',
    carte: 1,
    cree_a: '2026-11-12',
    fermee_a: null,
    confirmation: 'exemple',
  },
  avis_mesh: {
    id: 'principal',
    question: 'exemple',
    sieges: '[]',
    carte: 1,
    canal: 'principal',
    motion: 2,
    jeton: 'exemple',
    date: '2026-11-12',
    etat: 'ouverte',
    confirmation: 'exemple',
    erreur: null,
    echeances: '{}',
  },
};
type Table = keyof typeof lignes;
const tables = Object.keys(lignes) as Table[];
const bases: Db[] = [];
const dossiers: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of bases.splice(0)) db.close();
  for (const dir of dossiers.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function base() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bases.push(db);
  return db;
}
function inserer(db: Db, table: Table, ligne: Record<string, unknown>) {
  db.prepare(
    `INSERT INTO ${table} (${Object.keys(ligne).join(', ')}) VALUES (${Object.keys(ligne)
      .map(() => '?')
      .join(', ')})`,
  ).run(...Object.values(ligne));
}
function peupler(db: Db, mesh: string) {
  for (const table of tables) inserer(db, table, { ...lignes[table], mesh });
}

test('migration 029 peuplée : préserve toutes les colonnes et sépare les identifiants par mesh', () => {
  const db = base();
  const dir = mkdtempSync(join(tmpdir(), 'aid-migrations-029-'));
  dossiers.push(dir);
  const migrations = join(import.meta.dirname, '../migrations');
  for (const fichier of readdirSync(migrations).filter(
    (f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= 29,
  ))
    copyFileSync(join(migrations, fichier), join(dir, fichier));
  migrate(db, dir);
  expect(db.pragma('user_version', { simple: true })).toBe(29);
  for (const table of tables) inserer(db, table, lignes[table]);
  migrate(db);
  expect(db.pragma('user_version', { simple: true })).toBe(30);
  for (const table of tables)
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([
      { ...lignes[table], mesh: 'principal' },
    ]);
  expect(db.prepare('SELECT * FROM meshes_connus').all()).toEqual([]);
  inserer(db, 'mesh_inbox', { ...lignes.mesh_inbox, mesh: 'perso' });
  inserer(db, 'mesh_state', { ...lignes.mesh_state, mesh: 'perso' });
  inserer(db, 'aid_etats', { ...lignes.aid_etats, mesh: 'perso' });
  expect(db.prepare('SELECT mesh, id FROM mesh_inbox ORDER BY mesh').all()).toEqual([
    { mesh: 'perso', id: 1 },
    { mesh: 'principal', id: 1 },
  ]);
  expect(() => inserer(db, 'mesh_inbox', { ...lignes.mesh_inbox, mesh: 'principal' })).toThrow(
    'UNIQUE constraint failed',
  );
  // Les ids locaux restent globaux, les index de proposition ouverte portent désormais le mesh.
  for (const table of ['aid_propositions', 'swairm_propositions'] as const) {
    inserer(db, table, { ...lignes[table], id: 2, mesh: 'perso' });
    expect(() => inserer(db, table, { ...lignes[table], id: 3, mesh: 'perso' })).toThrow(
      'UNIQUE constraint failed',
    );
  }
  migrate(db);
  expect(db.prepare('SELECT COUNT(*) AS n FROM mesh_inbox').get()).toEqual({ n: 2 });
});

test.each(tables)('%s : mesh obligatoire et sans défaut', (table) => {
  const db = base();
  migrate(db);
  const colonne = (
    db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      notnull: number;
      dflt_value: unknown;
    }[]
  ).find((c) => c.name === 'mesh');
  expect(colonne).toMatchObject({ notnull: 1, dflt_value: null });
  expect(() => inserer(db, table, lignes[table])).toThrow(
    `NOT NULL constraint failed: ${table}.mesh`,
  );
  inserer(db, table, { ...lignes[table], mesh: 'principal' });
});

test('activerMesh : nouveau, connu rafraîchi, rebranché sans aucune modification', () => {
  const db = base();
  migrate(db);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
  expect(activerMesh(db, 'principal', 'exemple')).toBe('nouveau');
  expect(db.prepare('SELECT * FROM meshes_connus').get()).toEqual({
    nom: 'principal',
    empreinte: 'exemple',
    vu_a: '2026-11-12T10:00:00.000Z',
  });
  vi.setSystemTime(new Date('2026-11-12T11:00:00Z'));
  expect(activerMesh(db, 'principal', 'exemple')).toBe('connu');
  const avant = db.prepare('SELECT * FROM meshes_connus').all();
  expect(avant).toEqual([
    { nom: 'principal', empreinte: 'exemple', vu_a: '2026-11-12T11:00:00.000Z' },
  ]);
  const changements = db.prepare('SELECT total_changes() AS n').get();
  vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
  expect(activerMesh(db, 'principal', 'autre')).toBe('rebranche');
  expect(db.prepare('SELECT * FROM meshes_connus').all()).toEqual(avant);
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changements);
});

test('archiverMesh : les six tables changent de nom, les données et les autres meshes sont gardés', () => {
  const db = base();
  migrate(db);
  peupler(db, 'principal');
  inserer(db, 'mesh_inbox', { ...lignes.mesh_inbox, mesh: 'perso' });
  activerMesh(db, 'principal', 'exemple');
  activerMesh(db, 'perso', 'autre');
  archiverMesh(db, 'principal', '2026-11-12');
  for (const table of tables) {
    expect(
      db.prepare(`SELECT * FROM ${table} WHERE mesh = ?`).all('principal@archive-2026-11-12'),
    ).toEqual([{ ...lignes[table], mesh: 'principal@archive-2026-11-12' }]);
    expect(db.prepare(`SELECT * FROM ${table} WHERE mesh = 'principal'`).all()).toEqual([]);
  }
  expect(db.prepare("SELECT * FROM mesh_inbox WHERE mesh = 'perso'").all()).toEqual([
    { ...lignes.mesh_inbox, mesh: 'perso' },
  ]);
  expect(db.prepare('SELECT nom FROM meshes_connus').all()).toEqual([{ nom: 'perso' }]);
  expect(activerMesh(db, 'principal', 'nouvelle')).toBe('nouveau');
  expect(propositionsAid(db)).toEqual([]);
  expect(propositionsSwairm(db)).toEqual([]);
});

test('archiverMesh : une collision de clé annule la transaction entière', () => {
  const db = base();
  migrate(db);
  peupler(db, 'principal');
  inserer(db, 'mesh_state', { ...lignes.mesh_state, mesh: 'principal@archive-2026-11-12' });
  activerMesh(db, 'principal', 'exemple');
  expect(() => archiverMesh(db, 'principal', '2026-11-12')).toThrow('UNIQUE constraint failed');
  for (const table of tables)
    expect(db.prepare(`SELECT mesh FROM ${table} WHERE mesh = 'principal'`).all()).toEqual([
      { mesh: 'principal' },
    ]);
  expect(db.prepare('SELECT nom FROM meshes_connus').all()).toEqual([{ nom: 'principal' }]);
});

test('événements anciens : principal par défaut ; événements nommés : projections séparées', () => {
  const db = base();
  migrate(db);
  const store = new EventStore(db);
  const dm = { id: 1, from: 'principal', to: 'perso', kind: 'question', content: 'exemple' };
  store.append({ source: 'swarph', type: 'mesh.dm', data: dm });
  store.append({ source: 'swarph', type: 'mesh.dm', data: { ...dm, mesh: 'perso' } });
  store.append({ source: 'swarph', type: 'mesh.state', data: { pending: 1 } });
  store.append({ source: 'swarph', type: 'mesh.state', data: { pending: 2, mesh: 'perso' } });
  store.append({ source: 'swarph', type: 'mesh.state', data: { pending: 3, mesh: 'perso' } });
  expect(db.prepare('SELECT mesh, id FROM mesh_inbox ORDER BY mesh').all()).toEqual([
    { mesh: 'perso', id: 1 },
    { mesh: 'principal', id: 1 },
  ]);
  expect(db.prepare('SELECT * FROM mesh_state ORDER BY mesh').all()).toEqual([
    { mesh: 'perso', k: 'pending', v: '3' },
    { mesh: 'principal', k: 'pending', v: '1' },
  ]);
  const service = new MeshService({
    db,
    store,
    config: { ...DEFAULT_CONFIG.mesh, cell: 'principal' },
    home: '/tmp/principal',
    log: () => {},
  });
  expect(service.inbox()).toHaveLength(1);
  expect(service.markSeen(1)).not.toBeNull();
  expect(service.markDecision(1)).not.toBeNull();
  expect(
    db.prepare("SELECT seen_at, decided_at FROM mesh_inbox WHERE mesh = 'perso'").get(),
  ).toEqual({ seen_at: null, decided_at: null });
  // Le nettoyage du relevé principal ne doit pas effacer les états des autres meshes.
  inserer(db, 'aid_etats', { ...lignes.aid_etats, mesh: 'perso' });
  creerReleveAid(
    db,
    'principal',
  )({
    board: { ok: true, data: { cards: [], searched: 0 }, readAt: '', schemaVersion: null },
    erreurs: [],
    cartes: [],
    sujets: [],
  });
  expect(db.prepare("SELECT mesh FROM aid_etats WHERE mesh = 'perso'").all()).toEqual([
    { mesh: 'perso' },
  ]);
});

test('le service émet mesh.dm et mesh.state avec mesh principal', async () => {
  const db = base();
  migrate(db);
  const home = mkdtempSync(join(tmpdir(), 'aid-mesh-evenements-'));
  dossiers.push(home);
  const inboxLog = join(home, 'inbox.log');
  writeFileSync(
    inboxLog,
    JSON.stringify({
      id: 1,
      kind: 'question',
      from_node: 'perso',
      to_node: 'principal',
      content: 'exemple',
    }) + '\n',
  );
  const store = new EventStore(db);
  const service = new MeshService({
    db,
    store,
    config: { ...DEFAULT_CONFIG.mesh, cell: 'principal', inboxLog },
    home,
    log: () => {},
    tailscale: async () => 'running',
  });
  try {
    await service.init();
    for (const type of ['mesh.dm', 'mesh.state']) {
      const evenements = store.since(null).filter((e) => e.type === type);
      expect(evenements).toHaveLength(1);
      expect(evenements[0]!.data.mesh).toBe('principal');
    }
  } finally {
    service.dispose();
  }
});
