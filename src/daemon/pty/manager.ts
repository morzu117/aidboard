import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import { monotonicFactory } from 'ulid';
import {
  type AgentOptions,
  type AgentSettings,
  agentOptions,
  DEFAULT_SETTINGS,
  MODES,
  type ModelOption,
  type PermissionMode,
} from '../../shared/agentSettings.js';
import type { Agent, PendingOption, PendingRequest } from '../../shared/model.js';
import type { AidConfig } from '../config.js';
import { buildClaudeArgs, ClaudeDriver } from '../conversation/claude.js';
import { buildCodexArgs, CodexDriver } from '../conversation/codex.js';
import type { ConversationDriver, ConversationEvent } from '../conversation/driver.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { clip } from '../events/status.js';
import type { EventStore } from '../events/store.js';
import type { AidPaths } from '../paths.js';
import { type AuthState, issueRunToken } from '../security.js';
import { LogWriter } from './log.js';
import { type Estimate, estimate } from './heuristic.js';
import { TerminalMirror } from './mirror.js';
import { getPty } from './native.js';
import {
  agentCommand,
  agentEnv,
  hookEnv,
  meshEnv,
  resolveOnPath,
  type SpawnKind,
} from './spawn.js';
import { meshPaths } from '../mesh/paths.js';
import { homedir } from 'node:os';

const ulid = monotonicFactory();
const INITIAL = { cols: 120, rows: 32 };
// Bordures que les TUI (dont claude lui-même) dessinent au-dessus du champ de saisie : une ligne
// non vide mais sans contenu, qui écrase l'aperçu d'un agent inactif si on ne l'exclut pas.
const DECORATIVE_LINE = /^[\s─-╿]+$/;

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

