import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import { monotonicFactory } from 'ulid';
import type { Agent } from '../../shared/model.js';
import type { AidConfig } from '../config.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import type { EventStore } from '../events/store.js';
import type { AidPaths } from '../paths.js';
import { type AuthState, issueRunToken } from '../security.js';
import { LogWriter } from './log.js';
import { type Estimate, estimate } from './heuristic.js';
import { TerminalMirror } from './mirror.js';
import { getPty } from './native.js';
import { agentCommand, agentEnv, hookEnv, resolveOnPath, type SpawnKind } from './spawn.js';

const ulid = monotonicFactory();
const INITIAL = { cols: 120, rows: 32 };

export type StopReason = 'user' | 'daemon_stop';

export interface LiveAgent {
  id: string;
  topicId: string;
  runId: string;
  workspaceId: string;
  pty: IPty;
  mirror: TerminalMirror;
  size: { cols: number; rows: number };
  exited: boolean;
  exit: { exitCode: number | null; signal: number | null; reason: string } | null;
  stopReason?: StopReason;
  kind: SpawnKind;
  /** dernière sortie du terminal (ms) : le silence fonde l'estimation */
  lastOutputAt: number;
  /** un hook a parlé pour cet agent : on n'estime plus rien */
  hooked: boolean;
  estimated: Estimate | null;
  paused: boolean;
  /** Octets bruts du terminal, dans l'ordre. Retourne la fonction de désabonnement. */
  subscribe(cb: (chunk: string) => void): () => void;
  onExitCallbacks: Set<() => void>;
}

export interface ManagerDeps {
  store: EventStore;
  db: Db;
  paths: AidPaths;
  config: AidConfig;
  auth: AuthState;
  port: () => number;
}

interface TopicRow {
  id: string;
  workspace_id: string;
  worktree: string;
  state: string;
}

export class AgentManager {
  private live = new Map<string, LiveAgent>();
  private readonly ticker: NodeJS.Timeout;

  constructor(private readonly deps: ManagerDeps) {
    deps.store.on(
      'event',
      (e: {
        type: string;
        source: string;
        topicId?: string;
        agentId?: string;
        data: Record<string, unknown>;
      }) => {
        // un sujet archivé n'a plus d'écran à rejouer : on libère ses miroirs
        if (e.type === 'topic.state' && e.data.state === 'archived' && e.topicId)
          this.forgetTopic(e.topicId);
        const a = e.agentId ? this.live.get(e.agentId) : undefined;
        if (a && e.type === 'agent.status') {
          if (e.source === 'hook:claude' || e.source === 'codex:json') a.hooked = true;
          if (e.source === 'daemon' && typeof e.data.paused === 'boolean') a.paused = e.data.paused;
        }
      },
    );
    this.ticker = setInterval(() => this.tickHeuristic(Date.now()), 2000);
    this.ticker.unref();
  }

  /** Estime le statut des agents sans hooks (E8). N'émet qu'aux transitions. */
  tickHeuristic(now: number): void {
    for (const a of this.live.values()) {
      if (a.exited || a.hooked || a.paused || (a.kind !== 'claude' && a.kind !== 'codex')) continue;
      const silenceMs = now - a.lastOutputAt;
      const next = estimate(silenceMs, a.mirror.screen(), a.estimated);
      if (!next) continue;
      a.estimated = next.status;
      this.deps.store.append({
        source: 'heuristic',
        type: 'agent.status',
        workspaceId: a.workspaceId,
        topicId: a.topicId,
        runId: a.runId,
        agentId: a.id,
        data: {
          status: next.status,
          ...(next.status === 'needs_input' && { reason: 'question' }),
          silenceMs,
          lastLine: next.lastLine,
          promptDetected: next.promptDetected,
        },
      });
    }
  }

  dispose(): void {
    clearInterval(this.ticker);
  }

  get(agentId: string): LiveAgent | undefined {
    return this.live.get(agentId);
  }

