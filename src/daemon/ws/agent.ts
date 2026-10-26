import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Db } from '../db.js';
import type { ConversationEvent } from '../conversation/driver.js';
import type { AgentManager } from '../pty/manager.js';

const SLOW_CLIENT_BYTES = 4 * 1024 * 1024;
const HISTORY_LIMIT = 2000;
const HISTORY_BYTES_LIMIT = 4 * 1024 * 1024;

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
          'SELECT seq, payload, at FROM agent_messages WHERE agent_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?',
        )
        .all(agentId, after, HISTORY_LIMIT) as MessageRow[];
      // Les plus récentes d'abord (ordre DESC) : on ne garde que celles qui tiennent sous la limite d'octets.
      let historyBytes = 0;
      let boundedCount = historyRows.length;
      for (let i = 0; i < historyRows.length; i++) {
        historyBytes += Buffer.byteLength(historyRows[i]!.payload, 'utf8');
        if (historyBytes > HISTORY_BYTES_LIMIT) {
          boundedCount = i;
          break;
        }
      }
      const boundedRows = historyRows.slice(0, boundedCount);
      // LIMIT et la coupure en octets ratent chacune, seules, un historique pile à la limite.
      const total = (
        deps.db
          .prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE agent_id = ? AND seq > ?')
          .get(agentId, after) as { n: number }
      ).n;
      const truncated = total > boundedRows.length;
      const items: { seq: number; at: string; event: ConversationEvent }[] = [];
      for (const r of boundedRows.slice().reverse()) {
        try {
          items.push({ seq: r.seq, at: r.at, event: JSON.parse(r.payload) as ConversationEvent });
        } catch {
          // ligne corrompue : ignorée plutôt que de faire échouer la connexion.
        }
      }

      const stream = deps.agents.getStream(agentId);
      const alive = stream !== undefined && !stream.exited;

      sendJson(socket, { t: 'hello', status: row.status, exited: !alive });
      sendJson(socket, { t: 'history', items, truncated });

      const sendExit = (exit: Exit) => sendJson(socket, { t: 'exit', ...exit });

      if (!alive) {
        if (stream?.exited) sendExit(stream.exit!);
        else sendExit({ exitCode: row.exit_code, signal: null, reason: 'daemon_restart' });
        socket.close(1000, 'fin');
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
          unsubscribe();
          socket.close(1000, 'fin');
        }
      });

      socket.on('message', () => undefined);
      socket.on('close', unsubscribe);
    },
  );
}
