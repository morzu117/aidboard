import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export interface ScriptOutcome {
  exitCode: number | null;
  outcome: 'succeeded' | 'needs_human' | 'failed';
  result: Record<string, unknown>;
  tail: string[];
  reason?: 'timeout' | 'spawn';
}

export interface RunScriptOptions {
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  logPath: string;
  onLine?: (l: { stream: 'stdout' | 'stderr'; line: string }) => void;
  killGraceMs?: number;
}

const MARKER = '::aid:: ';
const TAIL = 50;

export function runScript(o: RunScriptOptions): Promise<ScriptOutcome> {
  return new Promise((resolve) => {
    const log = createWriteStream(o.logPath, { flags: 'a', mode: 0o600 });
    const result: Record<string, unknown> = {};
    const tail: string[] = [];
    let reason: ScriptOutcome['reason'];
    let settled = false;

    const finish = (exitCode: number | null, signaled: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const outcome =
        !signaled && exitCode === 0
          ? 'succeeded'
          : !signaled && exitCode === 2
            ? 'needs_human'
            : 'failed';
      // l'action n'est terminée qu'une fois son journal écrit
      log.end(() => resolve({ exitCode, outcome, result, tail, ...(reason && { reason }) }));
    };

    const child = spawn('bash', [o.script], {
      cwd: o.cwd,
      env: o.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const handleLine = (stream: 'stdout' | 'stderr', line: string) => {
      if (line.startsWith(MARKER)) {
        try {
          const parsed: unknown = JSON.parse(line.slice(MARKER.length));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.assign(result, parsed);
            return;
          }
        } catch {
          // JSON invalide : c'est une ligne comme une autre
        }
      }
      tail.push(line);
      if (tail.length > TAIL) tail.shift();
      o.onLine?.({ stream, line });
    };

    for (const stream of ['stdout', 'stderr'] as const) {
      let pending = '';
      child[stream].setEncoding('utf8');
      child[stream].on('data', (chunk: string) => {
        log.write(chunk);
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const l of lines) handleLine(stream, l);
      });
      child[stream].on('end', () => {
        if (pending) handleLine(stream, pending);
      });
    }

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // groupe déjà terminé
      }
    };
    const timer = setTimeout(() => {
      reason = 'timeout';
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), o.killGraceMs ?? 5000).unref();
    }, o.timeoutMs);

    child.on('error', () => {
      reason = 'spawn';
      finish(null, true);
    });
    // `close` : les flux sont vidés, donc toutes les lignes ont été lues
    child.on('close', (code, signal) => finish(code, signal !== null));
  });
}
