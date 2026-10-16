import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { openDb } from '../src/daemon/db.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'aid-db-'));

test('une base neuve est migrée en version 1', () => {
  const db = openDb(join(tmp(), 'state.db'));
  expect(db.pragma('user_version', { simple: true })).toBe(1);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  db.close();
});

test('la réouverture ne ré-applique rien et garde les données', () => {
  const path = join(tmp(), 'state.db');
  const db = openDb(path);
  db.prepare("INSERT INTO workspaces VALUES ('ws_1','a','/a','main','/w','t')").run();
  db.close();
  const again = openDb(path);
  expect(again.prepare('SELECT count(*) c FROM workspaces').get()).toEqual({ c: 1 });
  expect(again.pragma('user_version', { simple: true })).toBe(1);
  again.close();
});

test('les contraintes CHECK refusent un état inconnu', () => {
  const db = openDb(join(tmp(), 'state.db'));
  db.prepare("INSERT INTO workspaces VALUES ('ws_1','a','/a','main','/w','t')").run();
  const insert = (state: string) =>
    db
      .prepare(
        "INSERT INTO topics VALUES ('tp_1','ws_1','s','T','feat','feat/s','main','/w/s',?,NULL,'disabled','t','t')",
      )
      .run(state);
  expect(() => insert('foo')).toThrow(/CHECK/);
  expect(() => insert('active')).not.toThrow();
  db.close();
});

test('les clés étrangères sont appliquées', () => {
  const db = openDb(join(tmp(), 'state.db'));
  expect(() =>
    db.prepare("INSERT INTO runs VALUES ('run_1','tp_absent','standard','open','t')").run(),
  ).toThrow(/FOREIGN KEY/);
  db.close();
});

test('une migration suivante ne s’applique que si sa version est plus haute', () => {
  const dir = tmp();
  const migs = join(dir, 'migrations');
  mkdirSync(migs);
  writeFileSync(join(migs, '001_init.sql'), 'CREATE TABLE a (x INTEGER);');
  writeFileSync(join(migs, '002_plus.sql'), 'CREATE TABLE b (y INTEGER);');
  const path = join(dir, 's.db');
  const db = openDb(path, migs);
  expect(db.pragma('user_version', { simple: true })).toBe(2);
  db.close();
  expect(() => openDb(path, migs).close()).not.toThrow();
});

test('une migration qui échoue ne laisse rien et ne change pas la version', () => {
  const dir = tmp();
  const migs = join(dir, 'migrations');
  mkdirSync(migs);
  writeFileSync(
    join(migs, '001_init.sql'),
    'CREATE TABLE a (x INTEGER); CREATE TABLE a (x INTEGER);',
  );
  const path = join(dir, 's.db');
  expect(() => openDb(path, migs)).toThrow();
  const db = new Database(path);
  expect(db.pragma('user_version', { simple: true })).toBe(0);
});

test('le fichier de base est en 0600, wal compris', () => {
  const path = join(tmp(), 'state.db');
  const db = openDb(path);
  db.prepare("INSERT INTO workspaces VALUES ('ws_1','a','/a','main','/w','t')").run();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
  db.close();
});
