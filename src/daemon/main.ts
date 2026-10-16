import { rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { type AidConfig, loadConfig, writeDefaultConfigIfAbsent } from './config.js';
import { type Db, openDb } from './db.js';
import { ptyPreflight } from './pty/native.js';
import { AgentManager } from './pty/manager.js';
import { purgeOldLogs } from './pty/retention.js';
import { replaySpool } from './events/spool.js';
import { EventStore } from './events/store.js';
import { WorkspaceQueue } from './actions/queue.js';
import { MemoryMirror } from './memory/mirror.js';
import { MemoryService } from './memory/service.js';
import { MemoryStore } from './memory/store.js';
import { acquireLock } from './lock.js';
import { ensureHome, resolvePaths } from './paths.js';
import { reconcile } from './reconcile.js';
import { reconcileNamespaces } from './routes/workspaces.js';
import { type AuthState, createAuthState } from './security.js';
import { buildServer } from './server.js';
import { UpdateWatcher } from './updateWatcher.js';

export class AidPortInUse extends Error {
  constructor(port: number) {
    super(`port ${port} occupé : changer \`port\` dans ~/.aid/config.yaml`);
  }
}

export interface DaemonHandle {
  app: FastifyInstance;
  port: number;
  auth: AuthState;
  db: Db;
  store: EventStore;
  agents: AgentManager;
  memory: MemoryService;
  stop(): Promise<void>;
}

export async function startDaemon(
  opts: {
    home?: string;
    config?: Partial<AidConfig>;
    logger?: boolean;
    codegraphBin?: string;
    onStopRequested?: () => void;
    onUpdateRequested?: () => void;
    /** `git ls-remote origin` en tâche de fond ; coupé dans les tests, pas de réseau à chaque daemon. */
    checkUpdates?: boolean;
  } = {},
): Promise<DaemonHandle> {
  const paths = resolvePaths(opts.home);
  ensureHome(paths);
  const lock = acquireLock(paths);
  let db: Db | undefined;
  try {
    writeDefaultConfigIfAbsent(paths);
    const config = { ...loadConfig(paths), ...opts.config };
    purgeOldLogs(paths, config.terminal.logRetentionDays);
    const opened = openDb(paths.db);
    db = opened;
    const store = new EventStore(opened);
    reconcile(opened, store);
    // après la réconciliation : un statut d'un agent d'avant le redémarrage est journalisé, sans le ressusciter
    const spool = replaySpool(paths.spool, opened, store);
    if (spool.rejected > 0)
      console.error(
        `spool : ${spool.rejected} événement(s) refusé(s), gardés dans ${paths.spool}/rejet`,
      );
    reconcileNamespaces(opened, (l) => console.error(l));
    await ptyPreflight();
    const mirror = new MemoryMirror(paths.memory);
    await mirror.init();
    const memory = new MemoryService({
      store: new MemoryStore(opened),
      mirror,
      events: store,
      queue: new WorkspaceQueue(),
      log: (l) => console.error(l),
    });
    let livePort = config.port;
    const auth = createAuthState();
    const agents = new AgentManager({
      store,
      db: opened,
      paths,
      config,
      auth,
      port: () => livePort,
    });
    const devOrigin = process.env.AID_DEV_ORIGIN;
    if (devOrigin) console.error(`AID_DEV_ORIGIN actif : ${devOrigin} accepté comme origine`);
    const updates =
      opts.checkUpdates === false
        ? null
        : new UpdateWatcher(dirname(fileURLToPath(import.meta.url)));
    const app = await buildServer({
      config,
      auth,
      db: opened,
      store,
      agents,
      memory,
      paths,
      codegraphBin: opts.codegraphBin,
      requestStop: opts.onStopRequested,
      requestUpdate: opts.onUpdateRequested,
      updates: () => updates?.status() ?? null,
      devOrigin,
      logger: opts.logger,
    });
    try {
      await app.listen({ host: config.host, port: config.port });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new AidPortInUse(config.port);
      throw err;
    }
    const port = (app.server.address() as AddressInfo).port;
    livePort = port;
    writeFileSync(
      paths.daemonJson,
      JSON.stringify({
        pid: process.pid,
        port,
        token: auth.adminToken,
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    return {
      app,
      port,
      auth,
      db: opened,
      store,
      agents,
      memory,
      async stop() {
        await agents.stopAll('daemon_stop', 5000);
        agents.dispose();
        updates?.dispose();
        await mirror.flush();
        await app.close();
        opened.close();
        rmSync(paths.daemonJson, { force: true });
        lock.release();
      },
    };
  } catch (err) {
    db?.close();
    lock.release();
    throw err;
  }
}
