import { execFile } from 'node:child_process';

export interface ExecResult {
  ok: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** présent seulement quand le binaire lui-même n'a pas pu être lancé (ex. ENOENT) */
  spawnErrorCode?: string;
}

// 4 Mo : borne la sortie d'un gros impact/callers — au-delà, l'appelant doit voir un échec
// plutôt qu'un JSON tronqué silencieusement.
const MAX_BUFFER = 4 * 1024 * 1024;

// Jamais de shell : execFile avec un tableau d'arguments, comme git/exec.ts. `input`, si donné,
// est écrit sur stdin puis le flux est fermé (seul `affected --stdin` en a besoin).
export function run(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; input?: string },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, killSignal: 'SIGTERM', maxBuffer: MAX_BUFFER },
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
        });
      },
    );
    child.stdin?.end(opts.input ?? '');
  });
}
