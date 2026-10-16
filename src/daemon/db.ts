import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type Db = Database.Database;

// Le bundle tsup place ses fichiers à des profondeurs variables : on remonte jusqu'au dossier.
export function findMigrationsDir(from = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'migrations');
    if (existsSync(join(candidate, '001_init.sql'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`dossier migrations introuvable depuis ${from}`);
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
