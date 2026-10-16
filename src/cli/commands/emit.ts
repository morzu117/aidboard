import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ulid } from 'ulid';
import {
  EVENT_SOURCES,
  EVENT_TYPES,
  type EventSource,
  type EventType,
} from '../../shared/events.js';

export type EmitEnv = Partial<
  Record<
    'AID_URL' | 'AID_TOKEN' | 'AID_RUN' | 'AID_AGENT' | 'AID_SPOOL' | 'AID_HOME' | 'HOME',
    string
  >
>;

export type EmitOutcome = 'skipped' | 'posted' | 'spooled' | 'rejected';

export interface Envelope {
  v: 1;
  id: string;
  ts: string;
  source: EventSource;
  type: EventType;
  runId: string;
  agentId: string;
  data: Record<string, unknown>;
}

const spoolDir = (env: EmitEnv) =>
  env.AID_SPOOL ?? join(env.AID_HOME ?? join(env.HOME ?? '', '.aid'), 'spool');

/**
 * Complète l'enveloppe depuis l'environnement et la poste au daemon. Hors A-I-D (pas d'AID_AGENT) : rien.
 * Daemon injoignable : le spool, rejoué au prochain démarrage. Refus du daemon : ni réessai ni spool, il refuserait
 * encore. Ne lève jamais : un hook ne doit pas faire échouer la session qui l'appelle.
 */
export async function emitEvent(
  type: EventType,
  data: Record<string, unknown>,
  env: EmitEnv,
  opts: { source?: EventSource; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ outcome: EmitOutcome; error?: string }> {
  if (!env.AID_AGENT || !env.AID_RUN) return { outcome: 'skipped' };
  const envelope: Envelope = {
    v: 1,
    id: ulid(),
    ts: new Date().toISOString(),
    source: opts.source ?? 'hook:claude',
    type,
    runId: env.AID_RUN,
    agentId: env.AID_AGENT,
    data,
  };
  if (env.AID_URL && env.AID_TOKEN) {
    try {
      const res = await (opts.fetchImpl ?? fetch)(`${env.AID_URL}/api/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.AID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
      });
      if (res.ok) return { outcome: 'posted' };
      // 401 : token d'un daemon d'avant le redémarrage, le daemon d'aujourd'hui le rejouera depuis le spool
      if (res.status !== 401)
        return { outcome: 'rejected', error: `${res.status} ${await res.text()}` };
    } catch {
      // daemon absent ou trop lent : le spool (l'id rend un double envoi sans effet)
    }
  }
  try {
    const dir = spoolDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, `${envelope.id}.json`), JSON.stringify(envelope), { mode: 0o600 });
    return { outcome: 'spooled' };
  } catch (err) {
    return { outcome: 'rejected', error: `spool impossible : ${(err as Error).message}` };
  }
}

/** `aid emit <type> [--status s] [--reason r] [--message m] [--data json] [--source s]` */
export async function runEmit(argv: string[], env: EmitEnv = process.env): Promise<number> {
  if (!env.AID_AGENT) return 0;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        status: { type: 'string' },
        reason: { type: 'string' },
        message: { type: 'string' },
        data: { type: 'string' },
        source: { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`aid emit : ${(err as Error).message}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const type = positionals[0] as EventType;
  if (!EVENT_TYPES.includes(type)) {
    console.error(`aid emit : type inconnu « ${positionals[0] ?? ''} »`);
    return 2;
  }
  const source = (values.source ?? 'hook:claude') as EventSource;
  if (!EVENT_SOURCES.includes(source)) {
    console.error(`aid emit : source inconnue « ${values.source} »`);
    return 2;
  }
  let data: Record<string, unknown> = {};
  if (values.data) {
    let parsedData: unknown;
    try {
      parsedData = JSON.parse(values.data);
    } catch {
      parsedData = null;
    }
    if (!parsedData || typeof parsedData !== 'object' || Array.isArray(parsedData)) {
      console.error('aid emit : --data doit être un objet JSON');
      return 2;
    }
    data = parsedData as Record<string, unknown>;
  }
  if (values.status) data.status = values.status;
  if (values.reason) data.reason = values.reason;
  if (values.message) data.message = values.message;
  const r = await emitEvent(type, data, env, { source });
  if (r.outcome === 'rejected') {
    console.error(`aid emit : ${r.error}`);
    return 1;
  }
  return 0;
}
