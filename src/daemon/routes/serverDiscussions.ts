import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { RemoteAgentManager, type RemoteAgentManagerDeps } from '../remote/agents.js';
import { getServer } from '../remote/servers.js';

const CreateBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.String({ minLength: 1, maxLength: 32 }),
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  },
  { additionalProperties: false },
);
const PatchBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    archived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
// texte seul : les pièces jointes (D70) sont des fichiers du daemon, pas du serveur
const InputBody = Type.Object(
  { text: Type.String({ maxLength: 1024 * 1024 }) },
  { additionalProperties: false },
);
const AnswerBody = Type.Object(
  {
    pendingId: Type.String({ minLength: 1, maxLength: 64 }),
    answer: Type.String({ minLength: 1, maxLength: 8 }),
  },
  { additionalProperties: false },
);

/**
 * Chantier 17 (R.4) : discussions sur un serveur et pilotage de leurs agents, mêmes formes que `/api/agents/:id/…`.
 * Réservé à l'administrateur comme le reste des routes serveurs (D76) : un token de run n'atteint pas ces chemins.
 */
export function registerServerDiscussionRoutes(
  app: FastifyInstance,
  deps: { db: Db } & Omit<RemoteAgentManagerDeps, 'db'>,
): RemoteAgentManager {
  const { db } = deps;
  const manager = new RemoteAgentManager(deps);
  // arrêt du daemon : les liens se ferment, les agents continuent sur leurs serveurs (D73)
  app.addHook('onClose', async () => manager.detachAll());
  // revue R.1 : supprimer un serveur arrête d'abord ses agents ; la cascade ne touche que la base
  app.addHook('preHandler', async (req) => {
    if (req.method !== 'DELETE' || req.routeOptions.url !== '/api/servers/:id') return;
    const { id } = req.params as { id: string };
    if (getServer(db, id)) await manager.forgetServer(id);
  });
  app.addHook('onResponse', async (req) => {
    if (req.method === 'DELETE' && req.routeOptions.url === '/api/servers/:id')
      manager.released((req.params as { id: string }).id);
  });

  const found = (id: string) => {
    const server = getServer(db, id);
    if (!server) throw new AidHttpError(404, `serveur ${id} inconnu`);
    return server;
  };

  app.get('/api/servers/:id/discussions', async (req) =>
    manager.listDiscussions(found((req.params as { id: string }).id).id),
  );

  app.post('/api/servers/:id/discussions', { schema: { body: CreateBody } }, async (req, reply) => {
    const server = found((req.params as { id: string }).id);
    const body = req.body as { name: string; kind: string; cwd?: string };
    return reply.code(201).send(manager.createDiscussion(server, body));
  });

  app.get('/api/servers/:id/discussions/:discussionId', async (req) => {
    const { id, discussionId } = req.params as { id: string; discussionId: string };
    return manager.discussion(found(id).id, discussionId);
  });

  app.patch(
    '/api/servers/:id/discussions/:discussionId',
    { schema: { body: PatchBody } },
    async (req) => {
      const { id, discussionId } = req.params as { id: string; discussionId: string };
      return manager.updateDiscussion(
        found(id).id,
        discussionId,
        req.body as { name?: string; archived?: boolean },
      );
    },
  );

  app.delete('/api/servers/:id/discussions/:discussionId', async (req, reply) => {
    const { id, discussionId } = req.params as { id: string; discussionId: string };
    await manager.deleteDiscussion(found(id).id, discussionId);
    return reply.code(204).send();
  });

  app.get('/api/server-agents/:id', async (req) =>
    manager.agent((req.params as { id: string }).id),
  );

  app.post('/api/server-agents/:id/input', { schema: { body: InputBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await manager.input(id, (req.body as { text: string }).text);
    return reply.code(202).send({ id });
  });

  app.post('/api/server-agents/:id/interrupt', async (req, reply) => {
    const { id } = req.params as { id: string };
    manager.interrupt(id);
    return reply.code(202).send({ id });
  });

  app.post(
    '/api/server-agents/:id/answer',
    { schema: { body: AnswerBody } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { pendingId: string; answer: string };
      manager.answer(id, body.pendingId, body.answer);
      return reply.code(202).send({ id });
    },
  );

  manager.reattachAll();
  return manager;
}
