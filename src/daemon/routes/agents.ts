import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import type { AgentManager } from '../pty/manager.js';

const Body = Type.Object(
  {
    topicId: Type.String({ minLength: 1 }),
    kind: Type.Unsafe<'claude' | 'codex' | 'shell'>({
      type: 'string',
      enum: ['claude', 'codex', 'shell'],
    }),
  },
  { additionalProperties: false },
);

export function registerAgentRoutes(
  app: FastifyInstance,
  deps: { db: Db; agents: AgentManager },
): void {
  app.post('/api/agents', { schema: { body: Body } }, async (req, reply) => {
    const body = req.body as { topicId: string; kind: 'claude' | 'codex' | 'shell' };
    return reply.code(201).send(deps.agents.spawn(body));
  });

  app.delete('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(id))
      throw new AidHttpError(404, 'agent inconnu');
    const live = deps.agents.get(id);
    if (!live || live.exited) throw new AidHttpError(409, 'cet agent est déjà terminé');
    void deps.agents.stop(id, 'user');
    return reply.code(202).send({ id });
  });
}
