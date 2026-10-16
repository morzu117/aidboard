import { readFileSync } from 'node:fs';
import type { AidPaths } from '../daemon/paths.js';

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export function readInfo(paths: AidPaths): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(paths.daemonJson, 'utf8')) as DaemonInfo;
    return typeof info.pid === 'number' &&
      typeof info.port === 'number' &&
      typeof info.token === 'string'
      ? info
      : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function openUrl(info: DaemonInfo): string {
  return `http://127.0.0.1:${info.port}/?token=${info.token}`;
}

export async function daemonFetch(
  info: DaemonInfo,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${info.token}`,
      host: `127.0.0.1:${info.port}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  return { status: res.status, json };
}

/** Le daemon décrit par daemon.json répond-il vraiment ? Un fichier resté d'un daemon mort ne compte pas. */
export async function runningDaemon(paths: AidPaths): Promise<DaemonInfo | null> {
  const info = readInfo(paths);
  if (!info || !pidAlive(info.pid)) return null;
  try {
    return (await daemonFetch(info, 'GET', '/api/state')).status === 200 ? info : null;
  } catch {
    return null;
  }
}
