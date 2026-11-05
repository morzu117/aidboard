import { execFile } from 'node:child_process';

export interface MeshExecResult {
  ok: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** présent seulement quand le binaire lui-même n'a pas pu être lancé (ex. ENOENT) */
  spawnErrorCode?: string;
  /** code de sortie du processus quand il s'est terminé en erreur (2 : arguments refusés) */
  exitCode?: number;
}

export type MeshExec = (
  bin: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<MeshExecResult>;

const MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Patron de `structural/exec.ts` : jamais de shell, un tableau d'arguments, un délai. L'environnement
 * est celui du daemon plus ce que swarph attend (`MESH_GATEWAY_URL`, `SWARPH_STATE`) — jamais un token :
 * swarph lit le sien dans `~/.config/swarph/` (D35).
 */
export const meshExec: MeshExec = (bin, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { env: opts.env, timeout: opts.timeoutMs, killSignal: 'SIGTERM', maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, timedOut: false, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        resolve({
          ok: false,
          timedOut: Boolean(e.killed && e.signal === 'SIGTERM'),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? e.message),
          spawnErrorCode: typeof e.code === 'string' ? e.code : undefined,
          exitCode: typeof e.code === 'number' ? e.code : undefined,
        });
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end();
  });
