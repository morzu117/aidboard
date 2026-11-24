import { type Static, Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MEM_SLUG_RULE, type PutMode, RevisionConflict } from '../../shared/memory.js';
import { WorkspaceQueue } from '../actions/queue.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { deriveMemoryLinks } from '../memory/liens.js';
import { applyProposal, type MemoryProposals, rejectProposal } from '../memory/maintain.js';
import {
  assertMemoryWriteNamespace,
  type MemoryService,
  type MemoryWriteContext,
} from '../memory/service.js';
import { InvalidMemSlug, isValidMemSlug, isValidNamespace, namespaceOf } from '../memory/slug.js';
import { parseMarkdown } from '../memory/store.js';
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

const DecisionBody = Type.Object(
  {
    slug: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    raison: Type.String({ minLength: 1 }),
    texte: Type.Optional(Type.String()),
    remplace: Type.Optional(Type.Array(Type.String())),
    namespace: Type.Optional(Type.String()),
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

const PurgeBody = Type.Object(
  { dryRun: Type.Optional(Type.Boolean()), orphelines: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

const ApplyProposalBody = Type.Object(
  { lecons: Type.Optional(Type.Array(Type.String())) },
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
function principalWriteContext(db: Db, p: Principal): MemoryWriteContext {
  if (p.kind === 'admin') return { author: 'admin' };
  const run = db
    .prepare(
      `SELECT r.id AS run_id, t.id AS topic_id, w.id AS workspace_id, w.name AS workspace_name,
              w.namespace, (SELECT role FROM agents a WHERE a.run_id = r.id ORDER BY a.created_at, a.id LIMIT 1) AS role
       FROM runs r JOIN topics t ON t.id = r.topic_id JOIN workspaces w ON w.id = t.workspace_id
       WHERE r.id = ?`,
    )
    .get(p.runId) as RunRow | undefined;
  if (!run) throw new AidHttpError(403, 'run inconnu');
  return {
    author: `run:${run.run_id}`,
    workspaceId: run.workspace_id,
    topicId: run.topic_id,
    runId: run.run_id,
    scope: { namespace: run.namespace ?? run.workspace_name, role: run.role },
  };
}

export function runWriteContext(db: Db, p: Principal, slug: string): MemoryWriteContext {
  const ctx = principalWriteContext(db, p);
  assertMemoryWriteNamespace(ctx, namespaceOf(slug));
  return ctx;
}

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRouteDeps): void {
  const { db, memory, proposals } = deps;
  const proposalDecisions = new WorkspaceQueue();
  const adminOnly = (req: FastifyRequest) => {
    if (req.principal?.kind !== 'admin') throw new AidHttpError(403, 'réservé à l’administrateur');
  };

  const recordUsage = (req: FastifyRequest, slugs: string[], op: 'get' | 'search') => {
    try {
      memory.store.recordUsage(
        slugs,
        op,
        req.principal?.kind === 'run' ? req.principal.runId : undefined,
      );
    } catch (err) {
      app.log.error({ err }, "mémoire : écriture du journal d'usage impossible");
    }
  };

  app.get('/api/memory/pages', async (req) => {
    const { prefix } = req.query as { prefix?: string };
    return { slugs: memory.list(prefix ?? '') };
  });

  app.get('/api/memory/pages/*', async (req) => {
    const page = memory.get(slugOf(req));
    if (!page) throw new AidHttpError(404, 'page absente');
    recordUsage(req, [page.slug], 'get');
    return page;
  });

  app.get('/api/memory/links/*', async (req) => {
    const slug = slugOf(req);
    const links = memory.links(slug);
    if (!links) throw new AidHttpError(404, 'page absente', { slug });
    return links;
  });

  app.post('/api/memory/decisions', { schema: { body: DecisionBody } }, async (req, reply) => {
    const {
      namespace: requested,
      remplace = [],
      ...input
    } = req.body as Static<typeof DecisionBody>;
    const ctx = principalWriteContext(db, req.principal!);
    const own = ctx.scope?.namespace;
    if (own !== undefined && requested !== undefined && requested !== own) {
      throw new AidHttpError(403, 'forbidden', { namespace: requested, allowed: own });
    }
    const namespace = own ?? requested;
    if (namespace === undefined) throw new AidHttpError(400, 'namespace est requis');
    try {
      const decision = await memory.decide({ ...input, namespace, remplace }, ctx);
      return reply.code(201).send(decision);
    } catch (err) {
      if (err instanceof RevisionConflict) {
        throw new AidHttpError(409, 'revision_conflict', {
          slug: err.slug,
          revision: err.revision,
        });
      }
      throw err;
    }
  });

  app.put('/api/memory/pages/*', { schema: { body: PutBody } }, async (req, reply) => {
    const slug = slugOf(req);
    const body = req.body as Static<typeof PutBody>;
    const ctx = runWriteContext(db, req.principal!, slug);
    try {
      const { erreurs } = deriveMemoryLinks({ slug, ...parseMarkdown(body.text) }, new Date());
      if (erreurs.length > 0) throw new AidHttpError(400, erreurs.join('\n'));
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
    const q = req.query as { q?: string; scope?: string; limit?: string; closes?: string };
    if (!q.q) throw new AidHttpError(400, 'q est requis');
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '10', 10) || 10, 1), 100);
    if (q.closes !== undefined && q.closes !== '1' && q.closes !== 'true') {
      throw new AidHttpError(400, 'closes doit valoir 1 ou true');
    }
    const result = await memory.search(q.q, q.scope && q.scope !== 'all' ? q.scope : 'all', limit, {
      closes: q.closes !== undefined,
    });
    recordUsage(
      req,
      result.hits.map((hit) => hit.slug),
      'search',
    );
    return result;
  });

  app.get('/api/memory/usage', async (req) => {
    // Le bilan local suit les autres routes de diagnostic, réservées à l'administrateur.
    adminOnly(req);
    return { pages: memory.store.usage() };
  });

  app.get('/api/memory/health', async (req) => {
    adminOnly(req);
    return memory.health();
  });

  app.post('/api/memory/reindex', async (req) => {
    adminOnly(req);
    return memory.reindex();
  });

  app.post('/api/memory/purge', { schema: { body: PurgeBody } }, async (req) => {
    adminOnly(req);
    return memory.purge(req.body as Static<typeof PurgeBody>);
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

  app.post(
    '/api/memory/proposals/:id/apply',
    {
      schema: { body: ApplyProposalBody },
      async preValidation(req) {
        if (req.body === undefined) req.body = {};
      },
    },
    async (req) => {
      adminOnly(req);
      if (!proposals) throw new AidHttpError(404, 'entretien non disponible');
      const { id } = req.params as { id: string };
      return proposalDecisions.run(id, async () => {
        const proposal = proposals.get(id);
        if (!proposal) throw new AidHttpError(404, 'proposition absente');
        if (proposal.state !== 'open') throw new AidHttpError(409, 'proposition déjà décidée');
        const { lecons } = req.body as Static<typeof ApplyProposalBody>;
        const payload = await applyProposal(proposal, memory, lecons);
        proposals.decide(id, 'applied', payload ?? undefined);
        return { id, state: 'applied' };
      });
    },
  );

  app.post('/api/memory/proposals/:id/reject', async (req) => {
    adminOnly(req);
    if (!proposals) throw new AidHttpError(404, 'entretien non disponible');
    const { id } = req.params as { id: string };
    return proposalDecisions.run(id, async () => {
      const proposal = proposals.get(id);
      if (!proposal) throw new AidHttpError(404, 'proposition absente');
      if (proposal.state !== 'open') throw new AidHttpError(409, 'proposition déjà décidée');
      await rejectProposal(proposal, memory);
      proposals.decide(id, 'rejected');
      return { id, state: 'rejected' };
    });
  });
}
