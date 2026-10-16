import { closeSync, openSync, renameSync, statSync, writeSync } from 'node:fs';

// Journal brut d'un terminal : écritures synchrones (ordre garanti), rotation en .1 au-delà de maxBytes.
export class LogWriter {
  private fd: number | null;
  private size: number;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
  ) {
    this.fd = openSync(path, 'a', 0o600);
    this.size = statSync(path).size;
  }

  write(chunk: string): void {
    if (this.fd === null) return;
    try {
      const buf = Buffer.from(chunk, 'utf8');
      if (this.size + buf.length > this.maxBytes && this.size > 0) this.rotate();
      writeSync(this.fd!, buf);
      this.size += buf.length;
    } catch {
      // disque plein ou fichier retiré : le terminal continue de vivre sans journal
    }
  }

  private rotate(): void {
    closeSync(this.fd!);
    renameSync(this.path, `${this.path}.1`);
    this.fd = openSync(this.path, 'a', 0o600);
    this.size = 0;
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}
