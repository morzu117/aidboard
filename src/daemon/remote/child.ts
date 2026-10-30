import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnChild } from '../conversation/driver.js';
import type { ConversationEvent } from '../../shared/conversation.js';
import {
  ensureRelay,
  parseAlive,
  parseFini,
  relayAlive,
  relayAttach,
  relayErr,
  relayStart,
  relayStop,
} from './relay.js';
import { killGroup, remoteExec, remoteSpawn, type TransportOptions } from './transport.js';

/** Attente entre deux tentatives de reconnexion (§11.3) ; la dernière se répète tant que l'agent n'est pas arrêté. */
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
export const LOST_MESSAGE = 'session introuvable sur le serveur';
const ATTACHED_MARK = 'aid-relay: attaché';
/** Un lien tenu ce temps-là remet l'attente au début : un lien qui tombe aussitôt rattaché ne repart pas à 1 s. */
const STABLE_MS = 10_000;

type RelayServer = Parameters<typeof remoteSpawn>[0];
export type ConnectionEvent = Extract<
  ConversationEvent,
  { type: 'connection_lost' } | { type: 'connection_resumed' }
>;

export interface RemoteChildOptions {
  server: RelayServer;
  transport?: TransportOptions;
  /** Identifiant du relais sur le serveur (dossier et session tmux de l'agent). */
  relayId: string;
  /** Agent déjà lancé (daemon redémarré, R.4) : reprise de la sortie à cet octet, jamais de nouveau `start`. */
  offset?: number;
  /** Session disparue : relancer l'agent sous le même identifiant (reprise de session) plutôt que finir. */
  replaceLost?: boolean;
  /** Instant de la perte qui a motivé cette relance : la première connexion rend `connection_resumed`. */
  lostAt?: number;
  /** Événements du lien (D75), à côté du flux de l'agent. */
  onConnection?: (ev: ConnectionEvent) => void;
  delaysMs?: readonly number[];
}

/**
 * Chantier 17 (R.3, D75) : un agent qui tourne sur le serveur sous `aid-relay`, vu par un pilote comme un
 * process local. Mêmes flux et mêmes événements (`exit`, `error`) que ce que `ClaudeDriver` et `CodexDriver`
 * lisent d'un `ChildProcess` ; `cwd` est celui du serveur, l'environnement local n'y part pas (D76).
 * Une coupure ne se voit pas du pilote : l'entrée attend, la sortie reprend à l'octet où elle s'était arrêtée.
 */
