import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AidPaths } from '../paths.js';

// Les journaux PTY peuvent contenir des secrets : au-delà de la rétention, on les supprime.
export function purgeOldLogs(paths: AidPaths, days: number, now = Date.now()): number {
  const limit = now - days * 86_400_000;
  let removed = 0;
  for (const dir of [paths.logs, paths.actionLogs]) {
    for (const name of readdirSync(dir)) {
      if (!/\.log(\.1)?$/.test(name)) continue;
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs < limit) {
          rmSync(file);
          removed++;
        }
      } catch {
        // retiré entre-temps
      }
    }
  }
  return removed;
}
