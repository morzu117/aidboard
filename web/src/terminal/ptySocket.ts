export interface PtyHello {
  cols: number;
  rows: number;
  owner: boolean;
  status: string;
  replay: 'live' | 'log';
}

export interface PtyExit {
  exitCode: number | null;
  signal: number | null;
  reason: string;
}

export interface PtyHandlers {
  onHello(h: PtyHello): void;
  onOutput(bytes: Uint8Array): void;
  onSize(cols: number, rows: number): void;
  onOwner(owner: boolean): void;
  onExit(e: PtyExit): void;
  onLink?(connected: boolean): void;
}

export interface PtySocketOptions {
  socketFactory?: (url: string) => WebSocket;
  origin?: { protocol: string; host: string };
  backoffMs?: number[];
}

// Un client du terminal d'un agent : l'instantané puis le direct, reconnexion automatique.
export class PtySocket {
  private socket: WebSocket | null = null;
  private closedByUs = false;
  private exited = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly agentId: string,
    private readonly h: PtyHandlers,
    private readonly o: PtySocketOptions = {},
  ) {
    this.connect();
  }

  private connect(): void {
    const origin = this.o.origin ?? window.location;
    const proto = origin.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${origin.host}/ws/pty/${encodeURIComponent(this.agentId)}`;
    const socket = this.o.socketFactory ? this.o.socketFactory(url) : new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      this.failures = 0;
      this.h.onLink?.(true);
    };
    socket.onmessage = (m) => {
      if (typeof m.data === 'string') return this.onText(m.data);
      this.h.onOutput(new Uint8Array(m.data as ArrayBuffer));
    };
    socket.onclose = (e) => {
      if (this.socket !== socket) return;
      this.h.onLink?.(false);
      if (this.closedByUs || this.exited) return;
      // 4001 : le daemon nous a coupés parce que nous lisions trop lentement ; il renvoie un instantané
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
        this.h.onHello(msg as unknown as PtyHello);
        break;
      case 'size':
        this.h.onSize(msg.cols as number, msg.rows as number);
        break;
      case 'owner':
        this.h.onOwner(msg.owner as boolean);
        break;
      case 'exit':
        this.exited = true;
        this.h.onExit(msg as unknown as PtyExit);
        break;
    }
  }

  private send(msg: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  input(d: string): void {
    this.send({ t: 'in', d });
  }

  resize(cols: number, rows: number): void {
    this.send({ t: 'resize', cols, rows });
  }

  claim(): void {
    this.send({ t: 'claim' });
  }

  close(): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }
}
