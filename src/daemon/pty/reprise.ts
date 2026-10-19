import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AidPaths } from '../paths.js';
import type { AgentManager } from './manager.js';
import type { SpawnKind } from './spawn.js';

export interface RepriseEntry {
  topicId: string;
  kind: SpawnKind;
  path: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function repriseMdPath(topicId: string): string {
  return join('/tmp', `aid-reprise-${topicId}.md`);
}

function repriseMessage(path: string): string {
  return `Le daemon va redémarrer (mise à jour ou relance propre). Avant de t'arrêter : écris dans ${path} un résumé court de ce que tu as fait et de ce qu'il reste à faire, puis arrête d'écrire — tu seras relancé juste après avec ce résumé.`;
}

/**
 * Interrompt chaque agent vivant avant un redémarrage du daemon. Un shell, un agent en pause ou
 * avec une demande en cours ne peut pas recevoir de prompt : juste arrêté. Les autres reçoivent
 * une demande de résumé avant l'arrêt (best-effort, borné dans le temps — pas de blocage indéfini
 * si l'agent ne répond jamais).
 */
export async function gracefulInterrupt(
  agents: AgentManager,
  deadlineMs = 25_000,
): Promise<RepriseEntry[]> {
  const live = agents.liveAgents();
  const results = await Promise.all(
    live.map(async (a): Promise<RepriseEntry | null> => {
      if (a.kind === 'shell') {
        await agents.stop(a.id, 'daemon_stop');
        return null;
      }
      const path = repriseMdPath(a.topicId);
      try {
        rmSync(path, { force: true });
        agents.input(a.id, repriseMessage(path));
      } catch {
        await agents.stop(a.id, 'daemon_stop');
        return null;
      }
      const deadline = Date.now() + deadlineMs;
      while (!existsSync(path) && Date.now() < deadline) await sleep(300);
      await agents.stop(a.id, 'daemon_stop');
      if (!existsSync(path)) return null;
      const content = readFileSync(path, 'utf8').trim();
      return content ? { topicId: a.topicId, kind: a.kind, path } : null;
    }),
  );
  return results.filter((e): e is RepriseEntry => e !== null);
}

/**
 * Au démarrage du nouveau daemon : relance chaque sujet listé par le cycle précédent et lui
 * injecte son résumé. Le manifeste est supprimé dès lu, pour ne jamais reprendre deux fois.
 */
export async function resumeFromManifest(agents: AgentManager, paths: AidPaths): Promise<void> {
  if (!existsSync(paths.repriseJson)) return;
  let entries: RepriseEntry[];
  try {
    entries = JSON.parse(readFileSync(paths.repriseJson, 'utf8')) as RepriseEntry[];
  } catch {
    return;
  } finally {
    rmSync(paths.repriseJson, { force: true });
  }
  await Promise.all(
    entries.map(async (entry) => {
      let content = '';
      try {
        content = readFileSync(entry.path, 'utf8').trim();
      } catch {
        return;
      }
      if (!content) return;
      let agentId: string;
      try {
        agentId = agents.spawn({ topicId: entry.topicId, kind: entry.kind }).id;
      } catch {
        return;
      }
      const deadline = Date.now() + 10_000;
      while (agents.screen(agentId, 1).length === 0 && Date.now() < deadline) await sleep(300);
      try {
        agents.input(agentId, `Reprise après redémarrage du daemon :\n\n${content}`);
      } catch {
        // l'agent n'est pas prêt à recevoir : la note reste perdue, pas de deuxième tentative
      } finally {
        rmSync(entry.path, { force: true });
      }
    }),
  );
}
