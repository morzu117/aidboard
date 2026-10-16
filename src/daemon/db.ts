import { chmodSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { findAssetDir } from './assets.js';

export type Db = Database.Database;

export function findMigrationsDir(from?: string): string {
  return findAssetDir('migrations', '001_init.sql', from);
}

export function migrate(db: Db, dir = findMigrationsDir()): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 3), 10);
    if (version <= current) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}

export function openDb(path: string, migrationsDir?: string): Db {
  const db = new Database(path);
  // -wal et -shm héritent du mode du fichier principal
  chmodSync(path, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrationsDir);
  return db;
}
