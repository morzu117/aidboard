import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import type { UpdateStatus } from '../updateCheck.js';

const LIVE = ['starting', 'working', 'needs_input', 'idle'];
const Body = Type.Optional(
  Type.Object({ force: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
);

// Arrêter le daemon tue ses agents (ce sont ses enfants) : sans --force, on refuse tant qu'il en reste de vivants.
export function registerDaemonRoutes(
  app: FastifyInstance,
  deps: { db: Db; requestStop: () => void; updates?: () => UpdateStatus | null },
): void {
  app.get('/api/daemon/update', async () => deps.updates?.() ?? { available: false });
  app.post('/api/daemon/stop', { schema: { body: Body } }, async (req, reply) => {
    const force = (req.body as { force?: boolean } | undefined)?.force === true;
    const alive = deps.db
      .prepare(`SELECT id, kind FROM agents WHERE status IN (${LIVE.map(() => '?').join(',')})`)
      .all(...LIVE) as Array<{ id: string; kind: string }>;
    if (alive.length > 0 && !force) {
      throw new AidHttpError(
        409,
        `${alive.length} agent(s) tournent encore : --force pour tout arrêter`,
        { agents: alive },
      );
    }
    reply.code(202).send({ stopping: true, agents: alive.length });
    setImmediate(deps.requestStop);
  });
}