/** Agent conversationnel (D62) : table à part plutôt qu'un `LiveAgent` discriminé, pour ne rien changer aux appelants PTY. */
export interface LiveStream {
  id: string;
  topicId: string;
  runId: string;
  workspaceId: string;
  kind: SpawnKind;
  driver: ConversationDriver;
  exited: boolean;
  exit: { exitCode: number | null; signal: NodeJS.Signals | null; reason: string } | null;
  stopReason?: StopReason;
  /** numéro de ligne croissant dans `agent_messages`, propre à cet agent. */
  seq: number;
  /** demandes arrivées pendant qu'une autre est en cours (outils lancés en parallèle) : affichées une à une. */
  queued: PendingRequest[];
  subscribe(cb: (ev: ConversationEvent) => void): () => void;
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

// la touche de chaque réponse : jamais fournie par l'agent (voir PendingOption)
const KEYS: Record<string, string> = { yes: '1', always: '2', no: '\u001b' };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** L'option est-elle encore à l'écran ? Permission : « 1. Yes » (« 2. Yes » pour toujours) ; question : « n. libellé ». */
export function screenShows(screen: string[], o: PendingOption): boolean {
  const re =
    o.answer === 'always'
      ? /\b2\.\s+(Yes|Oui)\b/
      : o.answer === 'yes' || o.answer === 'no'
        ? /\b1\.\s+(Yes|Oui)\b/
        : new RegExp(`\\b${o.answer}\\.\\s+${escapeRe(o.label.slice(0, 24))}`);
  return screen.some((l) => re.test(l));
}

function summarizeToolInput(input: unknown): string {
  try {
    return JSON.stringify(input).slice(0, 160);
  } catch {
    return String(input);
  }
}

function signalGroup(a: LiveAgent, signal: NodeJS.Signals): void {
  try {
    process.kill(-a.pty.pid, signal);
  } catch {
    a.pty.kill(signal);
  }
}

function readLogTail(path: string, max: number): string {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, 'r');
    try {
      const len = Math.min(size, max);
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

export class AgentManager {
  private live = new Map<string, LiveAgent>();
  private streams = new Map<string, LiveStream>();
  /** D71 : dernier catalogue annoncé par un pilote codex, gardé après sa sortie. */
  private codexCatalog: ModelOption[] = [];
  // à part de `LiveStream` (interface publique, D62) : `recordStreamEvent` et `inputStream` en ont besoin hors du closure de `spawnStream`.
  private streamSubscribers = new Map<string, Set<(ev: ConversationEvent) => void>>();
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
      if (
        a.exited ||
        a.hooked ||
        a.paused ||
        (a.kind !== 'claude' && a.kind !== 'codex' && a.kind !== 'swairm-cell')
      )
        continue;
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

  getStream(agentId: string): LiveStream | undefined {
    return this.streams.get(agentId);
  }

  /** Les agents vivants, non sortis (cycle de reprise propre du daemon). */
  liveAgents(): LiveAgent[] {
    return [...this.live.values()].filter((a) => !a.exited);
  }

  spawn(o: { topicId: string; kind: SpawnKind }): Agent {
    if (
      this.deps.config.agents.transport === 'stream' &&
      (o.kind === 'claude' || o.kind === 'codex')
    ) {
      return this.spawnStream({ topicId: o.topicId, kind: o.kind });
    }
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

    // 12.6 : une session par cell (session-id persistant côté swarph) ; et pas de cell sans `mesh.cell`
    let meshSpawn: { bin: string; cellFile: string } | undefined;
    if (o.kind === 'swarph-cell') {
      if (!config.mesh.cell)
        throw new AidHttpError(409, 'mesh désactivé : `mesh.cell` vide dans config.yaml');
      const deja = this.liveAgents().find((a) => a.kind === 'swarph-cell');
      if (deja)
        throw new AidHttpError(
          409,
          `la cell ${config.mesh.cell} est déjà ouverte (agent ${deja.id}) : une seule session par cell`,
        );
      const p = meshPaths(config.mesh, process.env.HOME ?? homedir());
      meshSpawn = { bin: config.mesh.bin, cellFile: p.cellFile };
    }
    if (o.kind === 'swairm-cell') {
      if (!config.swairm.bin)
        throw new AidHttpError(409, 'Swairm désactivé : `swairm.bin` vide dans config.yaml');
      const deja = this.liveAgents().find((a) => a.kind === 'swairm-cell');
      if (deja)
        throw new AidHttpError(
          409,
          `la cell Swairm est déjà ouverte (agent ${deja.id}) : une seule session par daemon`,
        );
    }
    const [bin = '', ...args] = agentCommand(o.kind, process.env, meshSpawn, config.swairm);
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
    Object.assign(env, meshEnv(o.kind, config.mesh));
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
      sessionId: null,
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

  /** Construction partagée du pilote (D59-D62) : `spawnStream` et la relance (A.6) en ont besoin à l'identique. */
  private createStream(o: {
    agentId: string;
    topic: TopicRow;
    runId: string;
    kind: 'claude' | 'codex';
    sessionId: string;
    resume: boolean;
    seq: number;
    settings: AgentSettings;
  }): { stream: LiveStream; command: string[] } {
    const { paths, config, auth } = this.deps;
    const file = resolveOnPath(o.kind, process.env.PATH ?? '');
    if (!file) throw new AidHttpError(422, `${o.kind} introuvable dans le PATH du daemon`);
    // pas de hookEnv() (D62) : le pilote est la seule source de statut pour un agent `stream`.
    const env = agentEnv(process.env, config.env.strip, {
      AID_URL: `http://127.0.0.1:${this.deps.port()}`,
      AID_TOKEN: issueRunToken(auth, o.runId),
      AID_TOPIC: o.topic.id,
      AID_RUN: o.runId,
      AID_AGENT: o.agentId,
      AID_SPOOL: paths.spool,
    });
    // D70 : le dossier existe avant le lancement, `--add-dir` le désigne à claude
    const attachmentsDir = join(paths.attachments, o.agentId);
    mkdirSync(attachmentsDir, { recursive: true, mode: 0o700 });
    const driverOpts = {
      bin: file,
      cwd: o.topic.worktree,
      env,
      sessionId: o.sessionId,
      resume: o.resume,
      settings: o.settings,
      attachmentsDir,
    };
    const driver: ConversationDriver =
      o.kind === 'claude' ? new ClaudeDriver(driverOpts) : new CodexDriver(driverOpts);
    const args = o.kind === 'claude' ? buildClaudeArgs(driverOpts) : buildCodexArgs(driverOpts);
    const command = [file, ...args];

    const subscribers = new Set<(ev: ConversationEvent) => void>();
    const stream: LiveStream = {
      id: o.agentId,
      topicId: o.topic.id,
      runId: o.runId,
      workspaceId: o.topic.workspace_id,
      kind: o.kind,
      driver,
      exited: false,
      exit: null,
      seq: o.seq,
      queued: [],
      subscribe: (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
    };
    this.streamSubscribers.set(o.agentId, subscribers);
    this.wireStream(stream);
    this.streams.set(o.agentId, stream);
    driver.start();
    return { stream, command };
  }

  /** Agent conversationnel (D59-D62) : même sujet/run/worktree que la voie PTY, process piloté par `ConversationDriver`. */
  private spawnStream(o: { topicId: string; kind: 'claude' | 'codex' }): Agent {
    const { db, store } = this.deps;
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

    const agentId = `ag_${ulid()}`;
    const sessionId = o.kind === 'claude' ? randomUUID() : '';
    const settings = this.defaultSettings(o.kind);
    const { command } = this.createStream({
      agentId,
      topic,
      runId: run.id,
      kind: o.kind,
      sessionId,
      resume: false,
      seq: 0,
      settings,
    });

    const now = new Date().toISOString();
    store.append(
      {
        source: 'daemon',
        type: 'agent.spawned',
        workspaceId: topic.workspace_id,
        topicId: topic.id,
        runId: run.id,
        agentId,
        data: { kind: o.kind, role: 'free', cwd: topic.worktree, pid: null, command },
      },
      (tx) =>
        tx
          .prepare(
            "INSERT INTO agents (id, run_id, kind, role, transport, status, cwd, command, pid, session_id, created_at, updated_at) VALUES (?, ?, ?, 'free', 'stream', 'starting', ?, ?, NULL, ?, ?, ?)",
          )
          .run(
            agentId,
            run.id,
            o.kind,
            topic.worktree,
            JSON.stringify(command),
            sessionId || null,
            now,
            now,
          ),
    );
    store.append({
      source: 'daemon',
      type: 'agent.settings',
      workspaceId: topic.workspace_id,
      topicId: topic.id,
      runId: run.id,
      agentId,
      data: { kind: o.kind, ...settings },
    });
    return {
      id: agentId,
      runId: run.id,
      kind: o.kind,
      role: 'free',
      transport: 'stream',
      status: 'starting',
      cwd: topic.worktree,
      command,
      pid: null,
      sessionId: sessionId || null,
      permissionMode: settings.mode,
      model: settings.model,
      effort: settings.effort,
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

  /** Relance paresseuse (A.6, D51) : un agent `stream` en veille repart sous le même id au prochain message. */
  private streamOrResume(agentId: string): LiveStream {
    const existing = this.streams.get(agentId);
    if (existing && !existing.exited) return existing;
    const row = this.deps.db
      .prepare('SELECT run_id, kind, transport, session_id FROM agents WHERE id = ?')
      .get(agentId) as
      { run_id: string; kind: SpawnKind; transport: string; session_id: string | null } | undefined;
    if (!row) throw new AidHttpError(404, 'agent inconnu');
    if (row.transport !== 'stream') throw new AidHttpError(409, 'cet agent est terminé');
    return this.resumeStream(agentId, row);
  }

  /** Nouveau `LiveStream` sous le même agentId (A.6) : même construction que `spawnStream`, `resume: true` si une session existe déjà. */
  private resumeStream(
    agentId: string,
    row: { run_id: string; kind: SpawnKind; session_id: string | null },
  ): LiveStream {
    const { db, store } = this.deps;
    const run = db.prepare('SELECT id, topic_id FROM runs WHERE id = ?').get(row.run_id) as
      { id: string; topic_id: string } | undefined;
    if (!run) throw new AidHttpError(409, 'ce sujet n’a pas de run');
    const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(run.topic_id) as
      TopicRow | undefined;
    if (!topic) throw new AidHttpError(404, 'sujet inconnu');
    if (topic.state !== 'active') throw new AidHttpError(409, 'le sujet est archivé');
    if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
    const kind = row.kind as 'claude' | 'codex';
    const resume = Boolean(row.session_id);
    const sessionId = row.session_id ?? (kind === 'claude' ? randomUUID() : '');
    const seqRow = db
      .prepare('SELECT MAX(seq) AS maxSeq FROM agent_messages WHERE agent_id = ?')
      .get(agentId) as { maxSeq: number | null };
    const { stream } = this.createStream({
      agentId,
      topic,
      runId: run.id,
      kind,
      sessionId,
      resume,
      seq: seqRow.maxSeq ?? 0,
      settings: this.settingsOf(agentId),
    });
    store.append({
      source: 'daemon',
      type: 'agent.resumed',
      workspaceId: topic.workspace_id,
      topicId: topic.id,
      runId: run.id,
      agentId,
      data: {},
    });
    return stream;
  }

  /** Abonnement D52/D59 : chaque événement (sauf `thinking`) devient une ligne `agent_messages`, puis le statut qu'il implique. */
  private wireStream(stream: LiveStream): void {
    stream.driver.onEvent((ev) => {
      // pilote remplacé par une relance sous le même agentId (A.6) : l'ancien n'écrit plus rien (review A.6)
      if (this.streams.get(stream.id) !== stream) return;
      if (ev.type !== 'thinking') this.recordStreamEvent(stream, ev);
      switch (ev.type) {
        case 'session':
          this.deps.db
            .prepare('UPDATE agents SET session_id = ?, updated_at = ? WHERE id = ?')
            .run(ev.sessionId, new Date().toISOString(), stream.id);
          break;
        case 'tool_start':
          this.deps.store.append({
            source: 'daemon',
            type: 'agent.tool',
            workspaceId: stream.workspaceId,
            topicId: stream.topicId,
            runId: stream.runId,
            agentId: stream.id,
            data: { label: clip(`${ev.name} ${summarizeToolInput(ev.input)}`, 200) },
          });
          break;
        case 'request':
          // une seule demande en cours (`agents.pending`) : l'écraser rendrait la première sans réponse possible
          if (this.pendingOf(stream.id)) {
            stream.queued.push(ev.request);
            break;
          }
          this.deps.store.append({
            source: 'daemon',
            type: 'agent.status',
            workspaceId: stream.workspaceId,
            topicId: stream.topicId,
            runId: stream.runId,
            agentId: stream.id,
            data: { status: 'needs_input', reason: 'permission', pending: ev.request },
          });
          break;
        case 'request_cancelled':
          stream.queued = stream.queued.filter((r) => r.id !== ev.requestId);
          if (this.pendingOf(stream.id)?.id === ev.requestId) {
            if (this.showNextPending(stream)) break;
            this.deps.store.append({
              source: 'daemon',
              type: 'agent.status',
              workspaceId: stream.workspaceId,
              topicId: stream.topicId,
              runId: stream.runId,
              agentId: stream.id,
              data: { status: 'working' },
            });
          }
          break;
        case 'turn_end':
          this.deps.store.append({
            source: 'daemon',
            type: 'agent.status',
            workspaceId: stream.workspaceId,
            topicId: stream.topicId,
            runId: stream.runId,
            agentId: stream.id,
            data: { status: 'idle', ...(ev.ok ? {} : { message: ev.error }) },
          });
          break;
        case 'exit':
          stream.exited = true;
          stream.exit = {
            exitCode: ev.code,
            signal: ev.signal,
            reason: stream.stopReason ?? 'exit',
          };
          this.deps.store.append({
            source: 'daemon',
            type: 'agent.exited',
            workspaceId: stream.workspaceId,
            topicId: stream.topicId,
            runId: stream.runId,
            agentId: stream.id,
            data: stream.exit,
          });
          break;
        default:
          break;
      }
    });
  }

  private recordStreamEvent(stream: LiveStream, ev: ConversationEvent): void {
    const seq = ++stream.seq;
    this.deps.db
      .prepare(
        'INSERT INTO agent_messages (agent_id, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(stream.id, seq, ev.type, JSON.stringify(ev), new Date().toISOString());
    for (const cb of this.streamSubscribers.get(stream.id) ?? []) cb(ev);
  }

  /** D67 : le dernier réglage choisi pour ce kind, sinon celui de la CLI. */
  private defaultSettings(kind: 'claude' | 'codex'): AgentSettings {
    const row = this.deps.db
      .prepare('SELECT permission_mode, model, effort FROM agent_defaults WHERE kind = ?')
      .get(kind) as
      { permission_mode: string; model: string | null; effort: string | null } | undefined;
    if (!row || !MODES[kind].some((m) => m.id === row.permission_mode))
      return { ...DEFAULT_SETTINGS };
    return { mode: row.permission_mode as PermissionMode, model: row.model, effort: row.effort };
  }

  /** Le réglage propre à l'agent (A.6 : repris tel quel à la relance) ; un agent d'avant le chantier 16 n'en a pas. */
  private settingsOf(agentId: string): AgentSettings {
    const row = this.deps.db
      .prepare('SELECT permission_mode, model, effort FROM agents WHERE id = ?')
      .get(agentId) as
      { permission_mode: string | null; model: string | null; effort: string | null } | undefined;
    if (!row?.permission_mode) return { ...DEFAULT_SETTINGS };
    return { mode: row.permission_mode as PermissionMode, model: row.model, effort: row.effort };
  }

  private streamKindOr409(agentId: string): 'claude' | 'codex' {
    const row = this.deps.db
      .prepare('SELECT kind, transport FROM agents WHERE id = ?')
      .get(agentId) as { kind: string; transport: string } | undefined;
    if (!row) throw new AidHttpError(404, 'agent inconnu');
    if (row.transport !== 'stream' || (row.kind !== 'claude' && row.kind !== 'codex'))
      throw new AidHttpError(409, 'réservé aux agents conversationnels');
    return row.kind;
  }

  /** D71 : ce que le composer peut proposer pour cet agent. */
  options(agentId: string): AgentOptions {
    const kind = this.streamKindOr409(agentId);
    for (const s of this.streams.values()) {
      const catalog = s.kind === 'codex' ? s.driver.catalog?.() : undefined;
      if (catalog?.length) this.codexCatalog = catalog;
    }
    return agentOptions(kind, this.codexCatalog);
  }

  /** D68/D69 : journalisé, puis appliqué au pilote vivant ; un agent en veille le prend à sa relance. */
  setSettings(agentId: string, patch: Partial<AgentSettings>): AgentSettings {
    const kind = this.streamKindOr409(agentId);
    const next: AgentSettings = { ...this.settingsOf(agentId), ...patch };
    const options = this.options(agentId);
    if (!options.modes.some((m) => m.id === next.mode))
      throw new AidHttpError(422, `mode inconnu pour ${kind} : ${next.mode}`);
    const model = next.model === null ? undefined : options.models.find((m) => m.id === next.model);
    if (next.model !== null && !model)
      throw new AidHttpError(422, `modèle inconnu pour ${kind} : ${next.model}`);
    const efforts = model?.efforts.length ? model.efforts : options.efforts;
    if (next.effort !== null && !efforts.includes(next.effort))
      throw new AidHttpError(422, `effort inconnu : ${next.effort}`);
    const ids = this.deps.db
      .prepare(
        'SELECT a.run_id, r.topic_id, t.workspace_id FROM agents a JOIN runs r ON r.id = a.run_id JOIN topics t ON t.id = r.topic_id WHERE a.id = ?',
      )
      .get(agentId) as { run_id: string; topic_id: string; workspace_id: string } | undefined;
    this.deps.store.append({
      source: 'daemon',
      type: 'agent.settings',
      workspaceId: ids?.workspace_id,
      topicId: ids?.topic_id,
      runId: ids?.run_id,
      agentId,
      data: { kind, ...next },
    });
    const live = this.streams.get(agentId);
    if (live && !live.exited) live.driver.configure(next);
    return next;
  }

  private streamOr409(agentId: string): LiveStream {
    if (!this.deps.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId))
      throw new AidHttpError(404, 'agent inconnu');
    const s = this.streams.get(agentId);
    if (!s || s.exited) throw new AidHttpError(409, 'cet agent est terminé');
    return s;
  }

  /** Arrêt du tour en cours (D64) : réservé aux agents conversationnels, l'équivalent de la pause pour eux. */
  interrupt(agentId: string): void {
    if (this.live.has(agentId))
      throw new AidHttpError(409, 'interruption réservée aux agents conversationnels');
    this.streamOr409(agentId).driver.interrupt();
  }

  // Arrêt par paliers : SIGINT puis SIGTERM (la spec), SIGHUP pour un shell interactif qui ignore SIGTERM,
  // et SIGKILL du groupe entier à l'échéance (claude lance des serveurs MCP et codegraph en enfants).
  stop(agentId: string, reason: StopReason, graceMs = 5000): Promise<void> {
    const s = this.streams.get(agentId);
    if (s) return this.stopStream(s, reason);
    const a = this.live.get(agentId);
    if (!a || a.exited) return Promise.resolve();
    a.stopReason = reason;
    // un process stoppé ne traite aucun signal d'arrêt avant d'être relancé
    if (a.paused) {
      signalGroup(a, 'SIGCONT');
      a.paused = false;
    }
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

  /** `stop()` résout quand le process a fini de sortir : pas de paliers de signal, `driver.stop()` a les siens. */
  private async stopStream(s: LiveStream, reason: StopReason): Promise<void> {
    if (s.exited) return;
    s.stopReason = reason;
    await s.driver.stop();
  }

  async stopAll(reason: StopReason, timeoutMs: number): Promise<void> {
    const alive = [...this.live.values()].filter((a) => !a.exited);
    const aliveStreams = [...this.streams.values()].filter((s) => !s.exited);
    await Promise.all([
      ...alive.map((a) => this.stop(a.id, reason, timeoutMs)),
      ...aliveStreams.map((s) => this.stop(s.id, reason, timeoutMs)),
    ]);
  }

  /** Libère les ressources d'un agent terminé (sujet archivé). */
  forget(agentId: string): void {
    const s = this.streams.get(agentId);
    if (s?.exited) {
      this.streams.delete(agentId);
      this.streamSubscribers.delete(agentId);
      return;
    }
    const a = this.live.get(agentId);
    if (a?.exited) {
      a.mirror.dispose();
      this.live.delete(agentId);
    }
  }

  /** Ferme un agent terminé : il disparaît de l'état, sans toucher à son historique d'événements. */
  close(agentId: string): void {
    const row = this.deps.db
      .prepare(
        'SELECT a.run_id, r.topic_id, t.workspace_id FROM agents a JOIN runs r ON r.id = a.run_id JOIN topics t ON t.id = r.topic_id WHERE a.id = ?',
      )
      .get(agentId) as { run_id: string; topic_id: string; workspace_id: string } | undefined;
    // passer par le store, pas un UPDATE nu : l'événement diffusé fait relire l'état au navigateur
    this.deps.store.append(
      {
        source: 'daemon',
        type: 'agent.closed',
        workspaceId: row?.workspace_id,
        topicId: row?.topic_id,
        runId: row?.run_id,
        agentId,
        data: {},
      },
      (tx) =>
        tx
          .prepare('UPDATE agents SET closed_at = ? WHERE id = ?')
          .run(new Date().toISOString(), agentId),
    );
    this.forget(agentId);
  }

  forgetTopic(topicId: string): void {
    for (const a of [...this.live.values()]) if (a.topicId === topicId) this.forget(a.id);
    for (const s of [...this.streams.values()]) if (s.topicId === topicId) this.forget(s.id);
  }

  private liveOr409(agentId: string): LiveAgent {
    if (!this.deps.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId))
      throw new AidHttpError(404, 'agent inconnu');
    const a = this.live.get(agentId);
    if (!a || a.exited) throw new AidHttpError(409, 'cet agent est terminé');
    return a;
  }

  private pendingOf(agentId: string): PendingRequest | null {
    const row = this.deps.db.prepare('SELECT pending FROM agents WHERE id = ?').get(agentId) as
      { pending: string | null } | undefined;
    return row?.pending ? (JSON.parse(row.pending) as PendingRequest) : null;
  }

  /** Les dernières lignes non vides de l'écran (aperçu de la carte). Agent d'avant le redémarrage : son journal. */
  screen(agentId: string, lines: number): string[] {
    if (!this.deps.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId))
      throw new AidHttpError(404, 'agent inconnu');
    const n = Math.min(Math.max(1, Math.trunc(lines) || 6), 40);
    if (this.streams.has(agentId)) return this.streamScreen(agentId, n);
    const live = this.live.get(agentId);
    let screen: string[];
    if (live) screen = live.mirror.screen();
    else {
      const bytes = readLogTail(join(this.deps.paths.logs, `${agentId}.log`), 256 * 1024);
      const m = TerminalMirror.fromLog(bytes, INITIAL.cols, INITIAL.rows, 0);
      screen = m.screen();
      m.dispose();
    }
    return screen
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !DECORATIVE_LINE.test(l))
      .slice(-n);
  }

  /** Aperçu d'un agent conversationnel : la fin du dernier message assistant, lu dans `agent_messages`. */
  private streamScreen(agentId: string, n: number): string[] {
    const rows = this.deps.db
      .prepare(
        "SELECT payload FROM agent_messages WHERE agent_id = ? AND kind = 'message' ORDER BY seq DESC LIMIT 50",
      )
      .all(agentId) as { payload: string }[];
    const lines: string[] = [];
    for (const row of rows) {
      const ev = JSON.parse(row.payload) as { role?: string; text?: string };
      if (ev.role !== 'assistant' || typeof ev.text !== 'string') continue;
      lines.unshift(...ev.text.split('\n'));
      if (lines.length >= n) break;
    }
    return lines.filter((l) => l.trim()).slice(-n);
  }

  /** Agent `stream` absent de la mémoire (daemon redémarré) : seul `input` le relance, jamais au démarrage (D63/A.6). */
  private dormantStream(agentId: string): boolean {
    if (this.live.has(agentId)) return false;
    const row = this.deps.db.prepare('SELECT transport FROM agents WHERE id = ?').get(agentId) as
      { transport: string } | undefined;
    return row?.transport === 'stream';
  }

  /** Un message tapé pour l'agent : le texte, puis Entrée. Plusieurs lignes passent en collage encadré. */
  input(agentId: string, raw: string): void {
    if (this.streams.has(agentId) || this.dormantStream(agentId)) {
      this.inputStream(agentId, raw);
      return;
    }
    const a = this.liveOr409(agentId);
    const text = raw.replace(/\r\n?/g, '\n');
    // aucune séquence de contrôle : elle sortirait du collage encadré ou piloterait le terminal
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text))
      throw new AidHttpError(422, 'caractère de contrôle refusé');
    if (!text.trim()) throw new AidHttpError(422, 'message vide');
    if (a.paused) throw new AidHttpError(409, 'agent en pause : le reprendre d’abord');
    if (this.pendingOf(agentId))
      throw new AidHttpError(409, 'répondre d’abord à la demande en cours');
    a.pty.write(text.includes('\n') ? `\u001b[200~${text}\u001b[201~` : text);
    // un Entrée collé au texte serait lu comme une partie du collage par certains TUI
    setTimeout(() => !a.exited && a.pty.write('\r'), 60);
  }

  /** Même message qu'au clavier (D59) : une ligne `agent_messages`, le statut `working`, puis le pilote. */
  private inputStream(agentId: string, raw: string): void {
    const text = raw.replace(/\r\n?/g, '\n');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text))
      throw new AidHttpError(422, 'caractère de contrôle refusé');
    if (!text.trim()) throw new AidHttpError(422, 'message vide');
    if (this.pendingOf(agentId))
      throw new AidHttpError(409, 'répondre d’abord à la demande en cours');
    // validé : la relance (et son éventuel 404/409) n'a lieu que pour un message qui sera effectivement envoyé (review A.6)
    const s = this.streamOrResume(agentId);
    this.recordStreamEvent(s, { type: 'message', role: 'user', text });
    this.deps.store.append({
      source: 'daemon',
      type: 'agent.status',
      workspaceId: s.workspaceId,
      topicId: s.topicId,
      runId: s.runId,
      agentId,
      data: { status: 'working' },
    });
    s.driver.send(text);
  }

