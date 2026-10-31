import type { AgentSettings, ModelOption } from '../../shared/agentSettings.js';
import type { PendingOption } from '../../shared/model.js';
import type {
  AttachedFile,
  ConversationDriver,
  ConversationEvent,
  SpawnChild,
} from '../conversation/driver.js';
import { LOST_MESSAGE, RemoteChild, type RemoteChildOptions, remoteSpawnChild } from './child.js';

export interface RemoteDriverOptions extends Omit<
  RemoteChildOptions,
  'replaceLost' | 'lostAt' | 'onConnection'
> {
  sessionId: string;
  resume: boolean;
  settings?: AgentSettings;
  /** Le pilote local (`ClaudeDriver`, `CodexDriver`) monté sur le lanceur distant ; appelé à nouveau pour une reprise. */
  create(o: {
    sessionId: string;
    resume: boolean;
    settings?: AgentSettings;
    spawnChild: SpawnChild;
  }): ConversationDriver;
}

/**
 * Chantier 17 (R.3, D73, D75) : pilote d'un agent distant. Le pilote local tourne inchangé sur un `RemoteChild` ;
 * celui-ci absorbe les coupures. Quand la session tmux a disparu (redémarrage du serveur), le pilote est remonté
 * par reprise de session (`--resume`, `thread/resume`, comme D51) sous le même relais : le fil continue, une ligne
 * de reprise le dit (`connection_resumed`, `sessionFound` faux) ou l'échec le dit (`resume_failed`).
 */
/** Reprises d'affilée sans un tour réussi entre elles : au-delà, la session est tenue pour irrécupérable. */
export const MAX_RESUMES = 3;

export class RemoteDriver implements ConversationDriver {
  private inner: ConversationDriver | null = null;
  private child: RemoteChild | null = null;
  private listeners = new Set<(event: ConversationEvent) => void>();
  private settings: AgentSettings | undefined;
  private busy = false;
  /**
   * Reprise en cours, jusqu'au premier événement du pilote remonté : un `--resume` refusé par l'agent (session
   * inconnue de la CLI) finit après la connexion, et c'est encore un échec de reprise.
   */
  private resuming = false;
  private resumes = 0;
  private detached = false;

  constructor(private readonly opts: RemoteDriverOptions) {
    this.settings = opts.settings;
  }

  get sessionId(): string {
    return this.inner?.sessionId ?? this.opts.sessionId;
  }

  /** Le process distant courant (diagnostic, tests de coupure). */
  get remoteChild(): RemoteChild | null {
    return this.child;
  }

  /** Offset de sortie à conserver (fin de ligne) ; repart de 0 après une relance. */
  get committedOffset(): number {
    return this.child?.committedOffset ?? this.opts.offset ?? 0;
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
        // un listener qui lève ne doit pas interrompre le flux de l'agent.
      }
    }
  }

  start(): void {
    if (this.inner) throw new Error('driver déjà démarré');
    this.mount(this.opts.sessionId, this.opts.resume, false, undefined);
  }

  private mount(
    sessionId: string,
    resume: boolean,
    replaceLost: boolean,
    lostAt: number | undefined,
  ): void {
    const spawnChild = remoteSpawnChild(
      {
        ...this.opts,
        // la sortie d'un agent relancé repart de zéro : l'ancien offset ne vaut plus
        offset: replaceLost ? undefined : this.opts.offset,
        replaceLost,
        lostAt,
        onConnection: (ev) => this.emit(ev),
      },
      (child) => (this.child = child),
    );
    const inner = this.opts.create({ sessionId, resume, settings: this.settings, spawnChild });
    this.inner = inner;
    inner.onEvent((ev) => this.fromInner(inner, ev));
    inner.start();
  }

  private fromInner(inner: ConversationDriver, ev: ConversationEvent): void {
    // pilote remplacé par une reprise : l'ancien ne parle plus
    if (inner !== this.inner) return;
    if (ev.type === 'turn_end') {
      this.busy = false;
      if (ev.ok) this.resumes = 0;
    }
    if (ev.type !== 'exit') this.resuming = false;
    if (ev.type === 'exit') {
      const child = this.child;
      if (child?.lost) return this.resume(inner, child);
      if (this.resuming) {
        this.resuming = false;
        this.emit({ type: 'resume_failed', reason: ev.message ?? 'relance impossible' });
      }
    }
    this.emit(ev);
  }

  private resume(inner: ConversationDriver, child: RemoteChild): void {
    // le tour en cours est perdu avec la session : il se ferme, le suivant partira sur la session reprise
    if (this.busy) {
      this.busy = false;
      this.emit({ type: 'turn_end', ok: false, error: LOST_MESSAGE });
    }
    const sessionId = inner.sessionId;
    const refus = !sessionId
      ? 'aucune session à reprendre'
      : this.resumes >= MAX_RESUMES
        ? `session perdue ${this.resumes + 1} fois de suite sans un tour réussi`
        : null;
    if (refus) {
      this.emit({ type: 'resume_failed', reason: refus });
      this.emit({ type: 'exit', code: null, signal: null, message: LOST_MESSAGE });
      return;
    }
    this.resumes++;
    this.resuming = true;
    this.mount(sessionId, true, true, child.lostSince ?? Date.now());
  }

  send(text: string, files?: AttachedFile[]): void {
    this.busy = true;
    this.inner?.send(text, files);
  }

  interrupt(): void {
    this.inner?.interrupt();
  }

  answer(requestId: string, decision: PendingOption['answer']): void {
    this.inner?.answer(requestId, decision);
  }

  configure(settings: AgentSettings): void {
    this.settings = settings;
    this.inner?.configure(settings);
  }

  catalog(): ModelOption[] {
    return this.inner?.catalog?.() ?? [];
  }

  stop(): Promise<void> {
    // détaché : plus de lien, donc plus de `exit` à attendre ; l'agent reste au serveur (arrêt du daemon)
    if (this.detached) return Promise.resolve();
    return this.inner?.stop() ?? Promise.resolve();
  }

  /** Arrêt du daemon (R.4) : le lien se ferme, l'agent continue sur le serveur. */
  detach(): void {
    this.detached = true;
    this.child?.detach();
  }
}
