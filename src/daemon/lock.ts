import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AidPaths } from './paths.js';

export class AidAlreadyRunning extends Error {
  constructor(readonly pid: number) {
    super(`A-I-D tourne déjà (pid ${pid})`);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(path: string): number {
  return Number.parseInt(readFileSync(path, 'utf8'), 10);
}

export function acquireLock(p: AidPaths): { release(): void } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(p.lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      return {
        release() {
          try {
            if (readPid(p.lock) === process.pid) unlinkSync(p.lock);
          } catch {
            // déjà retiré
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = readPid(p.lock);
      if (Number.isInteger(pid) && isAlive(pid)) throw new AidAlreadyRunning(pid);
      console.error(`verrou périmé repris (pid ${pid} absent)`);
      unlinkSync(p.lock);
    }
  }
  throw new AidAlreadyRunning(readPid(p.lock));
}
