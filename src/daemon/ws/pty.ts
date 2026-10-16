import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AidConfig } from '../config.js';
import type { Db } from '../db.js';
import type { AidPaths } from '../paths.js';
import { attachClient } from '../pty/attach.js';
import type { AgentManager, LiveAgent } from '../pty/manager.js';
import { TerminalMirror } from '../pty/mirror.js';

const SLOW_CLIENT_BYTES = 4 * 1024 * 1024;
const MAX_INPUT = 64 * 1024;
const LOG_TAIL = 512 * 1024;
const INITIAL = { cols: 120, rows: 32 };

interface Client {
  socket: WebSocket;
  detach: () => void;
}

interface AgentRow {
  id: string;
  status: string;
  exit_code: number | null;
}

function tailOf(path: string, bytes: number): string {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, 'r');
    try {
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function registerPtySocket(
  app: FastifyInstance,
  deps: { db: Db; paths: AidPaths; config: AidConfig; agents: AgentManager },
): void {
  // Pour chaque agent : les clients dans l'ordre de connexion. Le propriétaire est celui dont la saisie compte.
  const hubs = new Map<string, { clients: Client[]; owner: Client | null }>();
  const hubOf = (id: string) => {
    let hub = hubs.get(id);
    if (!hub) hubs.set(id, (hub = { clients: [], owner: null }));
    return hub;
  };
  const sendJson = (socket: WebSocket, msg: object) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };

  app.get(
    '/ws/pty/:agentId',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const { agentId } = req.params as { agentId: string };
        if (!deps.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId)) {
          return reply.code(404).send({ error: 'agent inconnu' });
        }
      },
    },
    (socket, req) => {
      const { agentId } = req.params as { agentId: string };
      const row = deps.db
        .prepare('SELECT id, status, exit_code FROM agents WHERE id = ?')
        .get(agentId) as AgentRow;
      const live: LiveAgent | undefined = deps.agents.get(agentId);

      // Agent d'un daemon précédent : plus de miroir en mémoire, on le reconstruit depuis la fin du journal.
      if (!live) {
        const bytes = tailOf(join(deps.paths.logs, `${agentId}.log`), LOG_TAIL);
        const mirror = TerminalMirror.fromLog(
          bytes,
          INITIAL.cols,
          INITIAL.rows,
          deps.config.terminal.scrollback,
        );
        sendJson(socket, {
          t: 'hello',
          ...INITIAL,
          owner: false,
          status: row.status,
          replay: 'log',
        });
        mirror.snapshotThen((snapshot) => {
          if (socket.readyState === socket.OPEN)
            socket.send(Buffer.from(snapshot, 'utf8'), { binary: true });
          sendJson(socket, {
            t: 'exit',
            exitCode: row.exit_code,
            signal: null,
            reason: 'daemon_restart',
          });
          mirror.dispose();
        });
        return;
      }

      const hub = hubOf(agentId);
      const client: Client = { socket, detach: () => undefined };
      const isOwner = () => hub.owner === client;
      const announceSize = (except?: Client) => {
        for (const c of hub.clients)
          if (c !== except) sendJson(c.socket, { t: 'size', ...live.size });
      };

      hub.clients.push(client);
      if (!hub.owner) hub.owner = client;
      sendJson(socket, {
        t: 'hello',
        ...live.size,
        owner: isOwner(),
        status: row.status,
        replay: 'live',
      });

      // Un client qui ne lit plus est coupé : il se reconnectera et recevra un instantané. Le PTY, lui, n'attend personne.
      const send = (data: string) => {
        if (socket.readyState !== socket.OPEN) return;
        if (socket.bufferedAmount > SLOW_CLIENT_BYTES) {
          socket.close(4001, 'client trop lent');
          setTimeout(() => socket.terminate(), 1000).unref();
          return;
        }
        socket.send(Buffer.from(data, 'utf8'), { binary: true });
      };
      const attachment = attachClient(live, send);
      client.detach = attachment.detach;

      const sendExit = () => {
        if (live.exit) sendJson(socket, { t: 'exit', ...live.exit });
      };
      if (live.exited) void attachment.ready.then(sendExit);
      else live.onExitCallbacks.add(sendExit);

      socket.on('message', (raw, isBinary) => {
        if (isBinary) return;
        let msg: { t?: string; d?: unknown; cols?: unknown; rows?: unknown };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          req.log.warn('message PTY ignoré : JSON invalide');
          return;
        }
        if (msg.t === 'claim') {
          if (isOwner()) return;
          const previous = hub.owner;
          hub.owner = client;
          if (previous) {
            sendJson(previous.socket, { t: 'owner', owner: false });
            sendJson(previous.socket, { t: 'size', ...live.size });
          }
          sendJson(socket, { t: 'owner', owner: true });
          return;
        }
        if (!isOwner()) return;
        if (
          msg.t === 'in' &&
          typeof msg.d === 'string' &&
          msg.d.length <= MAX_INPUT &&
          !live.exited
        ) {
          live.pty.write(msg.d);
        } else if (
          msg.t === 'resize' &&
          deps.agents.resize(agentId, msg.cols as number, msg.rows as number)
        ) {
          announceSize(client);
        }
      });

      socket.on('close', () => {
        client.detach();
        live.onExitCallbacks.delete(sendExit);
        hub.clients = hub.clients.filter((c) => c !== client);
        if (hub.owner === client) {
          hub.owner = hub.clients.at(-1) ?? null;
          if (hub.owner) {
            sendJson(hub.owner.socket, { t: 'owner', owner: true });
            sendJson(hub.owner.socket, { t: 'size', ...live.size });
          }
        }
        if (hub.clients.length === 0) hubs.delete(agentId);
      });
    },
  );
}
