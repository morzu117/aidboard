import { AvisMeshService } from './mesh/avis.js';
import { CommitteeReader, CommitteeWriter } from './mesh/committee.js';
import { registerAvisMeshRoutes } from './routes/avis-mesh.js';
import { registerAidRoutes } from './routes/aid.js';
import { SwairmPr } from './swairm/pr.js';
import { SwairmStatut } from './swairm/statut.js';
import { registerEcrituresRoutes } from './routes/ecritures.js';
import { registerSwairmRoutes } from './routes/swairm.js';
import { SwairmAsk } from './swairm/ask.js';
import { creerActionsConfirmation } from './confirmations/actions.js';
import { creerPorte } from './confirmations/porte.js';
import type { LigneDemande } from './pda/file.js';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { LogController } from 'fastify';
import type { AidConfig } from './config.js';
import type { Db } from './db.js';
import type { EventStore } from './events/store.js';
import type { AgentManager } from './pty/manager.js';
import { AidHttpError } from './errors.js';
import type { AidPaths } from './paths.js';
import type { WatchStatus } from './updateWatcher.js';
import type { InstallMode } from '../shared/model.js';
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
import { registerMeshRoutes } from './routes/mesh.js';
import { registerSwarphRoutes } from './routes/swarph.js';
import type { SwarphReader } from './mesh/lectures.js';
import { registerBoardRoutes } from './routes/board.js';
import { registerNavRoutes } from './routes/nav.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerServerDiscussionRoutes } from './routes/serverDiscussions.js';
import { registerMachineRoutes } from './routes/machines.js';
import { type ArtefactsDeps, registerArtefactRoutes } from './routes/artefacts.js';
import type { creerFournisseurClePda } from './pda/cle.js';
import type { FilePda } from './pda/file.js';
import { registerHostRoutes } from './routes/host.js';
import { registerConfirmationRoutes } from './routes/confirmations.js';
import type { TailscaleExec } from './mesh/tailscale.js';
import type { ModeHost } from './host/controleur.js';
import type { RemoteKind } from './remote/agents.js';
import type { TransportOptions } from './remote/transport.js';
import type { MeshService } from './mesh/service.js';
import type { BoardReader } from './mesh/board.js';
import type { MemoryProposals } from './memory/maintain.js';
import type { MemoryService } from './memory/service.js';
import { type AuthState, registerSecurity, writeSessionToken } from './security.js';
import { registerAgentSocket } from './ws/agent.js';
import { registerServerAgentSocket } from './ws/serverAgent.js';
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
  updates?: () => WatchStatus | null;
  updateError?: () => string | null;
  /** 13.2 : mode d'installation et version du build (DR5) ; absent dans les tests de routes */
  install?: () => { mode: InstallMode; version: string };
  /** 12.4 : null ou absent = mesh désactivé, les routes /api/mesh répondent 404 */
  mesh?: MeshService | null;
  /** chantier 24 : null ou absent = mesh désactivé, les routes /api/board répondent 404 */
  board?: BoardReader | null;
  swarph?: SwarphReader | null;
  swairmAsk?: SwairmAsk;
  devOrigin?: string;
  /** Chantier 17 : binaire `ssh` et environnement du transport distant ; un faux ssh en test (D79). */
  remote?: TransportOptions;
  /** Chantier 17 (R.4) : binaire de chaque agent sur le serveur ; défaut son nom. Les tests y mettent les faux. */
  remoteBins?: Partial<Record<RemoteKind, string>>;
  webRoot?: string | null;
  logger?: boolean;
  /** chantier 30 : les jetons et l'état du second port ; absent = artefacts indisponibles */
  artefacts?: ArtefactsDeps;
  /** chantier 31 (D173) : l'exécution de `tailscale`, remplacée en test ; absent = le vrai binaire */
  tailscaleExec?: TailscaleExec;
  /** chantier 31 (D172) : le port des appareils ; absent = pas de route du mode host */
  modeHost?: ModeHost;
  clePda?: ReturnType<typeof creerFournisseurClePda>;
  pda?: {
    obtenir: () => FilePda | null;
    pourAnnulation?: () => FilePda | null;
    synchroniser: () => Promise<void>;
    lierExecuteur?: (
      executer: (ligne: LigneDemande) => Promise<void>,
      preparer: (ligne: LigneDemande) => Promise<() => void>,
    ) => void;
  };
  /** chantier 31 (D174), tests : chaque route déclarée sur le port du Mac */
  onRoute?: (r: { method: string | string[]; url: string }) => void;
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
    // deux lignes par requête, dont le sondage de /api/state chaque seconde : daemon.log avait atteint
    // 378 Mo (2026-10-29). Seules les requêtes en échec restent journalisées (hook onResponse ci-dessous).
    logController: new LogController({ disableRequestLogging: true }),
    // refuser un champ inconnu plutôt que de le retirer sans rien dire
    ajv: { customOptions: { removeAdditional: false } },
  });
  if (deps.onRoute) {
    const f = deps.onRoute;
    app.addHook('onRoute', (r) => f({ method: r.method, url: r.url }));
  }
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 400)
      req.log.warn(
        { req, statusCode: reply.statusCode, responseTime: reply.elapsedTime },
        'request failed',
      );
  });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);
  registerSecurity(app, deps.auth, {
    getPort: () => (app.server.address() as AddressInfo | null)?.port ?? deps.config.port,
    devOrigin: deps.devOrigin,
    getArtefactsPort: () => {
      const e = deps.artefacts?.etat();
      return e?.disponible ? e.port : null;
    },
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
  registerStateRoutes(
    app,
    deps.db,
    deps.store,
    structural,
    deps.mesh ?? null,
    !!deps.config.swairm.bin,
    deps.config.agents.transport,
  );
  registerMeshRoutes(app, { mesh: deps.mesh ?? null });
  registerBoardRoutes(app, { board: deps.board ?? null });
  registerAidRoutes(app, deps.db, deps.board ?? null, deps.config.mesh.cell);
  registerSwarphRoutes(app, { swarph: deps.swarph ?? null });
  registerSwairmRoutes(
    app,
    deps.swairmAsk ?? new SwairmAsk(deps.config.swairm.bin),
    deps.board ?? null,
    new SwairmStatut(deps.config.swairm.bin),
    deps.db,
    new SwairmPr(deps.config.github.bin),
  );
  registerDaemonRoutes(app, {
    db: deps.db,
    requestStop: deps.requestStop ?? (() => undefined),
    requestUpdate: deps.requestUpdate,
    requestCycle: deps.requestCycle,
    updates: deps.updates,
    updateError: deps.updateError,
    install: deps.install,
    resetSession: () => {
      deps.auth.sessionToken = writeSessionToken(deps.paths.sessionSecret);
    },
  });
  registerAgentRoutes(app, { db: deps.db, agents: deps.agents, store: deps.store });
  const actionsConfirmation = { store: deps.store, paths: deps.paths, queue: new WorkspaceQueue() };
  const committee =
    deps.mesh && deps.config.mesh.cell
      ? { mesh: deps.mesh, cell: deps.config.mesh.cell, proxySocket: deps.config.mesh.proxySocket }
      : null;
  const avis = committee
    ? new AvisMeshService({
        db: deps.db,
        config: deps.config.mesh,
        lecteur: new CommitteeReader(committee),
        ecrivain: new CommitteeWriter(committee),
      })
    : undefined;
  const porte = creerPorte({
    db: deps.db,
    actions: creerActionsConfirmation({
      ...deps,
      avis,
      journal: (type, donnees) => app.log.info(donnees, type),
      actions: actionsConfirmation,
      engine: structural,
    }),
    file: () => deps.pda?.obtenir() ?? null,
    signaler: () => deps.pda?.obtenir()?.signaler(),
  });
  registerAvisMeshRoutes(app, { avis: avis ?? null, porte });
  registerEcrituresRoutes(app, {
    db: deps.db,
    board: deps.board ?? null,
    cell: deps.config.mesh.cell,
    porte,
    proxySocket: deps.config.mesh.proxySocket,
    proxyLectureSeule: deps.config.mesh.proxyLectureSeule,
  });
  deps.pda?.lierExecuteur?.(
    (ligne) => porte.executerConfirmee(ligne),
    (ligne) => porte.preparerConsommation(ligne),
  );
  registerWorkspaceRoutes(app, { ...deps, engine: structural, porte });
  registerNavRoutes(app, { db: deps.db });
  const connections = registerServerRoutes(app, {
    db: deps.db,
    store: deps.store,
    remote: deps.remote,
  });
  const serverAgents = registerServerDiscussionRoutes(app, {
    db: deps.db,
    transport: deps.remote ?? {},
    bins: deps.remoteBins,
  });
  // chantier 25 (D106) : l'état de connexion de chaque serveur porte l'agrégat de ses agents
  connections.suivreAgents((id) => serverAgents.resumeServeur(id));
  serverAgents.onSuivi = (id) => connections.annoncer(id);
  registerMachineRoutes(app, {
    config: deps.config,
    agents: deps.agents,
    db: deps.db,
    connections,
  });
  registerFsRoutes(app);
  registerFileRoutes(app, { db: deps.db });
  registerConfirmationRoutes(
    app,
    deps.db,
    porte,
    () => deps.pda?.pourAnnulation?.() ?? deps.pda?.obtenir() ?? null,
  );
  registerArtefactRoutes(app, { db: deps.db, artefacts: deps.artefacts });
  if (deps.modeHost) {
    registerHostRoutes(app, {
      config: deps.config,
      paths: deps.paths,
      getPort: () => (app.server.address() as AddressInfo | null)?.port ?? deps.config.port,
      modeHost: deps.modeHost,
      clePda: deps.clePda,
      pda: deps.pda,
      db: deps.db,
      porte,
      tailscaleExec: deps.tailscaleExec,
    });
  }
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
    actions: actionsConfirmation,
    porte,
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
  registerAgentSocket(app, { db: deps.db, agents: deps.agents });
  registerServerAgentSocket(app, { db: deps.db, agents: serverAgents });
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
