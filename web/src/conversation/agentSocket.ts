import type { AgentStreamItem } from '../../../src/shared/conversation.js';

export interface AgentHello {
  status: string;
  exited: boolean;
}

export interface AgentExit {
  exitCode: number | null;
  signal: string | null;
  reason: string;
}

export interface AgentSocketHandlers {
  onHello(h: AgentHello): void;
  onHistory(items: AgentStreamItem[], truncated: boolean): void;
  onEvent(item: AgentStreamItem): void;
  onExit(e: AgentExit): void;
  onLink?(connected: boolean): void;
}

export interface AgentSocketOptions {
  socketFactory?: (url: string) => WebSocket;
  origin?: { protocol: string; host: string };
  backoffMs?: number[];
  /** Chantier 17 (R.6) : `/ws/server-agent` pour un agent distant ; défaut `/ws/agent`. */
  path?: string;
}

// Canal lecture seule d'un agent conversationnel (D65) : historique puis direct, reconnexion par `after`.
export class AgentSocket {
  private socket: WebSocket | null = null;
  private closedByUs = false;
  private exited = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSeq = 0;

  constructor(
    private readonly agentId: string,
    private readonly h: AgentSocketHandlers,
    private readonly o: AgentSocketOptions = {},
  ) {
    this.connect();
  }

  private connect(): void {
    const origin = this.o.origin ?? window.location;
    const proto = origin.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${origin.host}${this.o.path ?? '/ws/agent'}/${encodeURIComponent(this.agentId)}?after=${this.lastSeq}`;
    const socket = this.o.socketFactory ? this.o.socketFactory(url) : new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.failures = 0;
      this.h.onLink?.(true);
    };
    socket.onmessage = (m) => this.onText(m.data as string);
    socket.onclose = (e) => {
      if (this.socket !== socket) return;
      this.h.onLink?.(false);
      if (this.closedByUs || this.exited) return;
      // 4001 : le daemon nous a coupés parce que nous lisions trop lentement ; rien à attendre pour revenir
      const delays = this.o.backoffMs ?? [500, 1000, 2000, 4000, 8000];
      const delay =
        e.code === 4001 ? 0 : (delays[Math.min(this.failures, delays.length - 1)] ?? 8000);
      this.failures += 1;
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  private onText(raw: string): void {
    let msg: { t?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'hello':
        this.h.onHello(msg as unknown as AgentHello);
        break;
      case 'history': {
        const items = msg.items as AgentStreamItem[];
        for (const item of items) this.lastSeq = Math.max(this.lastSeq, item.seq);
        this.h.onHistory(items, msg.truncated as boolean);
        break;
      }
      case 'event': {
        const item = msg as unknown as AgentStreamItem;
        this.lastSeq = Math.max(this.lastSeq, item.seq);
        this.h.onEvent(item);
        break;
      }
      case 'exit':
        this.exited = true;
        this.h.onExit(msg as unknown as AgentExit);
        break;
    }
  }

  close(): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }
}

const parChemin = new Map<string, typeof AgentSocket>();

/** Chantier 17 (R.6) : le même canal sur un autre chemin (`/ws/server-agent`), une classe par chemin. */
export function socketSur(path: string): typeof AgentSocket {
  let C = parChemin.get(path);
  if (!C) {
    C = class extends AgentSocket {
      constructor(agentId: string, h: AgentSocketHandlers, o: AgentSocketOptions = {}) {
        super(agentId, h, { ...o, path });
      }
    };
    parChemin.set(path, C);
  }
  return C;
}
