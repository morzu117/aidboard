import { rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { type AidConfig, loadConfig, writeDefaultConfigIfAbsent } from './config.js';
import { type Db, openDb } from './db.js';
import { EventStore } from './events/store.js';
import { acquireLock } from './lock.js';
import { ensureHome, resolvePaths } from './paths.js';
import { reconcile } from './reconcile.js';
import { type AuthState, createAuthState } from './security.js';
import { buildServer } from './server.js';

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
  stop(): Promise<void>;
}

export async function startDaemon(
  opts: { home?: string; config?: Partial<AidConfig>; logger?: boolean } = {},
): Promise<DaemonHandle> {
  const paths = resolvePaths(opts.home);
  ensureHome(paths);
  const lock = acquireLock(paths);
  let db: Db | undefined;
  try {
    writeDefaultConfigIfAbsent(paths);
    const config = { ...loadConfig(paths), ...opts.config };
    const opened = openDb(paths.db);
    db = opened;
    const store = new EventStore(opened);
    reconcile(opened, store);
    const auth = createAuthState();
    const devOrigin = process.env.AID_DEV_ORIGIN;
    if (devOrigin) console.error(`AID_DEV_ORIGIN actif : ${devOrigin} accepté comme origine`);
    const app = await buildServer({
      config,
      auth,
      db: opened,
      store,
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
      async stop() {
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
