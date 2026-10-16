import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Le bundle place ses chunks à des profondeurs variables : on remonte jusqu'à la racine du dépôt (son .git).
export function repoRootFrom(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export interface UpdateStatus {
  available: boolean;
  localSha: string;
  remoteSha: string;
}

/** Compare HEAD à origin/<branche> : jamais d'exception, `null` si on ne peut pas savoir (pas un dépôt, pas d'origin, hors ligne). */
export async function checkForUpdate(dir: string, branch = 'main'): Promise<UpdateStatus | null> {
  try {
    const [local, remote] = await Promise.all([
      run('git', ['rev-parse', 'HEAD'], { cwd: dir, timeout: 5000 }),
      run('git', ['ls-remote', 'origin', branch], { cwd: dir, timeout: 5000 }),
    ]);
    const localSha = local.stdout.trim();
    const remoteSha = remote.stdout.split('\t')[0]?.trim() ?? '';
    if (!remoteSha) return null;
    return { available: remoteSha !== localSha, localSha, remoteSha };
  } catch {
    return null;
  }
}
