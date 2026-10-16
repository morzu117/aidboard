import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface PullAndBuildResult {
  ok: boolean;
  step?: 'pull' | 'build';
  error?: string;
}

export type BuildFn = (repoDir: string) => Promise<void>;

export const npmRunBuild: BuildFn = async (repoDir) => {
  await run('npm', ['run', 'build'], {
    cwd: repoDir,
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
};

/**
 * `git pull --ff-only` puis build. Fast-forward only : un pull qui écraserait du travail local non
 * commité ou divergent est refusé par git lui-même, jamais contourné ici.
 */
export async function pullAndBuild(
  repoDir: string,
  branch = 'main',
  build: BuildFn = npmRunBuild,
): Promise<PullAndBuildResult> {
  try {
    await run('git', ['pull', '--ff-only', 'origin', branch], { cwd: repoDir, timeout: 60_000 });
  } catch (err) {
    return { ok: false, step: 'pull', error: (err as Error).message };
  }
  try {
    await build(repoDir);
  } catch (err) {
    return { ok: false, step: 'build', error: (err as Error).message };
  }
  return { ok: true };
}

/**
 * Processus détaché, indépendant du daemon courant : attend que `pid` meure puis relance
 * `entry daemon`. Doit survivre à l'exit du process qui l'a lancé — c'est ce qui permet au
 * daemon de repartir tout seul après s'être arrêté pour charger le nouveau build.
 */
export function spawnRespawnWatcher(pid: number, entry: string, home: string): void {
  const code = `
    const pid = ${pid};
    const sab = new SharedArrayBuffer(4);
    const ia = new Int32Array(sab);
    while (true) {
      try { process.kill(pid, 0); } catch { break; }
      Atomics.wait(ia, 0, 0, 150);
    }
    const { spawn } = require('node:child_process');
    const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(entry)}, 'daemon'], {
      detached: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env, { AID_HOME: ${JSON.stringify(home)} }),
    });
    child.unref();
  `;
  const watcher = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  watcher.unref();
}
