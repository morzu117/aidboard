import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { Server } from '../../shared/model.js';

/** Ce que le daemon injecte : le binaire `ssh` (un faux en test, D79) et l'environnement. */
export interface TransportOptions {
  ssh?: string;
  env?: NodeJS.ProcessEnv;
}

export interface Argv {
  file: string;
  args: string[];
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Sortie coupée à `maxBytes` : le reste a été jeté. */
  truncated: boolean;
}

const EXEC_TIMEOUT_MS = 15_000;
const EXEC_MAX_BYTES = 1024 * 1024;
const SIGKILL_DELAY_MS = 2_000;
/** Options communes (D72) : jamais de prompt de mot de passe, connexion bornée, pas de pseudo-terminal. */
const SSH_BASE = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T'];

/** Guillemets simples POSIX : seul `'` est à traiter, tout le reste est littéral. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * La commande telle que le serveur la reçoit : toujours dans le shell distant configuré, en shell de
 * connexion (`-l`) pour que le PATH du profil (`~/.local/bin`…) soit celui où `claude` est installé.
 */
export function remoteCommand(server: Pick<Server, 'shell'>, cmd: string): string {
  return `${server.shell} -lc ${shQuote(cmd)}`;
}

/** Argv local qui exécute `cmd` sur le serveur, par mode (D72). Jamais de concaténation ailleurs. */
export function remoteArgv(
  server: Pick<Server, 'mode' | 'target' | 'sshOptions' | 'loadProfile' | 'shell'>,
  cmd: string,
  opts: TransportOptions = {},
): Argv {
  const ssh = opts.ssh ?? 'ssh';
  const remote = remoteCommand(server, cmd);
  if (server.mode === 'ssh_alias') {
    return { file: ssh, args: [...SSH_BASE, '--', server.target, remote] };
  }
  if (server.mode === 'ssh_host') {
    const o = server.sshOptions;
    const extra: string[] = [];
    if (o?.port != null) extra.push('-p', String(o.port));
    if (o?.user != null) extra.push('-l', o.user);
    if (o?.identityFile != null) extra.push('-i', o.identityFile);
    if (o?.jump != null) extra.push('-J', o.jump);
    return { file: ssh, args: [...SSH_BASE, ...extra, '--', server.target, remote] };
  }
  // Commande locale : un préfixe qui accepte une commande distante en argument (ex. `ssh vps`). Une
  // fonction du profil n'existe que dans un shell qui le charge (§11.0) : d'où `-ic` si demandé.
  const line = `${server.target} ${shQuote(remote)}`;
  const env = opts.env ?? process.env;
  return server.loadProfile
    ? { file: env.SHELL || '/bin/sh', args: ['-ic', line] }
    : { file: '/bin/sh', args: ['-c', line] };
}

function killGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // groupe déjà vide
  }
}

/** Commande courte (test, liste, `git status`) : sortie bornée, délai borné, jamais d'entrée standard. */
export function remoteExec(
  server: Parameters<typeof remoteArgv>[0],
  cmd: string,
  opts: TransportOptions & { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ExecResult> {
  const { file, args } = remoteArgv(server, cmd, opts);
  const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? EXEC_MAX_BYTES;
  const started = Date.now();
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, extraErr?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + (extraErr ?? ''),
        durationMs: Date.now() - started,
        timedOut,
        truncated,
      });
    };
    const keep = (chunks: Buffer[], used: number, chunk: Buffer): number => {
      const room = maxBytes - used;
      if (room <= 0) {
        truncated = true;
        return used;
      }
      if (chunk.length > room) truncated = true;
      chunks.push(chunk.subarray(0, room));
      return used + Math.min(chunk.length, room);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Groupe de processus à part : au délai dépassé on tue le groupe, sinon un petit-enfant (le `ssh`
      // lancé par `sh -c` en mode commande locale) garderait les tuyaux ouverts et `close` n'arriverait pas.
      child = spawn(file, args, {
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      finish(null, (e as Error).message);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      setTimeout(() => {
        killGroup(child, 'SIGKILL');
        finish(null);
      }, SIGKILL_DELAY_MS).unref();
    }, timeoutMs);
    child.stdout!.on('data', (c: Buffer) => (outBytes = keep(out, outBytes, c)));
    child.stderr!.on('data', (c: Buffer) => (errBytes = keep(err, errBytes, c)));
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
  });
}

/** Flux long (relais d'un agent, R.2) : stdin, stdout et stderr ouverts, l'appelant gère la vie du process. */
export function remoteSpawn(
  server: Parameters<typeof remoteArgv>[0],
  cmd: string,
  opts: TransportOptions = {},
): ChildProcessWithoutNullStreams {
  const { file, args } = remoteArgv(server, cmd, opts);
  return spawn(file, args, { env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
}
