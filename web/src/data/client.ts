import type { StoredEvent } from '../../../src/shared/events.js';
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
}

export interface ClientOptions {
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => WebSocket;
  origin?: { protocol: string; host: string };
  debounceMs?: number;
  backoffMs?: number[];
  maxOutputLines?: number;
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
    this.o = { debounceMs: 100, backoffMs: DEFAULT_BACKOFF, maxOutputLines: 500, ...options };
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

  request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return api<T>(method, path, body, this.o.fetchImpl);
  }

  async refresh(): Promise<void> {
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
    const url = `${ws}//${origin.host}/ws/events${since}`;
    const socket = this.o.socketFactory ? this.o.socketFactory(url) : new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.failures = 0;
      this.set({ daemon: 'connecte' });
    };
    socket.onmessage = (m) => this.onMessage(String(m.data));
    socket.onclose = () => {
      if (this.socket === socket) this.failed();
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
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.kind === 'event' && msg.event) {
      this.lastEventId = msg.event.id;
      if (this.refreshTimer) return;
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        this.refresh().catch((err) => this.failed(err));
      }, this.o.debounceMs);
    } else if (msg.kind === 'ephemeral' && msg.type === 'action.output' && msg.actionId) {
      const prev = this.snap.outputs[msg.actionId] ?? [];
      const next = [...prev, { stream: msg.stream ?? 'stdout', line: msg.line ?? '' }].slice(
        -this.o.maxOutputLines,
      );
      this.set({ outputs: { ...this.snap.outputs, [msg.actionId]: next } });
    }
  }

  private failed(err?: unknown): void {
    if (err instanceof SessionExpired) {
      this.stop();
      this.set({ daemon: 'session-expiree' });
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