  spawn(o: { topicId: string; kind: SpawnKind }): Agent {
    const { db, store, paths, config, auth } = this.deps;
    const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(o.topicId) as
      TopicRow | undefined;
    if (!topic) throw new AidHttpError(404, 'sujet inconnu');
    if (topic.state !== 'active')
      throw new AidHttpError(409, `le sujet est « ${topic.state} », pas actif`);
    if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
    const run = db
      .prepare('SELECT id FROM runs WHERE topic_id = ? ORDER BY created_at LIMIT 1')
      .get(o.topicId) as { id: string } | undefined;
    if (!run) throw new AidHttpError(409, 'ce sujet n’a pas de run');

    const [bin = '', ...args] = agentCommand(o.kind, process.env);
    const file = resolveOnPath(bin, process.env.PATH ?? '');
    if (!file) throw new AidHttpError(422, `${bin} introuvable dans le PATH du daemon`);

    const agentId = `ag_${ulid()}`;
    const env = agentEnv(process.env, config.env.strip, {
      AID_URL: `http://127.0.0.1:${this.deps.port()}`,
      AID_TOKEN: issueRunToken(auth, run.id),
      AID_TOPIC: topic.id,
      AID_RUN: run.id,
      AID_AGENT: agentId,
      AID_SPOOL: paths.spool,
      ...hookEnv(),
    });
    let pty: IPty;
    try {
      pty = getPty().spawn(file, args, {
        name: 'xterm-256color',
        ...INITIAL,
        cwd: topic.worktree,
        env,
      });
    } catch (err) {
      throw new AidHttpError(422, `impossible de lancer ${bin} : ${(err as Error).message}`);
    }

    const now = new Date().toISOString();
    const command = [file, ...args];
    const subscribers = new Set<(chunk: string) => void>();
    const live: LiveAgent = {
      id: agentId,
      topicId: topic.id,
      runId: run.id,
      workspaceId: topic.workspace_id,
      pty,
      mirror: new TerminalMirror(INITIAL.cols, INITIAL.rows, config.terminal.scrollback),
      size: { ...INITIAL },
      exited: false,
      exit: null,
      kind: o.kind,
      lastOutputAt: Date.now(),
      hooked: false,
      estimated: null,
      paused: false,
      subscribe: (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      onExitCallbacks: new Set(),
    };
    const log = new LogWriter(join(paths.logs, `${agentId}.log`), config.terminal.logMaxBytes);
    pty.onData((chunk) => {
      live.lastOutputAt = Date.now();
      log.write(chunk);
      live.mirror.write(chunk);
      for (const cb of subscribers) cb(chunk);
    });
    pty.onExit(({ exitCode, signal }) => {
      live.exited = true;
      const reason = live.stopReason ?? 'exit';
      live.exit = { exitCode: signal ? null : exitCode, signal: signal ?? null, reason };
      log.close();
      store.append({
        source: 'daemon',
        type: 'agent.exited',
        workspaceId: live.workspaceId,
        topicId: live.topicId,
        runId: live.runId,
        agentId,
        data: live.exit,
      });
      for (const cb of live.onExitCallbacks) cb();
    });

    try {
      store.append(
        {
          source: 'daemon',
          type: 'agent.spawned',
          workspaceId: topic.workspace_id,
          topicId: topic.id,
          runId: run.id,
          agentId,
          data: { kind: o.kind, role: 'free', cwd: topic.worktree, pid: pty.pid, command },
        },
        (tx) =>
          tx
            .prepare(
              "INSERT INTO agents (id, run_id, kind, role, transport, status, cwd, command, pid, created_at, updated_at) VALUES (?, ?, ?, 'free', 'pty', 'starting', ?, ?, ?, ?, ?)",
            )
            .run(
              agentId,
              run.id,
              o.kind,
              topic.worktree,
              JSON.stringify(command),
              pty.pid,
              now,
              now,
            ),
      );
    } catch (err) {
      pty.kill('SIGKILL');
      throw err;
    }
    this.live.set(agentId, live);
    return {
      id: agentId,
      runId: run.id,
      kind: o.kind,
      role: 'free',
      transport: 'pty',
      status: 'starting',
      cwd: topic.worktree,
      command,
      pid: pty.pid,
      exitCode: null,
      issue: null,
      statusReason: null,
      statusMessage: null,
      statusSource: null,
      statusAt: null,
      statusDetail: null,
      lastTool: null,
      pending: null,
      pausedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Arrêt par paliers : SIGINT puis SIGTERM (la spec), SIGHUP pour un shell interactif qui ignore SIGTERM,
  // et SIGKILL du groupe entier à l'échéance (claude lance des serveurs MCP et codegraph en enfants).
  stop(agentId: string, reason: StopReason, graceMs = 5000): Promise<void> {
    const a = this.live.get(agentId);
    if (!a || a.exited) return Promise.resolve();
    a.stopReason = reason;
    return new Promise((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      const steps: Array<[number, NodeJS.Signals]> = [
        [0, 'SIGINT'],
        [1000, 'SIGTERM'],
        [2000, 'SIGHUP'],
      ];
      for (const [after, signal] of steps) {
        if (after >= graceMs) continue;
        timers.push(setTimeout(() => !a.exited && a.pty.kill(signal), after));
      }
      timers.push(
        setTimeout(() => {
          try {
            process.kill(-a.pty.pid, 'SIGKILL');
          } catch {
            a.pty.kill('SIGKILL');
          }
        }, graceMs),
      );
      a.onExitCallbacks.add(() => {
        for (const t of timers) clearTimeout(t);
        resolve();
      });
    });
  }

  async stopAll(reason: StopReason, timeoutMs: number): Promise<void> {
    const alive = [...this.live.values()].filter((a) => !a.exited);
    await Promise.all(alive.map((a) => this.stop(a.id, reason, timeoutMs)));
  }

  /** Libère les ressources d'un agent terminé (sujet archivé). */
  forget(agentId: string): void {
    const a = this.live.get(agentId);
    if (a?.exited) {
      a.mirror.dispose();
      this.live.delete(agentId);
    }
  }

  forgetTopic(topicId: string): void {
    for (const a of [...this.live.values()]) if (a.topicId === topicId) this.forget(a.id);
  }

  /** Taille imposée par le client qui a la main ; une taille absurde est ignorée. */
  resize(agentId: string, cols: number, rows: number): boolean {
    const a = this.live.get(agentId);
    if (!a || a.exited || !Number.isInteger(cols) || !Number.isInteger(rows)) return false;
    if (cols < 2 || rows < 2 || cols > 1000 || rows > 1000) return false;
    a.pty.resize(cols, rows);
    a.mirror.resize(cols, rows);
    a.size = { cols, rows };
    return true;
  }
}
