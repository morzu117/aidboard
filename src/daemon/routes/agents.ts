import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AgentSettings } from '../../shared/agentSettings.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import type { AgentManager, AttachmentUpload } from '../pty/manager.js';

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

// D70 : texte vide permis avec au moins une pièce jointe (vérifié par le gestionnaire) ; 10 Mio par fichier en base64.
const InputBody = Type.Object(
  {
    text: Type.String({ maxLength: 4000 }),
    attachments: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 255 }),
            type: Type.String({ maxLength: 128 }),
            data: Type.String({ maxLength: 14_000_000 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 5 },
      ),
    ),
  },
  { additionalProperties: false },
);
const INPUT_BODY_LIMIT = 72 * 1024 * 1024;
const AnswerBody = Type.Object(
  {
    pendingId: Type.String({ minLength: 1, maxLength: 64 }),
    answer: Type.String({ minLength: 1, maxLength: 8 }),
  },
  { additionalProperties: false },
);
const MarkBody = Type.Object({ marked: Type.Boolean() }, { additionalProperties: false });
const SettingsBody = Type.Object(
  {
    mode: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    model: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()])),
    effort: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()])),
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

  app.post(
    '/api/agents/:id/input',
    { schema: { body: InputBody }, bodyLimit: INPUT_BODY_LIMIT },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { text: string; attachments?: AttachmentUpload[] };
      deps.agents.input(id, body.text, body.attachments);
      return reply.code(202).send({ id });
    },
  );

  app.post('/api/agents/:id/answer', { schema: { body: AnswerBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { pendingId: string; answer: string };
    deps.agents.answer(id, body.pendingId, body.answer);
    return reply.code(202).send({ id });
  });

  // Repères de discussion (A.7) : marquer ou démarquer une question (un message utilisateur) du fil.
  app.put(
    '/api/agents/:id/messages/:seq/mark',
    { schema: { body: MarkBody } },
    async (req, reply) => {
      const { id, seq: seqParam } = req.params as { id: string; seq: string };
      if (!/^[1-9][0-9]*$/.test(seqParam))
        throw new AidHttpError(400, 'seq doit être un entier positif');
      const seq = Number(seqParam);
      if (!deps.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(id))
        throw new AidHttpError(404, 'agent inconnu');
      const row = deps.db
        .prepare('SELECT kind, payload FROM agent_messages WHERE agent_id = ? AND seq = ?')
        .get(id, seq) as { kind: string; payload: string } | undefined;
      if (!row) throw new AidHttpError(404, 'message inconnu');
      let role: string | undefined;
      if (row.kind === 'message') {
        try {
          role = (JSON.parse(row.payload) as { role?: string }).role;
        } catch {
          throw new AidHttpError(422, 'message illisible');
        }
      }
      if (role !== 'user')
        throw new AidHttpError(422, 'seul un message utilisateur peut être marqué');
      const { marked } = req.body as { marked: boolean };
      deps.db
        .prepare('UPDATE agent_messages SET marked = ? WHERE agent_id = ? AND seq = ?')
        .run(marked ? 1 : 0, id, seq);
      return reply.code(200).send({ seq, marked });
    },
  );

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

  // Chantier 16 (D66-D71) : mode, modèle et effort d'un agent conversationnel, depuis le composer.
  app.get('/api/agents/:id/options', async (req) => {
    const { id } = req.params as { id: string };
    return deps.agents.options(id);
  });

  app.patch('/api/agents/:id/settings', { schema: { body: SettingsBody } }, async (req) => {
    const { id } = req.params as { id: string };
    return deps.agents.setSettings(id, req.body as Partial<AgentSettings>);
  });

  app.delete('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = deps.db.prepare('SELECT closed_at FROM agents WHERE id = ?').get(id) as
      { closed_at: string | null } | undefined;
    if (!row) throw new AidHttpError(404, 'agent inconnu');
    const live = deps.agents.get(id);
    const stream = deps.agents.getStream(id);
    if ((live && !live.exited) || (stream && !stream.exited)) {
      void deps.agents.stop(id, 'user');
      return reply.code(202).send({ id });
    }
    if (row.closed_at) throw new AidHttpError(409, 'cet agent est déjà fermé');
    deps.agents.close(id);
    return reply.code(200).send({ id });
  });
}
