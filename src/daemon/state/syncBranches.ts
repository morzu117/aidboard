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
      // relue juste avant d'écrire : une relecture simultanée (deux GET, un rattachement) a pu l'écrire pendant l'attente
      const now = db.prepare('SELECT branch FROM topics WHERE id = ?').get(t.id) as
        { branch: string } | undefined;
      if (head && now && head !== now.branch) {
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
