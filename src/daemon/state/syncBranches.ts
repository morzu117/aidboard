import { existsSync } from 'node:fs';
import { currentBranchFast } from '../git/inspect.js';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';

interface TopicRow {
  id: string;
  branch: string;
  worktree: string;
  workspace_id: string;
}

// La branche réelle d'un worktree dérive hors d'A-I-D (checkout, rebase, renommage) : on la
// rapproche de topic.branch avant chaque lecture d'état, sinon le badge reste figé à la création.
export async function syncTopicBranches(db: Db, store: EventStore): Promise<void> {
  const topics = db
    .prepare("SELECT id, branch, worktree, workspace_id FROM topics WHERE state != 'archived'")
    .all() as TopicRow[];
  await Promise.all(
    topics.map(async (t) => {
      if (!existsSync(t.worktree)) return;
      const head = await currentBranchFast(t.worktree);
      if (head && head !== t.branch) {
        store.append({
          source: 'daemon',
          type: 'topic.branch',
          workspaceId: t.workspace_id,
          topicId: t.id,
          data: { branch: head },
        });
      }
    }),
  );
}

// Les GET /api/state simultanés (plusieurs onglets ; chaque page relit l'état à chaque événement) partagent la
// relecture en cours au lieu d'en lancer une chacun.
const enCours = new WeakMap<Db, Promise<void>>();
export function syncTopicBranchesShared(db: Db, store: EventStore): Promise<void> {
  let p = enCours.get(db);
  if (!p) {
    p = syncTopicBranches(db, store).finally(() => enCours.delete(db));
    enCours.set(db, p);
  }
  return p;
}
