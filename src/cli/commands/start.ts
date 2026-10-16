import { type SpawnOptions, spawn } from 'node:child_process';
import { closeSync, openSync, realpathSync } from 'node:fs';
import { ensureHome, type AidPaths } from '../../daemon/paths.js';
import { runningDaemon, type DaemonInfo } from '../daemonInfo.js';

export class StartFailed extends Error {}

export type SpawnDaemon = (paths: AidPaths) => void;

// Le CLI relance son propre script (le bundle place ses chunks à des profondeurs variables, pas de chemin relatif).
// Le daemon se lance détaché : ses agents doivent survivre au terminal qui l'a démarré.
export const spawnDetachedDaemon: SpawnDaemon = (paths) => {
  ensureHome(paths);
  const log = openSync(`${paths.home}/daemon.log`, 'a', 0o600);
  const opts: SpawnOptions = {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, AID_HOME: paths.home },
  };
  const child = spawn(process.execPath, [realpathSync(process.argv[1] ?? ''), 'daemon'], opts);
  child.unref();
  closeSync(log);
};

export async function ensureRunning(
  paths: AidPaths,
  spawnDaemon: SpawnDaemon = spawnDetachedDaemon,
  timeoutMs = 10_000,
): Promise<DaemonInfo> {
  const existing = await runningDaemon(paths);
  if (existing) return existing;
  spawnDaemon(paths);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const info = await runningDaemon(paths);
    if (info) return info;
  }
  throw new StartFailed(
    `le daemon ne répond pas après ${timeoutMs / 1000} s : voir ${paths.home}/daemon.log`,
  );
}
