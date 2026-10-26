import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import type { AgentManager } from '../pty/manager.js';

const Body = Type.Object(
  {
    topicId: Type.String({ minLength: 1 }),
    kind: Type.Unsafe<'claude' | 'codex' | 'shell' | 'swarph-cell' | 'swairm-cell'>({
      type: 'string',
      enum: ['claude', 'codex', 'shell', 'swarph-cell', 'swairm-cell'],
    }),
  },
  { additionalProperties: false },
);

const InputBody = Type.Object(
  { text: Type.String({ minLength: 1, maxLength: 4000 }) },
  { additionalProperties: false },
);
const AnswerBody = Type.Object(
  {
    pendingId: Type.String({ minLength: 1, maxLength: 64 }),
    answer: Type.String({ minLength: 1, maxLength: 8 }),
  },
  { additionalProperties: false },
);

export function registerAgentRoutes(
  app: FastifyInstance,
  deps: { db: Db; agents: AgentManager },
): void {
  app.post('/api/agents', { schema: { body: Body } }, async (req, reply) => {
    const body = req.body as {
      topicId: string;
      kind: 'claude' | 'codex' | 'shell' | 'swarph-cell' | 'swairm-cell';
    };
    return reply.code(201).send(deps.agents.spawn(body));
  });

  // Piloter un agent depuis l'Accueil : réservé à l'humain (un token de run n'atteint que POST /api/events).
  app.get('/api/agents/:id/screen', async (req) => {
    const { id } = req.params as { id: string };
    const { lines } = req.query as { lines?: string };
    return { lines: deps.agents.screen(id, Number(lines ?? 6)) };
  });

  app.post('/api/agents/:id/input', { schema: { body: InputBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    deps.agents.input(id, (req.body as { text: string }).text);
    return reply.code(202).send({ id });
  });

  app.post('/api/agents/:id/answer', { schema: { body: AnswerBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { pendingId: string; answer: string };
    deps.agents.answer(id, body.pendingId, body.answer);
    return reply.code(202).send({ id });
  });

  for (const [path, paused] of [
    ['pause', true],
    ['resume', false],
  ] as const) {
    app.post(`/api/agents/:id/${path}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      deps.agents.setPaused(id, paused);
      return reply.code(202).send({ id });
    });
  }

  // D64 : l'équivalent de la pause pour un agent conversationnel, qui n'en a pas.
  app.post('/api/agents/:id/interrupt', async (req, reply) => {
    const { id } = req.params as { id: string };
    deps.agents.interrupt(id);
    return reply.code(202).send({ id });
  });

  app.delete('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = deps.db.prepare('SELECT closed_at FROM agents WHERE id = ?').get(id) as
      { closed_at: string | null } | undefined;
    if (!row) throw new AidHttpError(404, 'agent inconnu');
    const live = deps.agents.get(id);
    if (live && !live.exited) {
      void deps.agents.stop(id, 'user');
      return reply.code(202).send({ id });
    }
    if (row.closed_at) throw new AidHttpError(409, 'cet agent est déjà fermé');
    deps.agents.close(id);
    return reply.code(200).send({ id });
  });
}