export class RemoteChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** Fini parce que la session tmux a disparu : le pilote distant relance par reprise de session. */
  lost = false;

  /** Octets de sortie reçus, et jusqu'à la dernière fin de ligne : l'offset sûr à garder pour un rattachement. */
  private received: number;
  private lineEnd: number;
  private attach: ChildProcessWithoutNullStreams | null = null;
  private connected = false;
  private started: boolean;
  private lostAt: number | null;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  /** Un `start` a été envoyé : en cas d'échec, l'agent est arrêté au mieux plutôt que laissé sans lien. */
  private launched = false;
  private pending: Buffer[] = [];
  private ending = false;
  private finished = false;
  private readonly abort = new AbortController();

  constructor(
    private readonly opts: RemoteChildOptions,
    private readonly argv: string[],
    private readonly cwd: string,
  ) {
    super();
    this.received = opts.offset ?? 0;
    this.lineEnd = this.received;
    this.started = opts.offset !== undefined;
    this.lostAt = opts.lostAt ?? null;
    this.stdin.on('data', (chunk: Buffer) => this.forward(chunk));
    // le pilote ferme l'entrée pour arrêter l'agent (stop) : ici, c'est l'arrêt sur le serveur
    this.stdin.on('finish', () => void this.terminate('SIGTERM'));
    setImmediate(() => void this.connect());
  }

  /** Offset sûr (fin de ligne) à conserver : un rattachement à partir de lui ne coupe aucun message. */
  get committedOffset(): number {
    return this.lineEnd;
  }

  /** pid local du `ssh` de rattachement en cours (diagnostic, tests de coupure). */
  get attachPid(): number | undefined {
    return this.attach?.pid;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    void this.terminate(signal);
    return true;
  }

  /** Arrêt du daemon (R.4) : le lien se ferme, l'agent continue sur le serveur ; aucun `exit`. */
  detach(): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
  }

  private exec(cmd: string) {
    return remoteExec(this.opts.server, cmd, {
      ...this.opts.transport,
      timeoutMs: 15_000,
      signal: this.abort.signal,
    });
  }

  /** Fini, ou arrêt en cours : plus rien ne doit (re)lancer ni rattacher. */
  private get done(): boolean {
    return this.finished || this.ending;
  }

  /** Dépôt du relais, état de l'agent, lancement s'il le faut, puis rattachement. */
  private async connect(): Promise<void> {
    if (this.done) return;
    try {
      await ensureRelay(this.opts.server, { ...this.opts.transport, signal: this.abort.signal });
      if (this.done) return;
      const alive = await this.exec(relayAlive(this.opts.relayId));
      if (this.done) return;
      if (alive.code !== 0) throw new Error(lastLine(alive.stderr) || `code ${alive.code}`);
      const state = parseAlive(alive.stdout).state;
      if (state === 'inconnu') {
        // l'agent a disparu avec son dossier (arrêté par ailleurs) : rien à quoi se rattacher
        if (this.started) return this.fail('agent inconnu sur le serveur');
        await this.launch();
      } else if (state === 'perdu') {
        if (!this.opts.replaceLost || this.started) return this.loseSession();
        await this.exec(relayStop(this.opts.relayId));
        await this.launch();
      }
      if (this.done) return;
      this.started = true;
      this.attachAt(this.received);
    } catch (err) {
      if (this.done) return;
      // jamais connecté à un agent existant : c'est un échec de lancement, pas une coupure
      if (!this.started) return void this.abandon((err as Error).message);
      this.disconnected();
    }
  }

  private async abandon(message: string): Promise<void> {
    // un `start` coupé en vol (délai, coupure) a pu aboutir : pas d'agent laissé sans lien sur le serveur
    if (this.launched) await this.stopRemote().catch(() => null);
    this.fail(message);
  }

  private stopRemote() {
    return remoteExec(this.opts.server, relayStop(this.opts.relayId), {
      ...this.opts.transport,
      timeoutMs: 10_000,
    });
  }

  private async launch(): Promise<void> {
    this.launched = true;
    const r = await this.exec(relayStart(this.opts.relayId, this.cwd, this.argv));
    if (r.code !== 0) throw new Error(lastLine(r.stderr) || `code ${r.code}`);
    this.received = 0;
    this.lineEnd = 0;
  }

  private attachAt(offset: number): void {
    const child = remoteSpawn(
      this.opts.server,
      relayAttach(this.opts.relayId, offset),
      this.opts.transport,
    );
    this.attach = child;
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.attach !== child || this.done) return;
      this.onConnected();
      const nl = chunk.lastIndexOf(0x0a);
      if (nl >= 0) this.lineEnd = this.received + nl + 1;
      this.received += chunk.length;
      this.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
      if (this.attach === child && err.includes(ATTACHED_MARK)) this.onConnected();
    });
    child.on('close', (code) => {
      if (this.attach !== child) return;
      this.attach = null;
      if (!this.done) void this.onAttachClosed(code, err);
    });
  }

  private onConnected(): void {
    if (this.connected) return;
    this.connected = true;
    this.stableTimer = setTimeout(() => (this.attempt = 0), STABLE_MS);
    if (this.lostAt !== null) {
      this.opts.onConnection?.({
        type: 'connection_resumed',
        at: new Date().toISOString(),
        afterMs: Date.now() - this.lostAt,
        sessionFound: !this.opts.replaceLost,
      });
      this.lostAt = null;
    }
    const pending = this.pending;
    this.pending = [];
    for (const chunk of pending) this.forward(chunk);
  }

  /** L'entrée du pilote : vers le rattachement en place, ou en attente jusqu'au prochain. */
  private forward(chunk: Buffer): void {
    if (this.finished) return;
    if (this.attach && this.connected && this.attach.stdin.writable) this.attach.stdin.write(chunk);
    else this.pending.push(chunk);
  }

  private async onAttachClosed(code: number | null, err: string): Promise<void> {
    if (code === 0) {
      const exit = parseFini(err);
      // l'erreur de l'agent (authentification, binaire absent) : le pilote la rend dans son `exit`
      if (exit !== 0) {
        const tail = await this.exec(relayErr(this.opts.relayId)).catch(() => null);
        if (tail?.stdout) this.stderr.write(tail.stdout);
      }
      return this.finish(exit, null);
    }
    if (code === 4) return this.loseSession();
    if (code === 3 || code === 8)
      return this.fail(lastLine(err) || `rattachement en échec (${code})`);
    this.disconnected();
  }

  private disconnected(): void {
    this.connected = false;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.lostAt === null) {
      this.lostAt = Date.now();
      this.opts.onConnection?.({ type: 'connection_lost', at: new Date().toISOString() });
    }
    const delays = this.opts.delaysMs ?? RECONNECT_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)] ?? 0;
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  /** Session tmux disparue (redémarrage du serveur) : fin marquée `lost`, la relance revient au pilote distant. */
  private loseSession(): void {
    if (this.lostAt === null) {
      this.lostAt = Date.now();
      this.opts.onConnection?.({ type: 'connection_lost', at: new Date().toISOString() });
    }
    this.lost = true;
    this.fail(LOST_MESSAGE);
  }

  /** Perte constatée à cet instant, transmise à la relance pour son `connection_resumed`. */
  get lostSince(): number | null {
    return this.lostAt;
  }

  private fail(message: string): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    // le pilote écoute `error` ; sans écouteur, EventEmitter lèverait : le message passe alors par stderr
    if (this.listenerCount('error') > 0) this.emit('error', new Error(message));
    else this.stderr.write(`${message}\n`);
    this.emitExit(null, null);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    // l'erreur écrite juste avant doit être lue par le pilote avant la fin
    setImmediate(() => this.emitExit(code, signal));
  }

  /** Arrêt demandé par le pilote : l'agent est arrêté sur le serveur, au mieux s'il est injoignable. */
  private async terminate(signal: NodeJS.Signals): Promise<void> {
    if (this.finished || this.ending) return;
    this.ending = true;
    this.cleanup();
    // même sans lancement constaté : un `start` interrompu en vol a pu aboutir sur le serveur
    const r = await this.stopRemote().catch(() => null);
    // injoignable : l'arrêt est rendu au pilote, mais l'agent peut tourner encore — le message le dit
    if (r?.code !== 0)
      this.stderr.write(
        `arrêt sur le serveur impossible (${lastLine(r?.stderr ?? '') || 'injoignable'}) : l'agent y tourne peut-être encore\n`,
      );
    this.finish(null, signal);
  }

  private cleanup(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.retryTimer = null;
    this.abort.abort();
    if (this.attach) killGroup(this.attach, 'SIGKILL');
    this.attach = null;
    this.pending = [];
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

const lastLine = (s: string) => s.trim().split('\n').at(-1)?.trim() ?? '';

/**
 * Lanceur D75 pour `ConversationDriverOptions.spawnChild`. Le `RemoteChild` n'a de `ChildProcess` que la surface
 * que les pilotes lisent (flux, `exit`, `error`, `kill`, `exitCode`, `signalCode`) : d'où la conversion.
 */
export function remoteSpawnChild(
  opts: RemoteChildOptions,
  onCreate?: (child: RemoteChild) => void,
): SpawnChild {
  return (bin, args, spawnOpts) => {
    const child = new RemoteChild(opts, [bin, ...args], spawnOpts.cwd);
    onCreate?.(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}
