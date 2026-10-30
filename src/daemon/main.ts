import { rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { type AidConfig, loadConfig, writeDefaultConfigIfAbsent } from './config.js';
import { type Db, openDb } from './db.js';
import { ptyPreflight } from './pty/native.js';
import { AgentManager } from './pty/manager.js';
import { purgeOldLogs } from './pty/retention.js';
import { resumeFromManifest } from './pty/reprise.js';
import { replaySpool } from './events/spool.js';
import { EventStore } from './events/store.js';
import { WorkspaceQueue } from './actions/queue.js';
import { type Embedder, ollamaEmbedder, VectorIndex } from './memory/embed.js';
import { MemoryJobs } from './memory/jobs.js';
import {
  type ChatModel,
  MemoryProposals,
  ollamaChatModel,
  runMaintainJob,
  scheduleMaintenance,
} from './memory/maintain.js';
import { MemoryMirror } from './memory/mirror.js';
import { MemoryWorker } from './memory/worker.js';
import { MemoryService } from './memory/service.js';
import { MemoryStore } from './memory/store.js';
import { MeshService } from './mesh/service.js';
import { acquireLock } from './lock.js';
import { ensureHome, resolvePaths } from './paths.js';
import { reconcile } from './reconcile.js';
import { reconcileNamespaces } from './routes/workspaces.js';
import { type AuthState, createAuthState, loadSessionToken } from './security.js';
import { buildServer } from './server.js';
import { StructuralService } from './structural/service.js';
import { Indexer } from './topics/index.js';
import { rattraperIndex } from './topics/rattrapage.js';
import { UpdateWatcher, type WatchStatus } from './updateWatcher.js';
import { installMode } from './install.js';
import { readVersion } from '../cli/version.js';
import type { IndexEngine } from '../shared/structural.js';
import type { TransportOptions } from './remote/transport.js';

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
  /** 12.3 : null quand `mesh.cell` est vide */
  mesh: MeshService | null;
  /** 13.4 : ce que le watcher sait d'une mise à jour (null : rien, ou vérification coupée) */
  updates: () => WatchStatus | null;
  stop(): Promise<void>;
}

