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
/** Flux longs (review S.2) : sans sonde, une connexion morte ne se voit qu'au bout de plusieurs heures. */
const SSH_KEEPALIVE = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

/** Guillemets simples POSIX : seul `'` est à traiter, tout le reste est littéral. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * La commande telle que le serveur la reçoit : toujours dans le shell distant configuré, en shell de
 * connexion (`-l`) pour que le PATH du profil (`~/.local/bin`…) soit celui où `claude` est installé.
 * Suppose un shell de connexion POSIX côté serveur (le `'\''` ne passe pas sous csh).
 */
export function remoteCommand(server: Pick<Server, 'shell'>, cmd: string): string {
  return `${shQuote(server.shell)} -lc ${shQuote(cmd)}`;
}

/** Argv local qui exécute `cmd` sur le serveur, par mode (D72). Jamais de concaténation ailleurs. */
export function remoteArgv(
  server: Pick<Server, 'mode' | 'target' | 'sshOptions' | 'loadProfile' | 'shell'>,
  cmd: string,
  opts: TransportOptions & { keepAlive?: boolean } = {},
): Argv {
  const ssh = opts.ssh ?? 'ssh';
  const remote = remoteCommand(server, cmd);
  const base = opts.keepAlive ? [...SSH_BASE, ...SSH_KEEPALIVE] : SSH_BASE;
  if (server.mode === 'ssh_alias') {
    return { file: ssh, args: [...base, '--', server.target, remote] };
  }
  if (server.mode === 'ssh_host') {
    const o = server.sshOptions;
    const extra: string[] = [];
    if (o?.port != null) extra.push('-p', String(o.port));
    if (o?.user != null) extra.push('-l', o.user);
    if (o?.identityFile != null) extra.push('-i', o.identityFile);
    if (o?.jump != null) extra.push('-J', o.jump);
    return { file: ssh, args: [...base, ...extra, '--', server.target, remote] };
  }
  // Commande locale : un préfixe qui accepte une commande distante en argument (ex. `ssh vps`). Une
  // fonction du profil n'existe que dans un shell qui le charge (§11.0) : d'où `-ic` si demandé.
  const line = `${server.target} ${shQuote(remote)}`;
  const env = opts.env ?? process.env;
  if (!server.loadProfile) return { file: '/bin/sh', args: ['-c', line] };
  // Sans SHELL (daemon lancé hors session), `/bin/sh -ic` ne chargerait pas le profil de l'opérateur :
  // mieux vaut le dire que retomber en silence sur un shell qui ne connaît pas la fonction (review S.2).
  if (!env.SHELL)
    throw new Error('SHELL absent de l’environnement du daemon : profil shell introuvable');
  return { file: env.SHELL, args: ['-ic', line] };
}

/** Tue tout le groupe de processus d'un enfant lancé en `detached` (ssh, ou `sh -c` et son ssh). */
export function killGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
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
  opts: TransportOptions & { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
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
    // déclarés avant `finish` : un `spawn` qui lève l'appelle avant tout minuteur (review S.2)
    const timers: { main?: NodeJS.Timeout; kill?: NodeJS.Timeout } = {};
    // arrêt du daemon (review S.3) : le groupe est tué sans attendre le délai
    const hooks: { abort?: () => void } = {};
    const finish = (code: number | null, extraErr?: string) => {
      if (settled) return;
      settled = true;
      if (hooks.abort) opts.signal?.removeEventListener('abort', hooks.abort);
      clearTimeout(timers.main);
      clearTimeout(timers.kill);
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
    if (opts.signal?.aborted) {
      finish(null, 'interrompu');
      return;
    }
    try {
      const { file, args } = remoteArgv(server, cmd, opts);
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
    timers.main = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      timers.kill = setTimeout(() => {
        killGroup(child, 'SIGKILL');
        // un descendant sorti du groupe garderait les tuyaux : on n'attend plus `close`
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, SIGKILL_DELAY_MS);
      timers.kill.unref();
    }, timeoutMs);
    child.stdout!.on('data', (c: Buffer) => (outBytes = keep(out, outBytes, c)));
    child.stderr!.on('data', (c: Buffer) => (errBytes = keep(err, errBytes, c)));
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
    hooks.abort = () => {
      killGroup(child, 'SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, 'interrompu');
    };
    opts.signal?.addEventListener('abort', hooks.abort, { once: true });
  });
}

/**
 * Flux long (relais d'un agent, R.2) : stdin, stdout et stderr ouverts, sondes de vie ssh, groupe de
 * processus à part (à arrêter par `killGroup`). Les erreurs du process et d'une écriture sur un stdin
 * fermé sont absorbées : l'appelant les lit par `exit`, jamais par une exception non capturée.
 */
export function remoteSpawn(
  server: Parameters<typeof remoteArgv>[0],
  cmd: string,
  opts: TransportOptions = {},
): ChildProcessWithoutNullStreams {
  const { file, args } = remoteArgv(server, cmd, { ...opts, keepAlive: true });
  const child = spawn(file, args, {
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  return child;
}
