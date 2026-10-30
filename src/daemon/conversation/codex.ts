import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  type AgentSettings,
  DEFAULT_SETTINGS,
  type ModelOption,
} from '../../shared/agentSettings.js';
import type { PendingOption, PendingRequest } from '../../shared/model.js';
import {
  type AttachedFile,
  type ConversationDriver,
  type ConversationDriverOptions,
  type ConversationEvent,
  INLINE_IMAGE_TYPES,
  withAttachmentPaths,
} from './driver.js';

const SIGTERM_DELAY_MS = 2_000;
const SIGKILL_DELAY_MS = 5_000;
const STDERR_TAIL_MAX = 4_000;
const OUT_BUFFER_MAX = 8 * 1024 * 1024;
const AID_CLIENT_VERSION = '0.4.0';

const APPROVAL_OPTIONS: PendingOption[] = [
  { label: 'Autoriser', answer: 'yes' },
  { label: 'Toujours autoriser', answer: 'always' },
  { label: 'Refuser', answer: 'no' },
];

interface JsonRpcError {
  code: number;
  message: string;
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (error: JsonRpcError) => void;
}

interface PendingApproval {
  rawId: unknown;
}

/**
 * Chantier 17 (R.5) : la commande d'une demande d'approbation. Observé (0.157.0, D77) : `command` est enveloppée
 * (`/bin/zsh -lc '…'`), `commandActions[].command` porte la commande telle que l'agent l'a écrite. L'enveloppe
 * ouverte rend ce qui s'exécute ; à défaut `command` telle quelle (le tri sait ouvrir un `sh -c`), et les actions
 * de codex, résumé qui peut écarter des morceaux, en dernier (revue R.5).
 */
function commandOf(params: Record<string, unknown> | undefined): { command: string } | undefined {
  const raw = typeof params?.command === 'string' ? params.command : null;
  const wrapped = raw && /^(?:\S*\/)?(?:ba|z|da|k)?sh -l?c '((?:[^']|'\\'')*)'$/s.exec(raw);
  if (wrapped) return { command: wrapped[1]!.replace(/'\\''/g, "'") };
  if (raw) return { command: raw };
  const actions = Array.isArray(params?.commandActions) ? params.commandActions : [];
  const parts = actions
    .map((a) => (a as { command?: unknown } | null)?.command)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  if (parts.length > 0) return { command: parts.join(' && ') };
  return typeof params?.command === 'string' ? { command: params.command } : undefined;
}

function summarize(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 160) : JSON.stringify(value).slice(0, 160);
}

const FILE_CHANGE_DIFF_MAX = 64 * 1024;

interface FileChangeEntry {
  path?: unknown;
  kind?: { type?: unknown };
  diff?: unknown;
}

function fileChangeSummary(changes: unknown): Array<{ path: string; kind: string }> {
  if (!Array.isArray(changes)) return [];
  return changes.map((c) => {
    const entry = c as FileChangeEntry;
    return {
      path: typeof entry.path === 'string' ? entry.path : '',
      kind: typeof entry.kind?.type === 'string' ? entry.kind.type : '',
    };
  });
}

function fileChangeDiffs(changes: unknown): string {
  if (!Array.isArray(changes)) return '';
  return changes
    .map((c) =>
      typeof (c as FileChangeEntry).diff === 'string' ? (c as FileChangeEntry).diff : '',
    )
    .join('\n')
    .slice(0, FILE_CHANGE_DIFF_MAX);
}

