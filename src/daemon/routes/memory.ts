import { type Static, Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LESSON_NS, MEM_SLUG_RULE, type PutMode, RevisionConflict } from '../../shared/memory.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { applyProposal, type MemoryProposals, rejectProposal } from '../memory/maintain.js';
import type { MemoryService, WriteContext } from '../memory/service.js';
import { InvalidMemSlug, isValidMemSlug, isValidNamespace, namespaceOf } from '../memory/slug.js';
import type { Principal } from '../security.js';

const PutBody = Type.Object(
  {
    text: Type.String(),
    mode: Type.Optional(
      Type.Unsafe<'create' | 'append' | 'replace' | 'force'>({
        type: 'string',
        enum: ['create', 'append', 'replace', 'force'],
      }),
    ),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

const ImportBody = Type.Object(
  { dir: Type.String({ minLength: 1 }), namespace: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);
const ExportBody = Type.Object(
  { dir: Type.String({ minLength: 1 }), scope: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);

export interface MemoryRouteDeps {
  db: Db;
  memory: MemoryService;
  proposals?: MemoryProposals;
}

interface RunRow {
  run_id: string;
  topic_id: string;
  workspace_id: string;
  workspace_name: string;
  namespace: string | null;
  role: string | null;
}

function slugOf(req: FastifyRequest): string {
  const slug = (req.params as { '*': string })['*'];
  if (!isValidMemSlug(slug)) throw new AidHttpError(400, new InvalidMemSlug(slug).message);
  return slug;
}

function putMode(body: Static<typeof PutBody>): PutMode {
  switch (body.mode) {
    case 'append':
      return { kind: 'append' };
    case 'force':
      return { kind: 'force' };
    case 'replace':
      if (body.expectedRevision === undefined) {
        throw new AidHttpError(400, 'mode replace : expectedRevision est requis');
      }
      return { kind: 'replace', expectedRevision: body.expectedRevision };
    default:
      return { kind: 'create' };
  }
}

// Ce qu'un token de run peut écrire : le namespace de son workspace ; `lesson/` si l'agent est en rétro.
export function runWriteContext(db: Db, p: Principal, slug: string): WriteContext {
  if (p.kind === 'admin') return { author: 'admin' };
  const run = db
    .prepare(
      `SELECT r.id AS run_id, t.id AS topic_id, w.id AS workspace_id, w.name AS workspace_name,
              w.namespace, (SELECT role FROM agents a WHERE a.run_id = r.id ORDER BY a.created_at LIMIT 1) AS role
       FROM runs r JOIN topics t ON t.id = r.topic_id JOIN workspaces w ON w.id = t.workspace_id
       WHERE r.id = ?`,
    )
    .get(p.runId) as RunRow | undefined;
  if (!run) throw new AidHttpError(403, 'run inconnu');
  const ns = namespaceOf(slug);
  const own = run.namespace ?? run.workspace_name;
  const allowed = ns === own || (ns === LESSON_NS && run.role === 'retro');
  if (!allowed) throw new AidHttpError(403, 'forbidden', { namespace: ns, allowed: own });
  return {
    author: `run:${run.run_id}`,
    workspaceId: run.workspace_id,
    topicId: run.topic_id,
    runId: run.run_id,
  };
}

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRouteDeps): void {
  const { db, memory, proposals } = deps;
  const adminOnly = (req: FastifyRequest) => {
    if (req.principal?.kind !== 'admin') throw new AidHttpError(403, 'réservé à l’administrateur');
  };

  app.get('/api/memory/pages', async (req) => {
    const { prefix } = req.query as { prefix?: string };
    return { slugs: memory.list(prefix ?? '') };
  });

  app.get('/api/memory/pages/*', async (req) => {
    const page = memory.get(slugOf(req));
    if (!page) throw new AidHttpError(404, 'page absente');
    return page;
  });

  app.put('/api/memory/pages/*', { schema: { body: PutBody } }, async (req, reply) => {
    const slug = slugOf(req);
    const body = req.body as Static<typeof PutBody>;
    const ctx = runWriteContext(db, req.principal!, slug);
    try {
      const page = await memory.put(slug, body.text, putMode(body), ctx, body.title);
      return reply.code(page.revision === 1 ? 201 : 200).send({ slug, revision: page.revision });
    } catch (err) {
      if (err instanceof RevisionConflict) {
        throw new AidHttpError(409, 'revision_conflict', { revision: err.revision });
      }
      if (err instanceof InvalidMemSlug) throw new AidHttpError(400, err.message);
      if (err instanceof Error && err.message.startsWith('frontmatter')) {
        throw new AidHttpError(400, err.message);
      }
      throw err;
    }
  });

  app.delete('/api/memory/pages/*', async (req, reply) => {
    const slug = slugOf(req);
    const ctx = runWriteContext(db, req.principal!, slug);
    if (!(await memory.remove(slug, ctx))) throw new AidHttpError(404, 'page absente');
    return reply.code(200).send({ slug });
  });

  app.get('/api/memory/search', async (req) => {
    const q = req.query as { q?: string; scope?: string; limit?: string };
    if (!q.q) throw new AidHttpError(400, 'q est requis');
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '10', 10) || 10, 1), 100);
    return memory.search(q.q, q.scope && q.scope !== 'all' ? q.scope : 'all', limit);
  });

  app.get('/api/memory/health', async (req) => {
    adminOnly(req);
    return memory.health();
  });

  app.post('/api/memory/reindex', async (req) => {
    adminOnly(req);
    return memory.reindex();
  });

  app.post('/api/memory/export', { schema: { body: ExportBody } }, async (req) => {
    adminOnly(req);
    const body = req.body as Static<typeof ExportBody>;
    return { pages: await memory.export(body.scope ?? 'all', body.dir) };
  });

  app.post('/api/memory/import', { schema: { body: ImportBody } }, async (req) => {
    adminOnly(req);
    const body = req.body as Static<typeof ImportBody>;
    if (body.namespace !== undefined && !isValidNamespace(body.namespace)) {
      throw new AidHttpError(400, `namespace invalide : ${MEM_SLUG_RULE}`);
    }
    return memory.import(body.dir, body.namespace);
  });

  app.get('/api/memory/proposals', async (req) => {
    adminOnly(req);
    if (!proposals) return { proposals: [] };
    const { state } = req.query as { state?: 'open' | 'applied' | 'rejected' };
    return { proposals: proposals.list(state) };
  });

  app.post('/api/memory/proposals/:id/apply', async (req) => {
    adminOnly(req);
    if (!proposals) throw new AidHttpError(404, 'entretien non disponible');
    const { id } = req.params as { id: string };
    const proposal = proposals.get(id);
    if (!proposal) throw new AidHttpError(404, 'proposition absente');
    if (proposal.state !== 'open') throw new AidHttpError(409, 'proposition déjà décidée');
    await applyProposal(proposal, memory);
    proposals.decide(id, 'applied');
    return { id, state: 'applied' };
  });

  app.post('/api/memory/proposals/:id/reject', async (req) => {
    adminOnly(req);
    if (!proposals) throw new AidHttpError(404, 'entretien non disponible');
    const { id } = req.params as { id: string };
    const proposal = proposals.get(id);
    if (!proposal) throw new AidHttpError(404, 'proposition absente');
    if (proposal.state !== 'open') throw new AidHttpError(409, 'proposition déjà décidée');
    await rejectProposal(proposal, memory);
    proposals.decide(id, 'rejected');
    return { id, state: 'rejected' };
  });
}
