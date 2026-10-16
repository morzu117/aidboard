import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DaemonHandle, startDaemon } from '../../src/daemon/main.js';
import type { AidConfig } from '../../src/daemon/config.js';
import type { Db } from '../../src/daemon/db.js';
import type { EventStore } from '../../src/daemon/events/store.js';

export interface TestDaemon {
  d: DaemonHandle;
  home: string;
  headers: Record<string, string>;
  db: Db;
  store: EventStore;
}

// Vrai daemon, AID_HOME temporaire, port éphémère, authentifié en Bearer.
export async function startTestDaemon(
  home = mkdtempSync(join(tmpdir(), 'aid-d-')),
  extra: { codegraphBin?: string; config?: Partial<AidConfig> } = {},
): Promise<TestDaemon> {
  const d = await startDaemon({
    home,
    codegraphBin: extra.codegraphBin,
    config: { port: 0, ...extra.config },
  });
  const headers = { host: `127.0.0.1:${d.port}`, authorization: `Bearer ${d.auth.adminToken}` };
  return { d, home, headers, db: d.db, store: d.store };
}

export function seedTopic(db: Db): void {
  db.prepare(
    "INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at) VALUES ('ws_1','a','/a','main','/w','t0')",
  ).run();
  db.prepare(
    "INSERT INTO topics VALUES ('tp_1','ws_1','s','T','feat','feat/s','main','/definitely/missing','active',NULL,'disabled','t0','t0')",
  ).run();
  db.prepare("INSERT INTO runs VALUES ('run_1','tp_1','standard','open','t0')").run();
  db.prepare(
    "INSERT INTO agents (id, run_id, kind, role, transport, status, cwd, command, pid, exit_code, issue, created_at, updated_at) VALUES ('ag_1','run_1','shell','free','pty','starting','/w/s','[\"sh\"]',NULL,NULL,NULL,'t0','t0')",
  ).run();
}

export function waitFor<T>(
  check: () => T | undefined | false,
  timeoutMs = 15_000,
  what = 'condition',
): Promise<T> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error(`délai dépassé : ${what}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}
