import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { type AgentSettings, DEFAULT_SETTINGS } from '../../shared/agentSettings.js';
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
  /** Outil AskUserQuestion : le questionnaire en cours, réponse après réponse. */
  ask?: AskState;
}

interface AskQuestion {
  question: string;
  labels: string[];
}

interface AskState {
  requestId: string;
  questions: AskQuestion[];
  answers: Record<string, string>;
}

// Au-delà, le dernier bouton est « Répondre en texte » : 9 réponses au plus par demande.
const ASK_OPTIONS_MAX = 8;
const ASK_TEXT_ANSWER: PendingOption = { label: 'Répondre en texte', answer: 'no' };

/** Les questions d'un AskUserQuestion ; null si l'entrée n'a pas la forme attendue (retombe sur la permission). */
function askQuestionsOf(input: unknown): AskQuestion[] | null {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskQuestion[] = [];
  for (const q of raw) {
    const o = (q ?? {}) as { question?: unknown; options?: unknown };
    if (typeof o.question !== 'string' || !Array.isArray(o.options)) return null;
    const labels = o.options
      .map((opt) => (opt as { label?: unknown } | null)?.label)
      .filter((l): l is string => typeof l === 'string' && l.length > 0);
    if (labels.length === 0) return null;
    questions.push({ question: o.question, labels: labels.slice(0, ASK_OPTIONS_MAX) });
  }
  return questions;
}

/** Réglages au lancement (D67) : rien de plus que les arguments d'avant quand rien n'est réglé. */
function settingsArgs(opts: ConversationDriverOptions): string[] {
  const s = opts.settings;
  return [
    ...(s && s.mode !== 'default' ? ['--permission-mode', s.mode] : []),
    ...(s?.model ? ['--model', s.model] : []),
    ...(s?.effort ? ['--effort', s.effort] : []),
    ...(opts.attachmentsDir ? ['--add-dir', opts.attachmentsDir] : []),
  ];
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
    ...settingsArgs(opts),
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
  private settings: AgentSettings;

  constructor(opts: ConversationDriverOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.settings = opts.settings ?? DEFAULT_SETTINGS;
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
    const child = (this.opts.spawnChild ?? spawn)(this.opts.bin, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.on('error', (err) => this.handleExit(null, null, err.message));
    child.stdin.on('error', () => {
      // sans ce listener, l'EPIPE d'une écriture juste après la mort du process (course avec le
      // check `writable` de write()) ferait planter le daemon faute de gestionnaire d'erreur.
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
    this.cancelPendingPermissions();
    this.emit({
      type: 'exit',
      code,
      signal,
      message: errorMessage !== undefined ? errorMessage : this.errTail.trim() || undefined,
    });
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
    const questions = toolName === 'AskUserQuestion' ? askQuestionsOf(input) : null;
    if (questions) {
      this.askNext(input, { requestId: o.request_id, questions, answers: {} });
      return;
    }
    this.pendingPermissions.set(o.request_id, { input });
    const pendingRequest: PendingRequest = {
      id: o.request_id,
      kind: 'permission',
      question: `${toolName} : ${summarizeInput(input)}`,
      options: PERMISSION_OPTIONS,
      ...(toolName === 'Bash' &&
        typeof (input as { command?: unknown } | undefined)?.command === 'string' && {
          command: (input as { command: string }).command,
        }),
      // seulement nos règles (`--settings`) : une règle `ask` de l'utilisateur distant reste une carte ordinaire
      ...(request.decision_reason_type === 'rule' &&
        request.decision_reason_rule_source === 'flagSettings' && { byRule: true }),
    };
    this.emit({ type: 'request', request: pendingRequest });
  }

  /** Une question à la fois : une demande `question` dont les options sont celles de l'outil, pas Autoriser/Refuser. */
  private askNext(input: unknown, ask: AskState): void {
    const n = Object.keys(ask.answers).length;
    const q = ask.questions[n]!;
    const id = n === 0 ? ask.requestId : `${ask.requestId}#${n}`;
    this.pendingPermissions.set(id, { input, ask });
    const prefix = ask.questions.length > 1 ? `(${n + 1}/${ask.questions.length}) ` : '';
    const options: PendingOption[] = q.labels.map((label, i) => ({
      label,
      answer: String(i + 1) as PendingOption['answer'],
    }));
    this.emit({
      type: 'request',
      request: {
        id,
        kind: 'question',
        question: `${prefix}${q.question}`,
        options: [...options, ASK_TEXT_ANSWER],
      },
    });
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

  send(text: string, files: AttachedFile[] = []): void {
    if (files.length === 0) {
      this.write({ type: 'user', message: { role: 'user', content: text } });
      return;
    }
    // D70 : les images en ligne (bloc base64), les autres fichiers par leur chemin sous --add-dir
    const images = files
      .filter((f) => INLINE_IMAGE_TYPES.has(f.type))
      .map((f) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: f.type,
          data: readFileSync(f.path).toString('base64'),
        },
      }));
    const texte = withAttachmentPaths(text, files);
    const content = [...(texte ? [{ type: 'text', text: texte }] : []), ...images];
    this.write({ type: 'user', message: { role: 'user', content } });
  }

  /** D68 : `control_request` observés sur claude 2.1.308 ; un `set_model` sans modèle revient au défaut. */
  configure(next: AgentSettings): void {
    const prev = this.settings;
    this.settings = next;
    const control = (request: Record<string, unknown>) =>
      this.write({ type: 'control_request', request_id: randomUUID(), request });
    if (next.mode !== prev.mode) control({ subtype: 'set_permission_mode', mode: next.mode });
    if (next.model !== prev.model)
      control({ subtype: 'set_model', ...(next.model && { model: next.model }) });
    if (next.effort !== prev.effort)
      control({ subtype: 'apply_flag_settings', settings: { effortLevel: next.effort } });
  }

  interrupt(): void {
    this.write({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    });
  }

  answer(requestId: string, decision: PendingOption['answer']): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`requête de permission inconnue : ${requestId}`);
    this.pendingPermissions.delete(requestId);
    const ask = pending.ask;
    if (ask && decision !== 'no') {
      const n = Object.keys(ask.answers).length;
      const q = ask.questions[n]!;
      const label = q.labels[Number(decision) - 1];
      if (label === undefined) {
        this.pendingPermissions.set(requestId, pending);
        throw new Error(`réponse inconnue : ${decision}`);
      }
      ask.answers[q.question] = label;
      if (n + 1 < ask.questions.length) {
        this.askNext(pending.input, ask);
        return;
      }
      this.write({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: ask.requestId,
          response: {
            behavior: 'allow',
            updatedInput: { ...(pending.input as object), answers: ask.answers },
          },
        },
      });
      return;
    }
    if (ask) {
      this.write({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: ask.requestId,
          response: {
            behavior: 'deny',
            message: 'L’opérateur préfère répondre en texte : arrête-toi et attends sa réponse.',
          },
        },
      });
      return;
    }
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
