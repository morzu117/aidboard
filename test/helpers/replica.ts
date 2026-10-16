import { Terminal } from '@xterm/headless';

export const COLS = 120;
export const ROWS = 32;

// Ce que voit un navigateur : un terminal qui ne reçoit que les octets envoyés par le daemon.
export class Replica {
  readonly term: Terminal;

  constructor(cols = COLS, rows = ROWS) {
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  }

  feed = (data: string | Uint8Array) => this.term.write(data);
  flush = () => new Promise<void>((r) => this.term.write('', r));

  lines(): string[] {
    const buf = this.term.buffer.active;
    return Array.from(
      { length: buf.length },
      (_, i) => buf.getLine(i)?.translateToString(true) ?? '',
    );
  }

  screen(): string[] {
    const buf = this.term.buffer.active;
    return Array.from(
      { length: this.term.rows },
      (_, i) => buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '',
    );
  }

  text(): string {
    return this.lines().join('\n');
  }
}
