import { existsSync } from 'node:fs';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';
import type { StructuralService } from '../structural/service.js';
import type { Indexer } from './index.js';

export interface RattrapageDeps {
  db: Db;
  store: EventStore;
  engine: StructuralService;
  indexer: Indexer;
  log: (line: string) => void;
}

export interface RattrapageBilan {
  synced: number;
  initialized: number;
  failed: number;
}

interface Row {
  id: string;
  workspace_id: string;
  worktree: string;
  index_state: string;
  root: string;
}

/**
 * 08.8 — Au démarrage du daemon, le moteur est relancé sur chaque sujet vivant :
 *
 * - `sync` là où le worktree a déjà son index : ce qui a bougé pendant que le daemon ne
 *   tournait pas (commits, rebase, édition hors A-I-D) est rattrapé, le sujet ne reste pas
 *   `stale` jusqu'au prochain hook git du moteur ;
 * - `init` là où le sujet est `disabled` mais le dépôt principal a adopté l'index depuis
 *   (D6 appliquée après coup) : plus besoin d'un `reindex` à la main par sujet.
 *
 * Un sujet à la fois : chaque lancement du moteur est un processus node complet, et la
 * machine est contrainte en mémoire. Moteur `off` : `detect` rend faux partout, rien ne part.
 * Un worktree absent du disque est ignoré sans événement. Tout échec d'écriture (base fermée
 * parce que le daemon s'arrête) interrompt la boucle : le rattrapage ne bloque jamais l'arrêt.
 */
export async function rattraperIndex(deps: RattrapageDeps): Promise<RattrapageBilan> {
  const { db, store, engine, indexer, log } = deps;
  const bilan: RattrapageBilan = { synced: 0, initialized: 0, failed: 0 };
  const rows = db
    .prepare(
      `SELECT t.id, t.workspace_id, t.worktree, t.index_state, w.root
       FROM topics t JOIN workspaces w ON w.id = t.workspace_id
       WHERE t.state IN ('active', 'review') ORDER BY t.created_at`,
    )
    .all() as Row[];
  for (const r of rows) {
    if (!existsSync(r.worktree)) continue;
    const topic = { id: r.id, workspaceId: r.workspace_id, worktree: r.worktree };
    const mode = engine.detect(r.worktree)
      ? 'sync'
      : r.index_state === 'disabled' && engine.detect(r.root)
        ? 'init'
        : null;
    if (!mode) continue;
    try {
      store.append({
        source: 'daemon',
        type: 'topic.state',
        workspaceId: r.workspace_id,
        topicId: r.id,
        data: { indexState: 'indexing' },
      });
      const outcome = mode === 'sync' ? await indexer.sync(topic) : await indexer.init(topic);
      if (outcome === 'failed') bilan.failed += 1;
      else if (mode === 'sync') bilan.synced += 1;
      else bilan.initialized += 1;
    } catch (err) {
      log(`index : rattrapage interrompu (${(err as Error).message})`);
      break;
    }
  }
  if (bilan.synced + bilan.initialized + bilan.failed > 0) {
    log(
      `index : ${bilan.synced} sujet(s) rattrapé(s), ${bilan.initialized} initialisé(s), ${bilan.failed} en échec`,
    );
  }
  return bilan;
}
