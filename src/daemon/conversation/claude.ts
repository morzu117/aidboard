import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { PendingOption, PendingRequest } from '../../shared/model.js';
import type { ConversationDriver, ConversationDriverOptions, ConversationEvent } from './driver.js';

const SIGTERM_DELAY_MS = 2_000;
const SIGKILL_DELAY_MS = 5_000;
const STDERR_TAIL_MAX = 4_000;
const OUT_BUFFER_MAX = 8 * 1024 * 1024;

const PERMISSION_OPTIONS: PendingOption[] = [
  { label: 'Autoriser', answer: 'yes' },
  { label: 'Toujours autoriser', answer: 'always' },
  { label: 'Refuser', answer: 'no' },
];

function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const key = ['command', 'file_path', 'pattern', 'query'].find((k) => typeof o[k] === 'string');
    if (key) return String(o[key]).slice(0, 80);
  }
  try {
    return JSON.stringify(input).slice(0, 80);
  } catch {
    return String(input);
  }
}

function textFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .join('\n');
  }
  return '';
}

interface PendingPermission {
  input: unknown;
}

/** Construction des arguments D60, séparée du spawn pour être testable sans process réel. */
export function buildClaudeArgs(opts: ConversationDriverOptions): string[] {
  return [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-prompt-tool',
    'stdio',
    opts.resume ? '--resume' : '--session-id',
    opts.sessionId,
    ...(opts.extraArgs ?? []),
  ];
}

/** Pilote D60 : process long-vivant `claude --print --input-format stream-json ...`, un message par ligne stdin. */
export class ClaudeDriver implements ConversationDriver {
  readonly sessionId: string;
  private readonly opts: ConversationDriverOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private listeners = new Set<(event: ConversationEvent) => void>();
  private outBuffer = '';
  private errTail = '';
  private pendingPermissions = new Map<string, PendingPermission>();
  private stopResolvers: Array<() => void> = [];
  private exited = false;

  constructor(opts: ConversationDriverOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
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
    const args = buildClaudeArgs(this.opts);
    const child = spawn(this.opts.bin, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.on('error', (err) => this.handleExit(null, null, err.message));
    child.stdin.on('error', () => {
      // EPIPE sur écriture après mort du process : géré par le check writable de write().
    });
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.errTail = (this.errTail + chunk.toString('utf8')).slice(-STDERR_TAIL_MAX);
    });
    child.on('exit', (code, signal) => this.handleExit(code, signal));
  }

  private handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    errorMessage?: string,
  ): void {
    if (this.exited) return;
    this.exited = true;
    this.emit({
      type: 'exit',
      code,
      signal,
      message: errorMessage !== undefined ? errorMessage : this.errTail.trim() || undefined,
    });
    this.cancelPendingPermissions();
    const resolvers = this.stopResolvers;
    this.stopResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private cancelPendingPermissions(): void {
    for (const requestId of this.pendingPermissions.keys()) {
      this.emit({ type: 'request_cancelled', requestId });
    }
    this.pendingPermissions.clear();
  }

  private onStdout(chunk: Buffer): void {
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
    if (o.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string') {
      this.emit({ type: 'session', sessionId: o.session_id });
    } else if (o.type === 'assistant') {
      this.handleAssistant(o);
    } else if (o.type === 'user') {
      this.handleUser(o);
    } else if (o.type === 'control_request') {
      this.handleControlRequest(o);
    } else if (o.type === 'result') {
      this.handleResult(o);
    }
    // hooks, rate_limit_event, thinking_tokens, permission_denied, control_response entrant… : ignorés.
  }

  private handleAssistant(o: Record<string, unknown>): void {
    const message = o.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        this.emit({ type: 'message', role: 'assistant', text: b.text });
      } else if (b.type === 'thinking') {
        this.emit({ type: 'thinking' });
      } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        this.emit({ type: 'tool_start', toolId: b.id, name: b.name, input: b.input });
      }
    }
  }

  private handleUser(o: Record<string, unknown>): void {
    const message = o.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        this.emit({
          type: 'tool_end',
          toolId: b.tool_use_id,
          output: textFromToolResultContent(b.content),
          isError: b.is_error === true,
        });
      }
    }
  }

  private handleControlRequest(o: Record<string, unknown>): void {
    const request = o.request as Record<string, unknown> | undefined;
    if (typeof o.request_id !== 'string') return;
    if (request?.subtype !== 'can_use_tool') {
      this.write({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: o.request_id,
          error: 'subtype non pris en charge',
        },
      });
      return;
    }
    const toolName = typeof request.tool_name === 'string' ? request.tool_name : 'outil';
    const input = request.input;
    this.pendingPermissions.set(o.request_id, { input });
    const pendingRequest: PendingRequest = {
      id: o.request_id,
      kind: 'permission',
      question: `${toolName} : ${summarizeInput(input)}`,
      options: PERMISSION_OPTIONS,
    };
    this.emit({ type: 'request', request: pendingRequest });
  }

  private handleResult(o: Record<string, unknown>): void {
    const ok = o.subtype === 'success';
    this.emit({
      type: 'turn_end',
      ok,
      costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined,
      durationMs: typeof o.duration_ms === 'number' ? o.duration_ms : undefined,
      error: ok ? undefined : String(o.subtype ?? 'erreur'),
    });
    this.cancelPendingPermissions();
  }

  private write(obj: unknown): void {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  send(text: string): void {
    this.write({ type: 'user', message: { role: 'user', content: text } });
  }

  interrupt(): void {
    this.write({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    });
  }

  answer(requestId: string, decision: 'yes' | 'always' | 'no'): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`requête de permission inconnue : ${requestId}`);
    this.pendingPermissions.delete(requestId);
    // 'always' se comporte comme 'yes' en v1 : pas de règle persistée.
    const response =
      decision === 'no'
        ? { behavior: 'deny', message: 'refusé par l’opérateur' }
        : { behavior: 'allow', updatedInput: pending.input };
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
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
