import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.js';
import { admitAgentEvent, isEventBody } from './admit.js';
import type { EventStore } from './store.js';

/**
 * Rejoue ce qu'`aid emit` a écrit pendant que le daemon était absent. Chaque fichier passe les contrôles d'un
 * événement d'agent ; l'id rend le rejeu idempotent. Un fichier refusé part dans `rejet/`, pour qu'on puisse le lire.
 */
export function replaySpool(
  dir: string,
  db: Db,
  store: EventStore,
): { replayed: number; rejected: number } {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort();
  } catch {
    return { replayed: 0, rejected: 0 };
  }
  let replayed = 0;
  let rejected = 0;
  for (const name of names) {
    const file = join(dir, name);
    let ok = false;
    try {
      const body: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (isEventBody(body) && body.id && body.runId && !admitAgentEvent(db, body, body.runId)) {
        store.append(body as never);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (ok) {
      rmSync(file, { force: true });
      replayed++;
    } else {
      mkdirSync(join(dir, 'rejet'), { recursive: true, mode: 0o700 });
      renameSync(file, join(dir, 'rejet', name));
      rejected++;
    }
  }
  return { replayed, rejected };
}
