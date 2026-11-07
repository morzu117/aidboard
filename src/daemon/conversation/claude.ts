import { ASK_TEXT_ANSWER } from '../../shared/question.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  type AgentSettings,
  DEFAULT_SETTINGS,
  type PermissionMode,
} from '../../shared/agentSettings.js';
import type { AgentCommand } from '../../shared/agentSettings.js';
import type { RemoteControlState } from '../../shared/agentSettings.js';
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
/** D83 : connexion et déconnexion demandent un terminal (constaté : « /login isn't available in this environment »). */
const CLAUDE_HORS_TERMINAL = new Set(['login', 'logout']);
/** D88 : la réponse à `remote_control` arrive après l'inscription de la session chez claude.ai (constaté : ~1 s). */
const REMOTE_CONTROL_TIMEOUT_MS = 30_000;

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

/** Correctif autonomie : le mode A-I-D `auto` contourne toutes les permissions chez claude (`bypassPermissions`) ; les autres passent tels quels, claude les connaissant déjà sous ce nom. */
function claudePermissionMode(mode: PermissionMode): string {
  return mode === 'auto' ? 'bypassPermissions' : mode;
}

/**
 * Réglages au lancement (D67) : rien de plus que les arguments d'avant quand rien n'est réglé.
 * Re-dev 1/2 (correctif autonomie) : `--permission-mode` est explicite dès que des réglages sont
 * connus (y compris `default`), et aussi en reprise sans réglages connus (repli sur
 * `DEFAULT_SETTINGS.mode`) — sinon une reprise en Demander omettrait le flag et la CLI pourrait
 * reprendre une permission `bypassPermissions` persistée par une session Auto précédente. Sans
 * réglages et hors reprise, le comportement d'avant ce correctif est gardé (rien à hériter).
 */
function settingsArgs(opts: ConversationDriverOptions): string[] {
  const s = opts.settings;
  const mode = s ? s.mode : opts.resume ? DEFAULT_SETTINGS.mode : undefined;
  return [
    ...(mode !== undefined ? ['--permission-mode', claudePermissionMode(mode)] : []),
    ...(s?.model ? ['--model', s.model] : []),
    ...(s?.effort ? ['--effort', s.effort] : []),
    ...(opts.attachmentsDir ? ['--add-dir', opts.attachmentsDir] : []),
  ];
}

