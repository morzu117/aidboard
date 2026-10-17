import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DaemonHandle, startDaemon } from '../../src/daemon/main.js';
import type { AidConfig } from '../../src/daemon/config.js';
import type { Db } from '../../src/daemon/db.js';
import type { EventStore } from '../../src/daemon/events/store.js';
import type { Embedder } from '../../src/daemon/memory/embed.js';
import type { ChatModel } from '../../src/daemon/memory/maintain.js';
import type { IndexEngine } from '../../src/shared/structural.js';

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
  extra: {
    codegraphBin?: string;
    structuralEngine?: IndexEngine;
    config?: Partial<AidConfig>;
    memory?: {
      embedder?: Embedder;
      backoffMs?: number[];
      pollMs?: number;
      chatModel?: ChatModel;
      maintenanceScheduleMs?: number;
    };
  } = {},
): Promise<TestDaemon> {
  const d = await startDaemon({
    home,
    codegraphBin: extra.codegraphBin,
    // Piège du chantier 08 : jamais le vrai codegraph en test. Depuis 08.6, /api/state
    // interroge le moteur pour chaque sujet (DS7) ; un test qui ne précise ni l'un ni
    // l'autre hériterait sinon du moteur réel de config.structural (installé sur ce poste).
    structuralEngine: extra.structuralEngine ?? (extra.codegraphBin ? undefined : 'off'),
    memory: extra.memory,
    config: {
      port: 0,
      // Même piège que structuralEngine ci-dessus, côté memory : un test qui ne précise
      // ni embedder ni config.memory hériterait sinon du vrai Ollama, installé et lancé
      // sur ce poste (config.ts par défaut : provider 'ollama'). 'off' tant que le test
      // ne demande pas explicitement les vecteurs.
      memory: {
        embeddings: { provider: 'off', model: 'bge-m3', url: 'http://127.0.0.1:11434' },
        maintenance: { enabled: false, model: 'qwen3:8b', window: '02:00-06:00' },
        git: { push: false },
      },
      ...extra.config,
    },
    checkUpdates: false,
  });
  const headers = { host: `127.0.0.1:${d.port}`, authorization: `Bearer ${d.auth.adminToken}` };
  return { d, home, headers, db: d.db, store: d.store };
}

export function seedTopic(db: Db): void {
  db.prepare(
    "INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at) VALUES ('ws_1','a','/a','main','/w','t0')",
  ).run();
  db.prepare(
    "INSERT INTO topics VALUES ('tp_1','ws_1','s','T','feat','feat/s','main','/definitely/missing','active',NULL,'disabled','t0','t0',NULL,NULL,NULL)",
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
