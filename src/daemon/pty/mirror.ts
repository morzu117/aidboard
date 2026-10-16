import { createRequire } from 'node:module';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

// Ces paquets sont du CommonJS : sous Node, un import nommé échoue (Vitest, lui, le tolère).
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } =
  require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

// Copie de l'écran d'un agent côté daemon. Il ne répond jamais au programme : son onData n'est relié à rien.
export class TerminalMirror {
  private readonly term: HeadlessTerminal;
  private readonly serializer = new SerializeAddon();

  constructor(
    cols: number,
    rows: number,
    private readonly scrollback: number,
  ) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.term.loadAddon(this.serializer as never);
  }

  write(data: string): void {
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  // xterm.write est asynchrone : serialize() ne verrait que ce qui est déjà analysé. Le rappel de
  // write('') arrive après TOUT ce qui a été écrit avant lui, et avant tout ce qui sera écrit après.
  snapshotThen(cb: (snapshot: string) => void): void {
    this.term.write('', () => cb(this.serializer.serialize({ scrollback: this.scrollback })));
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** Lignes de l'écran actif (tests et diagnostic). */
  screen(): string[] {
    const buf = this.term.buffer.active;
    return Array.from(
      { length: this.term.rows },
      (_, i) => buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '',
    );
  }

  /** Toutes les lignes, historique compris. */
  allLines(): string[] {
    const buf = this.term.buffer.active;
    return Array.from(
      { length: buf.length },
      (_, i) => buf.getLine(i)?.translateToString(true) ?? '',
    );
  }

  get isAlternate(): boolean {
    return this.term.buffer.active.type === 'alternate';
  }

  dispose(): void {
    this.term.dispose();
  }

  static fromLog(bytes: string, cols: number, rows: number, scrollback: number): TerminalMirror {
    const m = new TerminalMirror(cols, rows, scrollback);
    m.write(bytes);
    return m;
  }
}