  /** Répond à la demande en cours, au clavier, après avoir vérifié que l'écran la montre toujours (E4). */
  answer(agentId: string, pendingId: string, answer: string): void {
    if (this.streams.has(agentId)) {
      this.answerStream(agentId, pendingId, answer);
      return;
    }
    const a = this.liveOr409(agentId);
    const pending = this.pendingOf(agentId);
    if (!pending || pending.id !== pendingId)
      throw new AidHttpError(409, 'cette demande n’est plus en cours');
    const option = pending.options.find((o) => o.answer === answer);
    if (!option) throw new AidHttpError(422, 'réponse inconnue pour cette demande');
    const screen = a.mirror.screen();
    if (!screenShows(screen, option))
      throw new AidHttpError(409, 'l’écran ne montre plus cette demande : ouvrir le terminal');
    a.pty.write(KEYS[answer] ?? answer);
    this.deps.store.append({
      source: 'daemon',
      type: 'approval.resolved',
      workspaceId: a.workspaceId,
      topicId: a.topicId,
      runId: a.runId,
      agentId,
      data: { pendingId, option: answer, by: 'human' },
    });
  }

  /** Pas de `screenShows` (D59) : la demande en cours et ses options viennent du pilote, jamais de l'écran. */
  private answerStream(agentId: string, pendingId: string, answer: string): void {
    const s = this.streamOr409(agentId);
    const pending = this.pendingOf(agentId);
    if (!pending || pending.id !== pendingId)
      throw new AidHttpError(409, 'cette demande n’est plus en cours');
    const option = pending.options.find((o) => o.answer === answer);
    if (!option) throw new AidHttpError(422, 'réponse inconnue pour cette demande');
    s.driver.answer(pendingId, answer as 'yes' | 'always' | 'no');
    this.deps.store.append({
      source: 'daemon',
      type: 'approval.resolved',
      workspaceId: s.workspaceId,
      topicId: s.topicId,
      runId: s.runId,
      agentId,
      data: { pendingId, option: answer, by: 'human' },
    });
    this.showNextPending(s);
  }

