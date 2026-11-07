import type { StoredEvent } from '../../../src/shared/events.js';
import type { EtatPourAppareil } from '../../../src/shared/host.js';
import type { ServerStatus, ServerTest } from '../../../src/shared/model.js';
import type { StateSnapshot } from '../../../src/shared/state.js';
import { api, SessionExpired } from './api.js';
import type { DaemonLink } from './types.js';

export interface OutputLine {
  stream: string;
  line: string;
}

export interface ClientSnapshot {
  state: StateSnapshot | null;
  daemon: DaemonLink;
  outputs: Readonly<Record<string, readonly OutputLine[]>>;
  /** Chantier 17 (S.4) : derniers `server.status` / `server.test` éphémères reçus, par serveur. */
  serverStatuses?: Readonly<Record<string, ServerStatus>>;
  serverTests?: Readonly<Record<string, ServerTest>>;
  /** Chantier 25 (D99 bis) : dernier `mesh.checked` éphémère reçu */
  meshCheckedAt?: string;
  /** Chantier 31 (D175, D180) : en mode appareil, l'état masqué, à la place de `state` */
  appareil?: EtatPourAppareil;
  /** Chantier 31 (D177) : en mode appareil, pourquoi l'accès est fini */
  acces?: AccesFini;
}

export type AccesFini = 'inconnu' | 'expire' | 'revoque';
const ACCES_FINIS: readonly string[] = ['inconnu', 'expire', 'revoque'];
const accesFini = (r: string | null | undefined): AccesFini =>
  ACCES_FINIS.includes(r ?? '') ? (r as AccesFini) : 'inconnu';

export interface ClientOptions {
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => WebSocket;
  origin?: { protocol: string; host: string };
  debounceMs?: number;
  backoffMs?: number[];
  maxOutputLines?: number;
  /**
   * Chantier 31 (D180) : `signal` sur le port des appareils. L'état masqué est relu à chaque
   * `{ kind: 'changed' }` de `/ws/signal`, qui ne porte rien d'autre.
   */
  flux?: 'events' | 'signal';
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 4000, 8000];

// L'interface ne calcule aucun état métier : à chaque événement, elle relit l'instantané du daemon.
export class AidClient {
  private snap: ClientSnapshot = { state: null, daemon: 'reconnexion', outputs: {} };
  private listeners = new Set<() => void>();
  private lastEventId: string | null = null;
  private socket: WebSocket | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private stopped = true;
  private readonly o: Required<Omit<ClientOptions, 'fetchImpl' | 'socketFactory' | 'origin'>> &
    Pick<ClientOptions, 'fetchImpl' | 'socketFactory' | 'origin'>;

  constructor(options: ClientOptions = {}) {
    this.o = {
      debounceMs: 100,
      backoffMs: DEFAULT_BACKOFF,
      maxOutputLines: 500,
      flux: 'events',
      ...options,
    };
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): ClientSnapshot => this.snap;

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
    for (const t of [this.refreshTimer, this.retryTimer]) if (t) clearTimeout(t);
    this.refreshTimer = this.retryTimer = null;
  }

  /** « Réessayer » : repart de zéro sans attendre le prochain palier. */
  retry(): void {
    this.failures = 0;
    this.socket?.close();
    this.socket = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopped = false;
    this.set({ daemon: 'reconnexion' });
    void this.connect();
  }

  request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    return api<T>(method, path, body, this.o.fetchImpl);
  }

  async refresh(): Promise<void> {
    if (this.o.flux === 'signal') {
      const appareil = await api<EtatPourAppareil>(
        'GET',
        '/api/state',
        undefined,
        this.o.fetchImpl,
      );
      this.set({ appareil });
      return;
    }
    const state = await api<StateSnapshot>('GET', '/api/state', undefined, this.o.fetchImpl);
    this.lastEventId = state.lastEventId ?? this.lastEventId;
    this.set({ state });
  }

  private set(patch: Partial<ClientSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const cb of this.listeners) cb();
  }

  private async connect(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      return this.failed(err);
    }
    if (this.stopped) return;
    const origin = this.o.origin ?? window.location;
    const ws = origin.protocol === 'https:' ? 'wss:' : 'ws:';
    const since = this.lastEventId ? `?since=${encodeURIComponent(this.lastEventId)}` : '';
    const url =
      this.o.flux === 'signal'
        ? `${ws}//${origin.host}/ws/signal`
        : `${ws}//${origin.host}/ws/events${since}`;
    const socket = this.o.socketFactory ? this.o.socketFactory(url) : new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.failures = 0;
      this.set({ daemon: 'connecte' });
    };
    // une socket remplacée ou fermée par stop() ne relit plus rien
    socket.onmessage = (m) => {
      if (this.socket === socket) this.onMessage(String(m.data));
    };
    socket.onclose = (e?: { code?: number; reason?: string }) => {
      if (this.socket !== socket) return;
      // D177 : le port des appareils ferme en 4401 un appareil révoqué ou expiré
      if (this.o.flux === 'signal' && e?.code === 4401)
        return this.failed(new SessionExpired(e.reason ?? null));
      this.failed();
    };
  }

  private onMessage(raw: string): void {
    let msg: {
      kind?: string;
      event?: StoredEvent;
      type?: string;
      actionId?: string;
      stream?: string;
      line?: string;
      status?: ServerStatus;
      test?: ServerTest;
      checkedAt?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // D175 : le flux d'un appareil ne porte que `changed` ; tout autre message est ignoré
    if (this.o.flux === 'signal') {
      if (msg.kind === 'changed') this.relireBientot();
      return;
    }
    if (msg.kind === 'event' && msg.event) {
      this.lastEventId = msg.event.id;
      this.relireBientot();
    } else if (msg.kind === 'ephemeral' && msg.type === 'action.output' && msg.actionId) {
      const prev = this.snap.outputs[msg.actionId] ?? [];
      const next = [...prev, { stream: msg.stream ?? 'stdout', line: msg.line ?? '' }].slice(
        -this.o.maxOutputLines,
      );
      this.set({ outputs: { ...this.snap.outputs, [msg.actionId]: next } });
    } else if (msg.kind === 'ephemeral' && msg.type === 'server.status' && msg.status) {
      const id = msg.status.serverId;
      this.set({ serverStatuses: { ...this.snap.serverStatuses, [id]: msg.status } });
    } else if (msg.kind === 'ephemeral' && msg.type === 'server.test' && msg.test) {
      const id = msg.test.serverId;
      this.set({ serverTests: { ...this.snap.serverTests, [id]: msg.test } });
    } else if (msg.kind === 'ephemeral' && msg.type === 'mesh.checked' && msg.checkedAt) {
      this.set({ meshCheckedAt: msg.checkedAt });
    }
  }

  private relireBientot(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh().catch((err) => this.failed(err));
    }, this.o.debounceMs);
  }

  private failed(err?: unknown): void {
    if (err instanceof SessionExpired) {
      this.stop();
      this.set(
        this.o.flux === 'signal'
          ? { daemon: 'session-expiree', acces: accesFini(err.raison) }
          : { daemon: 'session-expiree' },
      );
      return;
    }
    if (this.stopped) return;
    this.socket = null;
    this.failures += 1;
    this.set({ daemon: this.failures >= 3 ? 'injoignable' : 'reconnexion' });
    const delays = this.o.backoffMs;
    const delay = delays[Math.min(this.failures - 1, delays.length - 1)] ?? 8000;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}