export async function startDaemon(
  opts: {
    home?: string;
    config?: Partial<AidConfig>;
    logger?: boolean;
    codegraphBin?: string;
    structuralEngine?: IndexEngine;
    onStopRequested?: () => void;
    onUpdateRequested?: () => void;
    onCycleRequested?: () => void;
    /** Dernier échec d'une mise à jour déclenchée (pull ou build) : `null` si la dernière tentative a réussi ou si aucune n'a encore eu lieu. */
    updateError?: () => string | null;
    /** `git ls-remote origin` en tâche de fond ; coupé dans les tests, pas de réseau à chaque daemon. */
    checkUpdates?: boolean;
    /** Chantier 17 : `ssh` et environnement du transport distant ; les tests passent un faux ssh (D79). */
    remote?: TransportOptions;
    // tests : un Embedder/ChatModel déterministe, des délais courts, un rythme d'entretien rapide
    memory?: {
      embedder?: Embedder;
      backoffMs?: number[];
      pollMs?: number;
      chatModel?: ChatModel;
      maintenanceScheduleMs?: number;
    };
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
    const log = (l: string) => console.error(l);
    const mirror = new MemoryMirror(paths.memory);
    mirror.push = config.memory.git.push;
    await mirror.init();
    const memStore = new MemoryStore(opened);
    const jobs = new MemoryJobs(opened);
    jobs.resetRunning();
    const proposals = new MemoryProposals(opened);
    const embCfg = config.memory.embeddings;
    const embedder =
      opts.memory?.embedder ??
      (embCfg.provider === 'ollama' ? ollamaEmbedder(embCfg.url, embCfg.model, log) : null);
    const vectors = embedder ? VectorIndex.load(opened, log) : null;
    const maintCfg = config.memory.maintenance;
    const chatModel =
      opts.memory?.chatModel ??
      (maintCfg.enabled ? ollamaChatModel(embCfg.url, maintCfg.model) : null);
    let hybridOn = false;
    const worker =
      (embedder && vectors) || chatModel
        ? new MemoryWorker({
            jobs,
            store: memStore,
            vectors: vectors ?? undefined,
            embedder: embedder ?? undefined,
            log,
            backoffMs: opts.memory?.backoffMs,
            pollMs: opts.memory?.pollMs,
            maintain: chatModel
              ? (job) => runMaintainJob(job, { store: memStore, proposals, model: chatModel, log })
              : undefined,
          })
        : null;
    const memory = new MemoryService({
      store: memStore,
      mirror,
      events: store,
      queue: new WorkspaceQueue(),
      log,
      ...(embedder && vectors && { hybrid: { index: vectors, embedder, enabled: () => hybridOn } }),
      onWrite: (slug) => {
        if (!hybridOn) return;
        jobs.enqueue('embed', slug);
        worker?.notify();
      },
      onRemove: (slug) => vectors?.remove(slug),
    });
    if (embedder && vectors) {
      // DM5 : décidé une fois au démarrage, pas de nouvel essai en boucle
      hybridOn = await embedder.ready();
      if (hybridOn) worker?.start();
      else log('ollama injoignable : recherche FTS5 seule');
    }
    let maintenanceTimer: NodeJS.Timeout | null = null;
    if (chatModel) {
      worker?.start();
      const tick = () => {
        const n = scheduleMaintenance(new Date(), {
          store: memStore,
          jobs,
          proposals,
          enabled: maintCfg.enabled,
          window: maintCfg.window,
        });
        if (n > 0) worker?.notify();
      };
      tick();
      maintenanceTimer = setInterval(tick, opts.memory?.maintenanceScheduleMs ?? 15 * 60_000);
      maintenanceTimer.unref();
    }
    let livePort = config.port;
    const auth = createAuthState(loadSessionToken(paths.sessionSecret));
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
    // 13.2 (DR5) : lu une fois, le build ne bouge pas sous un daemon qui tourne
    const install = {
      mode: installMode(dirname(fileURLToPath(import.meta.url)), paths.home),
      version: readVersion(),
    };
    // 13.4 : la stratégie de vérification suit le mode (git ls-remote ou releases GitHub)
    const updates =
      opts.checkUpdates === false
        ? null
        : new UpdateWatcher({
            mode: install.mode,
            from: dirname(fileURLToPath(import.meta.url)),
            version: install.version,
          });
    // config.structural est la source par défaut (08.3) ; codegraphBin/structuralEngine
    // restent des surcharges directes de startDaemon pour les tests (comme codegraphBin
    // le faisait déjà avant que la clé de config existe).
    const structural = new StructuralService({
      engine: opts.structuralEngine ?? config.structural.engine,
      bin: opts.codegraphBin ?? config.structural.bin,
      timeoutMs: config.structural.timeoutMs,
      exclude: config.structural.exclude,
    });
    // 12.3 : le service mesh existe seulement si une cell est configurée (D39) ; jamais de connexion automatique
    const mesh = config.mesh.cell
      ? new MeshService({
          config: config.mesh,
          // le HOME de l'utilisateur (~/.config/swarph, ~/swarph_state), pas AID_HOME
          home: process.env.HOME ?? homedir(),
          db: opened,
          store,
          log,
        })
      : null;
    // 08.8 : construit ici, et non dans buildServer, pour lancer le rattrapage après `listen`
    const indexer = new Indexer({ store, paths, engine: structural });
    const app = await buildServer({
      config,
      auth,
      db: opened,
      store,
      agents,
      memory,
      memoryProposals: proposals,
      paths,
      structural,
      indexer,
      mesh,
      requestStop: opts.onStopRequested,
      requestUpdate: opts.onUpdateRequested,
      requestCycle: opts.onCycleRequested,
      updates: () => updates?.status() ?? null,
      updateError: opts.updateError,
      install: () => install,
      devOrigin,
      remote: opts.remote,
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
    // en tâche de fond : ne bloque jamais le démarrage (même esprit que UpdateWatcher ci-dessus).
    void resumeFromManifest(agents, paths);
    // 08.8 : même esprit — le moteur rattrape chaque sujet en tâche de fond, un à la fois
    void rattraperIndex({ db: opened, store, engine: structural, indexer, log });
    // 12.3 : relit l'état d'un monitor détaché qui aurait survécu, sans le relancer
    void mesh?.init();
    return {
      app,
      port,
      auth,
      db: opened,
      store,
      agents,
      memory,
      mesh,
      updates: () => updates?.status() ?? null,
      async stop() {
        mesh?.dispose();
        await agents.stopAll('daemon_stop', 5000);
        agents.dispose();
        updates?.dispose();
        if (maintenanceTimer) clearInterval(maintenanceTimer);
        await worker?.stop();
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
