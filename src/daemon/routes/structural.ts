import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { StructuralUnavailable } from '../../shared/structural.js';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';
import { AidHttpError } from '../errors.js';
import type { Principal } from '../security.js';
import type { StructuralService } from '../structural/service.js';
import type { Indexer } from '../topics/index.js';

const AffectedBody = Type.Object(
  { files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) },
  { additionalProperties: false },
);

export interface StructuralRouteDeps {
  db: Db;
  engine: StructuralService;
  store: EventStore;
  indexer: Indexer;
}

interface Scope {
  root: string;
  workspaceId: string;
  topicId: string | null;
}

interface OwnTopicRow {
  topic_id: string;
  workspace_id: string;
  worktree: string;
}

// DS2 : un token de run ne résout jamais que son propre sujet, qu'il le nomme ou pas en query —
// même pattern que runWriteContext (routes/memory.ts) : Principal + base, pas de confiance en query.
function ownTopic(db: Db, runId: string): OwnTopicRow {
  const row = db
    .prepare(
      `SELECT t.id AS topic_id, t.workspace_id AS workspace_id, t.worktree AS worktree
       FROM runs r JOIN topics t ON t.id = r.topic_id WHERE r.id = ?`,
    )
    .get(runId) as OwnTopicRow | undefined;
  if (!row) throw new AidHttpError(403, 'run inconnu');
  return row;
}

function resolveScope(
  db: Db,
  principal: Principal,
  query: { topic?: string; workspace?: string },
): Scope {
  if (principal.kind === 'run') {
    const own = ownTopic(db, principal.runId);
    if (query.topic !== undefined && query.topic !== own.topic_id) {
      throw new AidHttpError(403, 'sujet étranger');
    }
    if (query.workspace !== undefined && query.workspace !== own.workspace_id) {
      throw new AidHttpError(403, 'sujet étranger');
    }
    return { root: own.worktree, workspaceId: own.workspace_id, topicId: own.topic_id };
  }
  if (query.topic !== undefined) {
    const row = db
      .prepare('SELECT id, workspace_id, worktree FROM topics WHERE id = ?')
      .get(query.topic) as { id: string; workspace_id: string; worktree: string } | undefined;
    if (!row) throw new AidHttpError(404, 'sujet inconnu');
    return { root: row.worktree, workspaceId: row.workspace_id, topicId: row.id };
  }
  if (query.workspace !== undefined) {
    const row = db.prepare('SELECT id, root FROM workspaces WHERE id = ?').get(query.workspace) as
      { id: string; root: string } | undefined;
    if (!row) throw new AidHttpError(404, 'workspace inconnu');
    return { root: row.root, workspaceId: row.id, topicId: null };
  }
  throw new AidHttpError(400, 'topic ou workspace requis');
}

function num(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Convertit une dégradation déclarative (DS4) en 503 plutôt que de la laisser remonter telle quelle.
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StructuralUnavailable) {
      throw new AidHttpError(503, 'index_unavailable', { reason: err.message });
    }
    throw err;
  }
}

export function registerStructuralRoutes(app: FastifyInstance, deps: StructuralRouteDeps): void {
  const { db, engine, store, indexer } = deps;
  const adminOnly = (req: FastifyRequest) => {
    if (req.principal?.kind !== 'admin') throw new AidHttpError(403, 'réservé à l’administrateur');
  };

  app.get('/api/structural/status', async (req) => {
    const scope = resolveScope(
      db,
      req.principal!,
      req.query as { topic?: string; workspace?: string },
    );
    const status = await engine.status(scope.root);
    if (status.state === 'unavailable') {
      throw new AidHttpError(503, 'index_unavailable', { reason: status.reason });
    }
    return status;
  });

  app.get('/api/structural/explore', async (req) => {
    const q = req.query as { q?: string; maxFiles?: string; topic?: string; workspace?: string };
    if (!q.q) throw new AidHttpError(400, 'q est requis');
    const scope = resolveScope(db, req.principal!, q);
    return guarded(() => engine.explore(scope.root, q.q!, { maxFiles: num(q.maxFiles) }));
  });

  app.get('/api/structural/symbols', async (req) => {
    const q = req.query as {
      q?: string;
      kind?: string;
      limit?: string;
      topic?: string;
      workspace?: string;
    };
    if (!q.q) throw new AidHttpError(400, 'q est requis');
    const scope = resolveScope(db, req.principal!, q);
    const symbols = await guarded(() =>
      engine.symbols(scope.root, q.q!, { kind: q.kind, limit: num(q.limit) }),
    );
    return { symbols };
  });

  app.get('/api/structural/callers', async (req) => {
    const q = req.query as {
      symbol?: string;
      limit?: string;
      topic?: string;
      workspace?: string;
    };
    if (!q.symbol) throw new AidHttpError(400, 'symbol est requis');
    const scope = resolveScope(db, req.principal!, q);
    const callers = await guarded(() => engine.callers(scope.root, q.symbol!, num(q.limit)));
    return { callers };
  });

  app.get('/api/structural/impact', async (req) => {
    const q = req.query as {
      symbol?: string;
      depth?: string;
      topic?: string;
      workspace?: string;
    };
    if (!q.symbol) throw new AidHttpError(400, 'symbol est requis');
    const scope = resolveScope(db, req.principal!, q);
    return guarded(() => engine.impact(scope.root, q.symbol!, num(q.depth)));
  });

  app.post('/api/structural/affected', { schema: { body: AffectedBody } }, async (req) => {
    const { files } = req.body as { files: string[] };
    const scope = resolveScope(
      db,
      req.principal!,
      req.query as { topic?: string; workspace?: string },
    );
    return guarded(() => engine.affected(scope.root, files));
  });

  app.post('/api/structural/reindex', async (req) => {
    adminOnly(req);
    const { topic } = req.query as { topic?: string };
    if (!topic) throw new AidHttpError(400, 'topic est requis');
    const row = db
      .prepare('SELECT id, workspace_id, worktree FROM topics WHERE id = ?')
      .get(topic) as { id: string; workspace_id: string; worktree: string } | undefined;
    if (!row) throw new AidHttpError(404, 'sujet inconnu');
    store.append({
      source: 'daemon',
      type: 'topic.state',
      workspaceId: row.workspace_id,
      topicId: row.id,
      data: { indexState: 'indexing' },
    });
    indexer.start({ id: row.id, workspaceId: row.workspace_id, worktree: row.worktree });
    return { topicId: row.id };
  });
}