  /** La demande suivante en file devient la demande en cours ; false si la file est vide. */
  private showNextPending(s: LiveStream): boolean {
    const next = s.queued.shift();
    if (!next) return false;
    this.deps.store.append({
      source: 'daemon',
      type: 'agent.status',
      workspaceId: s.workspaceId,
      topicId: s.topicId,
      runId: s.runId,
      agentId: s.id,
      data: { status: 'needs_input', reason: 'permission', pending: next },
    });
    return true;
  }

  /** Pause : SIGSTOP du groupe (E5). La reprise envoie SIGCONT. */
  setPaused(agentId: string, paused: boolean): void {
    if (this.streams.has(agentId))
      throw new AidHttpError(409, 'pas de pause pour un agent conversationnel : l’interrompre');
    const a = this.liveOr409(agentId);
    if (a.paused === paused)
      throw new AidHttpError(409, paused ? 'déjà en pause' : 'cet agent n’est pas en pause');
    signalGroup(a, paused ? 'SIGSTOP' : 'SIGCONT');
    a.paused = paused;
    this.deps.store.append({
      source: 'daemon',
      type: 'agent.status',
      workspaceId: a.workspaceId,
      topicId: a.topicId,
      runId: a.runId,
      agentId,
      data: { paused },
    });
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
