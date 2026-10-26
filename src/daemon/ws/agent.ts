import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Db } from '../db.js';
import type { ConversationEvent } from '../conversation/driver.js';
import type { AgentManager } from '../pty/manager.js';

const SLOW_CLIENT_BYTES = 4 * 1024 * 1024;
const HISTORY_LIMIT = 2000;

interface AgentRow {
  status: string;
  exit_code: number | null;
}

interface MessageRow {
  seq: number;
  payload: string;
  at: string;
}

type Exit = { exitCode: number | null; signal: NodeJS.Signals | null; reason: string };

/** Canal `/ws/agent/:agentId` (D65) : lecture seule, un message normalisé par événement. */
export function registerAgentSocket(
  app: FastifyInstance,
  deps: { db: Db; agents: AgentManager },
): void {
  const sendJson = (socket: WebSocket, msg: object) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  // Les événements en direct sont potentiellement nombreux : seuls eux subissent la coupure du client lent.
  const sendEvent = (socket: WebSocket, msg: object) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > SLOW_CLIENT_BYTES) {
      socket.close(4001, 'client trop lent');
      setTimeout(() => socket.terminate(), 1000).unref();
      return;
    }
    socket.send(JSON.stringify(msg));
  };

  app.get(
    '/ws/agent/:agentId',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const { agentId } = req.params as { agentId: string };
        const row = deps.db.prepare('SELECT transport FROM agents WHERE id = ?').get(agentId) as
          { transport: string } | undefined;
        if (!row) return reply.code(404).send({ error: 'agent inconnu' });
        if (row.transport !== 'stream') {
          return reply.code(409).send({ error: 'agent non conversationnel' });
        }
      },
    },
    (socket, req) => {
      const { agentId } = req.params as { agentId: string };
      const query = req.query as { after?: unknown };
      const afterRaw = Number(query.after);
      const after = Number.isInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;

      const row = deps.db
        .prepare('SELECT status, exit_code FROM agents WHERE id = ?')
        .get(agentId) as AgentRow;

      const historyRows = deps.db
        .prepare(
          'SELECT seq, kind, payload, at FROM agent_messages WHERE agent_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?',
        )
        .all(agentId, after, HISTORY_LIMIT) as MessageRow[];
      // LIMIT seul ne distingue pas un historique pile à la limite d'une troncature réelle.
      const total = (
        deps.db
          .prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE agent_id = ? AND seq > ?')
          .get(agentId, after) as { n: number }
      ).n;
      const truncated = total > historyRows.length;
      const items = historyRows
        .slice()
        .reverse()
        .map((r) => ({ seq: r.seq, at: r.at, event: JSON.parse(r.payload) as ConversationEvent }));

      const stream = deps.agents.getStream(agentId);
      const alive = stream !== undefined && !stream.exited;

      sendJson(socket, { t: 'hello', status: row.status, exited: !alive });
      sendJson(socket, { t: 'history', items, truncated });

      const sendExit = (exit: Exit) => sendJson(socket, { t: 'exit', ...exit });

      if (!alive) {
        if (stream?.exited) sendExit(stream.exit!);
        else sendExit({ exitCode: row.exit_code, signal: null, reason: 'daemon_restart' });
        return;
      }

      const unsubscribe = stream.subscribe((ev) => {
        const seq = stream.seq;
        const at = new Date().toISOString();
        sendEvent(socket, { t: 'event', seq, at, event: ev });
        // stream.exit n'est posé qu'après le retour de ce rappel (manager.ts:wireStream) : on
        // reconstruit la sortie depuis l'événement plutôt que de lire un champ pas encore écrit.
        if (ev.type === 'exit') {
          sendExit({ exitCode: ev.code, signal: ev.signal, reason: stream.stopReason ?? 'exit' });
        }
      });

      socket.on('message', () => undefined);
      socket.on('close', unsubscribe);
    },
  );
}
