import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Db } from '../db.js';
import type { ConversationEvent } from '../conversation/driver.js';
import type { RemoteAgentManager } from '../remote/agents.js';

const SLOW_CLIENT_BYTES = 4 * 1024 * 1024;
const HISTORY_LIMIT = 2000;
const HISTORY_BYTES_LIMIT = 4 * 1024 * 1024;

interface MessageRow {
  seq: number;
  payload: string;
  at: string;
  marked: number;
}

type Exit = { exitCode: number | null; signal: NodeJS.Signals | null; reason: string };

/**
 * Chantier 17 (R.4) : `/ws/server-agent/:agentId`, au même protocole que `/ws/agent/:agentId` (D65) — `hello`,
 * `history`, `event`, `exit` — pour que la conversation se rende avec les mêmes composants. Lecture seule.
 */
export function registerServerAgentSocket(
  app: FastifyInstance,
  deps: { db: Db; agents: RemoteAgentManager },
): void {
  const sendJson = (socket: WebSocket, msg: object) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
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
    '/ws/server-agent/:agentId',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const { agentId } = req.params as { agentId: string };
        if (!deps.db.prepare('SELECT 1 FROM server_agents WHERE id = ?').get(agentId))
          return reply.code(404).send({ error: 'agent inconnu' });
      },
    },
    (socket, req) => {
      const { agentId } = req.params as { agentId: string };
      const afterRaw = Number((req.query as { after?: unknown }).after);
      const after = Number.isInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;
      const row = deps.db.prepare('SELECT status FROM server_agents WHERE id = ?').get(agentId) as {
        status: string;
      };

      const rows = deps.db
        .prepare(
          'SELECT seq, payload, at, marked FROM server_agent_messages WHERE agent_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?',
        )
        .all(agentId, after, HISTORY_LIMIT) as MessageRow[];
      let bytes = 0;
      let kept = rows.length;
      for (let i = 0; i < rows.length; i++) {
        bytes += Buffer.byteLength(rows[i]!.payload, 'utf8');
        if (bytes > HISTORY_BYTES_LIMIT) {
          kept = i;
          break;
        }
      }
      const total = (
        deps.db
          .prepare('SELECT COUNT(*) AS n FROM server_agent_messages WHERE agent_id = ? AND seq > ?')
          .get(agentId, after) as { n: number }
      ).n;
      const items: { seq: number; at: string; event: ConversationEvent; marked?: boolean }[] = [];
      for (const r of rows.slice(0, kept).reverse()) {
        try {
          const event = JSON.parse(r.payload) as ConversationEvent;
          items.push(
            r.marked
              ? { seq: r.seq, at: r.at, event, marked: true }
              : { seq: r.seq, at: r.at, event },
          );
        } catch {
          // ligne corrompue : ignorée plutôt que de faire échouer la connexion.
        }
      }

      const live = deps.agents.getLive(agentId);
      // en veille (codex après un redémarrage du daemon) comme fini : `exited`, le prochain message le relance (A.6)
      const alive = live !== undefined && !live.exited;
      sendJson(socket, { t: 'hello', status: row.status, exited: !alive });
      sendJson(socket, { t: 'history', items, truncated: total > kept });

      const sendExit = (exit: Exit) => sendJson(socket, { t: 'exit', ...exit });
      if (!alive) {
        if (live?.exited) sendExit(live.exit!);
        else sendExit({ exitCode: null, signal: null, reason: 'daemon_restart' });
        socket.close(1000, 'fin');
        return;
      }

      const unsubscribe = live.subscribe((ev) => {
        sendEvent(socket, { t: 'event', seq: live.seq, at: new Date().toISOString(), event: ev });
        if (ev.type === 'exit') {
          sendExit({ exitCode: ev.code, signal: ev.signal, reason: live.stopReason ?? 'exit' });
          unsubscribe();
          socket.close(1000, 'fin');
        }
      });
      socket.on('message', () => undefined);
      socket.on('close', unsubscribe);
    },
  );
}
