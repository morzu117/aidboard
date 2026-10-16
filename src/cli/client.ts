import type { AidPaths } from '../daemon/paths.js';
import { pidAlive, readInfo } from './daemonInfo.js';

export class DaemonUnreachable extends Error {
  constructor() {
    super('daemon injoignable : lancer `aid`');
  }
}

export interface ClientTarget {
  base: string;
  token: string;
}

// Un agent lancé par A-I-D a AID_URL et AID_TOKEN ; depuis le shell, c'est daemon.json.
export function resolveTarget(
  paths: AidPaths,
  env: NodeJS.ProcessEnv = process.env,
): ClientTarget | null {
  if (env.AID_URL && env.AID_TOKEN) return { base: env.AID_URL, token: env.AID_TOKEN };
  const info = readInfo(paths);
  if (!info || !pidAlive(info.pid)) return null;
  return { base: `http://127.0.0.1:${info.port}`, token: info.token };
}

export interface ClientResponse {
  status: number;
  json: Record<string, unknown>;
}

export async function callDaemon(
  target: ClientTarget | null,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<ClientResponse> {
  if (!target) throw new DaemonUnreachable();
  let res: Response;
  try {
    res = await fetch(`${target.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new DaemonUnreachable();
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { error: text };
  }
  return { status: res.status, json };
}