function errorMessageOf(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** Options D61 propres à codex, en plus du contrat commun (D59). */
export interface CodexDriverOptions extends ConversationDriverOptions {
  approvalPolicy?: string;
  sandbox?: string;
}

/** Construction des arguments : `app-server`, tout le reste passe par JSON-RPC sur stdio. */
export function buildCodexArgs(opts: ConversationDriverOptions): string[] {
  return ['app-server', ...(opts.extraArgs ?? [])];
}

/** Pilote D61 : process long-vivant `codex app-server`, JSON-RPC ligne à ligne (sans champ `jsonrpc`). */
export class CodexDriver implements ConversationDriver {
  private readonly opts: CodexDriverOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private listeners = new Set<(event: ConversationEvent) => void>();
  private outBuffer = '';
  private errTail = '';
  private exited = false;
  private stopResolvers: Array<() => void> = [];

  private nextId = 1;
  private pendingRequests = new Map<number, PendingRpc>();
  private pendingApprovals = new Map<string, PendingApproval>();

  private threadId: string;
  private phase: 'init' | 'ready' | 'turn' = 'init';
  private queue: unknown[][] = [];
  private activeTurnId: string | null = null;
  private interruptRequested = false;
  private settings: AgentSettings;
  private models: ModelOption[] = [];

  constructor(opts: CodexDriverOptions) {
    this.opts = opts;
    this.threadId = opts.sessionId;
    this.settings = opts.settings ?? DEFAULT_SETTINGS;
  }

  get sessionId(): string {
    return this.threadId;
  }

  onEvent(cb: (event: ConversationEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: ConversationEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // un listener qui lève ne doit pas interrompre le flux stdout du process.
      }
    }
  }

  start(): void {
    if (this.child) throw new Error('driver déjà démarré');
    const args = buildCodexArgs(this.opts);
    const child = (this.opts.spawnChild ?? spawn)(this.opts.bin, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.on('error', (err) => this.handleExit(null, null, err.message));
    child.stdin.on('error', () => {
      // EPIPE sur écriture après mort du process : géré par le check writable de writeRaw().
    });
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.errTail = (this.errTail + chunk.toString('utf8')).slice(-STDERR_TAIL_MAX);
    });
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    void this.handshake();
  }

  private async handshake(): Promise<void> {
    try {
      await this.sendRequest('initialize', {
        clientInfo: { name: 'aid', version: AID_CLIENT_VERSION },
      });
      if (this.exited) return;
      this.sendNotification('initialized');
      const result = this.opts.resume
        ? await this.sendRequest('thread/resume', { threadId: this.threadId })
        : await this.sendRequest('thread/start', {
            cwd: this.opts.cwd,
            approvalPolicy: this.opts.approvalPolicy ?? 'on-request',
            sandbox: this.opts.sandbox ?? 'workspace-write',
          });
      if (this.exited) return;
      if (!this.opts.resume) {
        const thread = (result as { thread?: { id?: unknown } } | undefined)?.thread;
        if (thread && typeof thread.id === 'string') this.threadId = thread.id;
      }
      this.emit({ type: 'session', sessionId: this.threadId });
      this.loadCatalog();
      this.advanceQueue();
    } catch (err) {
      if (this.exited) return;
      this.handleExit(null, null, errorMessageOf(err));
    }
  }

  private handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    errorMessage?: string,
  ): void {
    if (this.exited) return;
    this.exited = true;
    this.cancelPendingApprovals();
    this.emit({
      type: 'exit',
      code,
      signal,
      message: errorMessage !== undefined ? errorMessage : this.errTail.trim() || undefined,
    });
    this.rejectAllPending();
    const resolvers = this.stopResolvers;
    this.stopResolvers = [];
    for (const resolve of resolvers) resolve();
    this.killIfAlive();
  }

  // Une erreur JSON-RPC au handshake entraîne ce chemin alors que le process réel tourne encore
  // (contrairement à l'appel depuis `child.on('exit', …)`, où il est déjà mort) : sans ce kill
  // explicite, `stop()` croit le process mort (`this.exited`) et ne lui envoie jamais de signal.
  private killIfAlive(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, SIGKILL_DELAY_MS - SIGTERM_DELAY_MS);
    child.once('exit', () => clearTimeout(killTimer));
  }

  private cancelPendingApprovals(): void {
    for (const requestId of this.pendingApprovals.keys()) {
      this.emit({ type: 'request_cancelled', requestId });
    }
    this.pendingApprovals.clear();
  }

  private rejectAllPending(): void {
    for (const { reject } of this.pendingRequests.values()) {
      reject({ code: -32000, message: 'process terminé' });
    }
    this.pendingRequests.clear();
  }

  private onStdout(chunk: Buffer): void {
    if (this.exited) return;
    this.outBuffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.outBuffer.indexOf('\n')) >= 0) {
      const line = this.outBuffer.slice(0, idx);
      this.outBuffer = this.outBuffer.slice(idx + 1);
      if (line.trim()) this.handleLine(line);
    }
    // Ligne en cours pathologique (jamais de '\n') : bornée pour ne pas grossir la mémoire sans limite.
    if (this.outBuffer.length > OUT_BUFFER_MAX) {
      this.outBuffer = '';
    }
  }

  // Ligne non JSON ignorée : jamais d'exception qui tue le daemon.
  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const o = parsed as Record<string, unknown>;
    if (o.id !== undefined && typeof o.method === 'string') {
      this.handleServerRequest(o.id, o.method, o.params);
    } else if (o.id !== undefined) {
      this.handleResponse(o.id as number, o.result, o.error as JsonRpcError | undefined);
    } else if (typeof o.method === 'string') {
      this.handleNotification(o.method, o.params);
    }
  }

  private handleResponse(id: number, result: unknown, error: JsonRpcError | undefined): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'item/started' || method === 'item/completed') {
      this.handleItem(method, params as Record<string, unknown> | undefined);
    } else if (method === 'turn/completed') {
      this.handleTurnCompleted(params as Record<string, unknown> | undefined);
    } else if (method === 'serverRequest/resolved') {
      this.handleServerRequestResolved(params as Record<string, unknown> | undefined);
    }
    // bruit ignoré : thread/started, thread/status/changed, turn/started, mcpServer/startupStatus/updated,
    // account/*, thread/tokenUsage/updated, remoteControl/status/changed, item/agentMessage/delta,
    // thread/goal/cleared…
  }

  private handleItem(method: string, params: Record<string, unknown> | undefined): void {
    const item = params?.item as Record<string, unknown> | undefined;
    if (!item || typeof item.id !== 'string') return;
    const toolId = item.id;
    if (item.type === 'commandExecution') {
      if (method === 'item/started') {
        this.emit({
          type: 'tool_start',
          toolId,
          name: 'command',
          input: { command: item.command },
        });
      } else {
        const exitCode = item.exitCode;
        const isError =
          item.status !== 'completed' || (typeof exitCode === 'number' && exitCode !== 0);
        this.emit({
          type: 'tool_end',
          toolId,
          output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '',
          isError,
        });
      }
    } else if (item.type === 'fileChange') {
      if (method === 'item/started') {
        this.emit({
          type: 'tool_start',
          toolId,
          name: 'file_change',
          input: { changes: fileChangeSummary(item.changes) },
        });
      } else {
        this.emit({
          type: 'tool_end',
          toolId,
          output: fileChangeDiffs(item.changes),
          isError: item.status !== 'completed',
        });
      }
    } else if (item.type === 'agentMessage' && method === 'item/completed') {
      if (typeof item.text === 'string' && item.text) {
        this.emit({ type: 'message', role: 'assistant', text: item.text });
      }
    }
    // userMessage ignoré : l'appelant connaît déjà le texte envoyé.
  }

  private handleTurnCompleted(params: Record<string, unknown> | undefined): void {
    const turn = params?.turn as Record<string, unknown> | undefined;
    if (!turn) return;
    const status = turn.status;
    const ok = status === 'completed';
    this.emit({
      type: 'turn_end',
      ok,
      durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : undefined,
      error: ok
        ? undefined
        : status === 'interrupted'
          ? 'interrompu'
          : String(turn.error ?? status),
    });
    this.cancelPendingApprovals();
    this.advanceQueue();
  }

  private handleServerRequestResolved(params: Record<string, unknown> | undefined): void {
    const key = String(params?.requestId);
    if (this.pendingApprovals.has(key)) {
      this.pendingApprovals.delete(key);
      this.emit({ type: 'request_cancelled', requestId: key });
    }
  }

  private handleServerRequest(id: unknown, method: string, params: unknown): void {
    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    ) {
      this.handleApprovalRequest(id, method, params as Record<string, unknown> | undefined);
      return;
    }
    // méthode serveur→client inconnue : on répond toujours pour ne jamais bloquer le serveur.
    this.writeRaw({ id, error: { code: -32601, message: 'méthode non prise en charge' } });
  }

  private handleApprovalRequest(
    id: unknown,
    method: string,
    params: Record<string, unknown> | undefined,
  ): void {
    const key = String(id);
    this.pendingApprovals.set(key, { rawId: id });
    const question =
      method === 'item/commandExecution/requestApproval'
        ? `Commande : ${summarize(params?.command)} (${String(params?.cwd ?? '')})`
        : `Fichiers : ${summarize(params?.files ?? params)}`;
    const request: PendingRequest = {
      id: key,
      kind: 'permission',
      question,
      options: APPROVAL_OPTIONS,
      ...(method === 'item/commandExecution/requestApproval' && commandOf(params)),
    };
    this.emit({ type: 'request', request });
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pendingRequests.set(id, { resolve, reject });
      this.writeRaw(params === undefined ? { id, method } : { id, method, params });
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    this.writeRaw(params === undefined ? { method } : { method, params });
  }

  private writeRaw(obj: unknown): void {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  private advanceQueue(): void {
    this.activeTurnId = null;
    this.phase = 'ready';
    const next = this.queue.shift();
    if (next !== undefined) this.startTurn(next);
  }

  private startTurn(input: unknown[]): void {
    this.phase = 'turn';
    this.interruptRequested = false;
    this.sendRequest('turn/start', {
      threadId: this.threadId,
      input,
      ...this.turnSettings(),
    })
      .then((result) => {
        if (this.exited) return;
        const turn = (result as { turn?: { id?: unknown } } | undefined)?.turn;
        if (turn && typeof turn.id === 'string') this.activeTurnId = turn.id;
        if (this.interruptRequested && this.activeTurnId) this.sendInterrupt();
      })
      .catch((err: unknown) => {
        if (this.exited) return;
        this.emit({ type: 'turn_end', ok: false, error: errorMessageOf(err) });
        this.advanceQueue();
      });
  }

  /** D68 : `turn/start` porte le réglage courant, valable pour ce tour et les suivants. */
  private turnSettings(): Record<string, unknown> {
    const s = this.settings;
    // jamais le `isDefault` du catalogue : il passerait devant le modèle de ~/.codex/config.toml
    return {
      approvalPolicy: s.mode === 'auto' ? 'never' : (this.opts.approvalPolicy ?? 'on-request'),
      ...(s.model && { model: s.model }),
      ...(s.effort && { effort: s.effort }),
    };
  }

  /** D71 : catalogue annoncé par `model/list` ; une CLI qui ne répond pas laisse « Par défaut » seul. */
  private loadCatalog(): void {
    this.sendRequest('model/list', {})
      .then((result) => {
        const data = (result as { data?: unknown } | undefined)?.data;
        if (!Array.isArray(data)) return;
        const visible = (data as Record<string, unknown>[]).filter(
          (m) => m && typeof m.id === 'string' && m.hidden !== true,
        );
        this.models = visible.map((m) => ({
          id: m.id as string,
          label: typeof m.displayName === 'string' ? m.displayName : (m.id as string),
          efforts: Array.isArray(m.supportedReasoningEfforts)
            ? (m.supportedReasoningEfforts as { reasoningEffort?: unknown }[])
                .map((e) => e.reasoningEffort)
                .filter((e): e is string => typeof e === 'string')
            : [],
        }));
      })
      .catch(() => {
        // pas de `model/list` sur cette version : rien à proposer de plus que le défaut
      });
  }

  catalog(): ModelOption[] {
    return this.models;
  }

  configure(settings: AgentSettings): void {
    this.settings = settings;
  }

  send(text: string, files: AttachedFile[] = []): void {
    if (this.exited) return;
    // D70 : `localImage` pour une image, le chemin dans le texte pour le reste
    const input = [
      { type: 'text', text: withAttachmentPaths(text, files) },
      ...files
        .filter((f) => INLINE_IMAGE_TYPES.has(f.type))
        .map((f) => ({ type: 'localImage', path: f.path })),
    ];
    if (this.phase === 'ready') this.startTurn(input);
    else this.queue.push(input);
  }

  private sendInterrupt(): void {
    this.interruptRequested = false;
    this.sendRequest('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    }).catch(() => {
      // le tour est sans doute déjà terminé entre-temps : `turn/completed` a déjà été ou sera émis.
    });
  }

  interrupt(): void {
    if (this.exited || this.phase !== 'turn') return;
    // `turn/start` n'a pas encore répondu : `activeTurnId` arrive plus tard, dans son `.then()` —
    // sans ce drapeau, la demande d'interruption serait perdue silencieusement.
    if (!this.activeTurnId) {
      this.interruptRequested = true;
      return;
    }
    this.sendInterrupt();
  }

  answer(requestId: string, decision: 'yes' | 'always' | 'no'): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) throw new Error(`requête d'approbation inconnue : ${requestId}`);
    this.pendingApprovals.delete(requestId);
    const serverDecision =
      decision === 'yes' ? 'accept' : decision === 'always' ? 'acceptForSession' : 'decline';
    this.writeRaw({ id: pending.rawId, result: { decision: serverDecision } });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const child = this.child;
      if (!child || this.exited) {
        resolve();
        return;
      }
      this.stopResolvers.push(resolve);
      child.stdin.end();
      const term = setTimeout(() => child.kill('SIGTERM'), SIGTERM_DELAY_MS);
      const kill = setTimeout(() => child.kill('SIGKILL'), SIGKILL_DELAY_MS);
      child.once('exit', () => {
        clearTimeout(term);
        clearTimeout(kill);
      });
    });
  }
}