/**
 * Construction des arguments D60, séparée du spawn pour être testable sans process réel.
 * Correctif autonomie : `--allow-dangerously-skip-permissions` est systématique — il autorise la
 * capacité de passer en `bypassPermissions` (`configure()`, au changement à chaud) sans l'activer
 * lui-même ; un process lancé hors Auto ne bascule en bypass qu'au `set_permission_mode` suivant.
 */
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
    '--allow-dangerously-skip-permissions',
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
  /** Erreur portée par un message de claude (`authentication_failed`…), rendue à la fin du tour. */
  private turnError: string | undefined;
  private commandList: AgentCommand[] = [];
  private settings: AgentSettings;
  /** D87-D89 : l'état du remote-control de ce process, et les `control_response` attendus par leur `request_id`. */
  private remote: RemoteControlState = { status: 'off' };
  private controlWaiters = new Map<string, (response: Record<string, unknown>) => void>();

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
    // D89 : le remote-control meurt avec le process ; une demande en cours n'aura pas de réponse
    const waiters = [...this.controlWaiters.values()];
    this.controlWaiters.clear();
    for (const w of waiters) w({ subtype: 'error', error: 'agent arrêté' });
    // après les attentes : leur échec poserait `error`
    this.remote = { status: 'off' };
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
      this.readCommands(o);
    } else if (o.type === 'assistant') {
      this.handleAssistant(o);
    } else if (o.type === 'user') {
      this.handleUser(o);
    } else if (o.type === 'control_request') {
      this.handleControlRequest(o);
    } else if (o.type === 'control_response') {
      this.handleControlResponse(o);
    } else if (o.type === 'system' && o.subtype === 'bridge_state') {
      this.readBridgeState(o);
    } else if (o.type === 'result') {
      this.handleResult(o);
    }
    // hooks, rate_limit_event, thinking_tokens, permission_denied… : ignorés.
  }

  /**
   * D83 : `slash_commands` de `system/init` (claude 2.1.308, renvoyé à chaque tour), sans celles qui n'ont de
   * sens que dans un terminal ni la connexion, et sans les noms internes (`__…`). Claude ne donne pas de description.
   */
  private readCommands(o: Record<string, unknown>): void {
    if (!Array.isArray(o.slash_commands)) return;
    const terminal = new Set(
      Array.isArray(o.terminal_slash_commands) ? o.terminal_slash_commands : [],
    );
    const skills = new Set(Array.isArray(o.skills) ? o.skills : []);
    this.commandList = o.slash_commands
      .filter(
        (n): n is string =>
          typeof n === 'string' &&
          /^[^_\s]\S*$/.test(n) &&
          !terminal.has(n) &&
          !CLAUDE_HORS_TERMINAL.has(n),
      )
      .map((name) => ({
        name,
        description: skills.has(name) ? 'Skill de claude' : 'Commande de claude',
        source: 'agent' as const,
      }));
  }

  commands(): AgentCommand[] {
    return this.commandList;
  }

  /** Réponse à une demande d'A-I-D : seules celles qu'on attend (`remote_control`) ont une suite. */
  private handleControlResponse(o: Record<string, unknown>): void {
    const response = o.response as Record<string, unknown> | undefined;
    const requestId = response?.request_id;
    if (typeof requestId !== 'string') return;
    const waiter = this.controlWaiters.get(requestId);
    if (!waiter) return;
    this.controlWaiters.delete(requestId);
    waiter(response!);
  }

  /** D88 : `connected` connecté, `failed` en erreur, tout autre état en connexion ; rien tant qu'il est éteint. */
  private readBridgeState(o: Record<string, unknown>): void {
    if (this.remote.status === 'off' || this.remote.status === 'unsupported') return;
    const { url } = this.remote;
    if (o.state === 'connected') this.remote = { status: 'connected', ...(url && { url }) };
    else if (o.state === 'failed')
      this.remote = {
        status: 'error',
        ...(url && { url }),
        error: typeof o.detail === 'string' && o.detail ? o.detail : 'remote-control déconnecté',
      };
    else this.remote = { status: 'connecting', ...(url && { url }) };
  }

  remoteControlState(): RemoteControlState {
    return this.remote;
  }

  /** D88 : le `control_request` `remote_control` de claude 2.1.308, sans relancer le process. */
  remoteControl(enabled: boolean, name: string): Promise<RemoteControlState> {
    if (this.exited || !this.child) return Promise.reject(new Error('agent arrêté'));
    const requestId = randomUUID();
    const avant = this.remote;
    if (enabled && avant.status !== 'connected') this.remote = { status: 'connecting' };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlWaiters.delete(requestId);
        if (enabled) this.remote = { status: 'error', error: 'claude n’a pas répondu' };
        reject(new Error('claude n’a pas répondu à la demande de remote-control'));
      }, REMOTE_CONTROL_TIMEOUT_MS);
      this.controlWaiters.set(requestId, (r) => {
        clearTimeout(timer);
        if (r.subtype !== 'success') {
          const error = typeof r.error === 'string' && r.error ? r.error : 'remote-control refusé';
          this.remote = enabled ? { status: 'error', error } : avant;
          reject(new Error(error));
          return;
        }
        const payload = (r.response ?? {}) as Record<string, unknown>;
        const url = typeof payload.session_url === 'string' ? payload.session_url : undefined;
        // `bridge_state` peut avoir dit `connected` avant la réponse : l'état déjà connu est gardé
        this.remote = enabled
          ? {
              status: this.remote.status === 'connected' ? 'connected' : 'connecting',
              ...(url && { url }),
            }
          : { status: 'off' };
        resolve(this.remote);
      });
      this.write({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'remote_control', enabled, ...(enabled && name && { name }) },
      });
    });
  }

  private handleAssistant(o: Record<string, unknown>): void {
    // message synthétique de claude 2.1 (connexion expirée…) : le texte reste au fil, la fin du tour le dit en erreur
    if (typeof o.error === 'string') this.turnError = o.error;
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
    // `success` avec `is_error` : constaté le 2026-11-02 sur une connexion OAuth expirée, le tour n'a pas eu lieu
    const ok = o.subtype === 'success' && o.is_error !== true;
    // sans code d'erreur, le texte que claude a mis dans `result` dit mieux que « success » ce qui s'est passé
    const turnError =
      this.turnError ??
      (o.is_error === true && typeof o.result === 'string' && o.result.trim()
        ? o.result.trim()
        : undefined);
    this.turnError = undefined;
    this.emit({
      type: 'turn_end',
      ok,
      costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined,
      durationMs: typeof o.duration_ms === 'number' ? o.duration_ms : undefined,
      error: ok ? undefined : (turnError ?? String(o.subtype ?? 'erreur')),
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
    if (next.mode !== prev.mode)
      control({ subtype: 'set_permission_mode', mode: claudePermissionMode(next.mode) });
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
