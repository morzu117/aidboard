import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AidConfig } from './config.js';
import type { Db } from './db.js';
import type { EventStore } from './events/store.js';
import type { AgentManager } from './pty/manager.js';
import { AidHttpError } from './errors.js';
import type { AidPaths } from './paths.js';
import type { UpdateStatus } from './updateCheck.js';
import { WorkspaceQueue } from './actions/queue.js';
import { StructuralService } from './structural/service.js';
import { Indexer } from './topics/index.js';
import { registerTopicRoutes } from './routes/topics.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerFileRoutes } from './routes/files.js';
import { registerHookRoutes } from './routes/hooks.js';
import { registerDaemonRoutes } from './routes/daemon.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerEventRoutes } from './routes/events.js';
import { registerStateRoutes } from './routes/state.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerStructuralRoutes } from './routes/structural.js';
import type { MemoryProposals } from './memory/maintain.js';
import type { MemoryService } from './memory/service.js';
import { type AuthState, registerSecurity, writeSessionToken } from './security.js';
import { registerEventSocket } from './ws/events.js';
import { registerPtySocket } from './ws/pty.js';

export interface ServerDeps {
  config: AidConfig;
  auth: AuthState;
  db: Db;
  store: EventStore;
  agents: AgentManager;
  memory?: MemoryService;
  memoryProposals?: MemoryProposals;
  paths: AidPaths;
  procVersion?: () => string | null;
  structural?: StructuralService;
  /** 08.8 : main.ts le construit pour lancer le rattrapage après `listen` ; sinon un neuf */
  indexer?: Indexer;
  requestStop?: () => void;
  requestUpdate?: () => void;
  requestCycle?: () => void;
  updates?: () => UpdateStatus | null;
  updateError?: () => string | null;
  devOrigin?: string;
  webRoot?: string | null;
  logger?: boolean;
}

export function redactToken(url: string | undefined): string {
  return (url ?? '').replace(/([?&]token=)[^&]*/g, '$1***');
}

// Le bundle place ses chunks dans dist/ ou dist/cli/ : on remonte jusqu'à l'ancêtre nommé « dist ».
// Hors build (dev, tests) il n'y en a pas, et on ne va surtout pas servir web/index.html, le source.
export function webRootFrom(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (basename(dir) === 'dist') {
      const root = join(dir, 'web');
      return existsSync(join(root, 'index.html')) ? root : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function defaultWebRoot(): string | null {
  return webRootFrom(dirname(fileURLToPath(import.meta.url)));
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // le token d'ouverture (/?token=…) ne doit pas finir dans daemon.log
    logger: deps.logger
      ? {
          serializers: {
            req: (r) => ({ method: r.method, url: redactToken(r.url), host: r.headers?.host }),
          },
        }
      : false,
    // refuser un champ inconnu plutôt que de le retirer sans rien dire
    ajv: { customOptions: { removeAdditional: false } },
  });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);
  registerSecurity(app, deps.auth, {
    getPort: () => (app.server.address() as AddressInfo | null)?.port ?? deps.config.port,
    devOrigin: deps.devOrigin,
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AidHttpError)
      return reply.code(err.status).send({ error: err.message, ...err.extra });
    const e = err as { statusCode?: number; message: string };
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ error: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'erreur interne' });
  });
  const structural = deps.structural ?? new StructuralService({ engine: 'codegraph' });
  registerStateRoutes(app, deps.db, deps.store, structural);
  registerDaemonRoutes(app, {
    db: deps.db,
    requestStop: deps.requestStop ?? (() => undefined),
    requestUpdate: deps.requestUpdate,
    requestCycle: deps.requestCycle,
    updates: deps.updates,
    updateError: deps.updateError,
    resetSession: () => {
      deps.auth.sessionToken = writeSessionToken(deps.paths.sessionSecret);
    },
  });
  registerAgentRoutes(app, { db: deps.db, agents: deps.agents });
  registerWorkspaceRoutes(app, { ...deps, engine: structural });
  registerFsRoutes(app);
  registerFileRoutes(app, { db: deps.db });
  registerHookRoutes(app, () => process.env);
  const indexer =
    deps.indexer ??
    new Indexer({
      store: deps.store,
      paths: deps.paths,
      engine: structural,
    });
  app.addHook('onClose', async () => indexer.stop());
  registerTopicRoutes(app, {
    db: deps.db,
    config: deps.config,
    engine: structural,
    actions: { store: deps.store, paths: deps.paths, queue: new WorkspaceQueue() },
    indexer,
  });
  registerStructuralRoutes(app, { db: deps.db, engine: structural, store: deps.store, indexer });
  registerEventRoutes(app, deps.db, deps.store);
  if (deps.memory) {
    registerMemoryRoutes(app, {
      db: deps.db,
      memory: deps.memory,
      proposals: deps.memoryProposals,
    });
  }
  registerEventSocket(app, deps.store);
  registerPtySocket(app, {
    db: deps.db,
    paths: deps.paths,
    config: deps.config,
    agents: deps.agents,
  });
  const webRoot = deps.webRoot === undefined ? defaultWebRoot() : deps.webRoot;
  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((req, reply) => {
      const api = req.url.startsWith('/api') || req.url.startsWith('/ws');
      if (req.method === 'GET' && !api) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'introuvable' });
    });
  }
  return app;
}
