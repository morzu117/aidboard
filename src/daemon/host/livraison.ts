import { existsSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';
import type { ActionRun } from '../../shared/model.js';
import {
  blocageMerge,
  citations,
  compterControles,
  fraicheurRevue,
  lireControles,
  lirePr,
  sourceRevue,
} from '../../shared/livraison.js';
import type { Db } from '../db.js';
import { gitLivraison } from '../git/inspect.js';
import type { MemoryService } from '../memory/service.js';
import { filtrerTexte } from './filtre.js';

/** Lecture locale uniquement : aucune action ni requête GitHub. */
export async function livraisonPourAppareil(db: Db, memory: MemoryService, topicId: string) {
  const sujet = db
    .prepare(
      `SELECT t.*, w.namespace, w.name FROM topics t
    JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ?`,
    )
    .get(topicId) as
    | {
        worktree: string;
        branch: string;
        base: string;
        state: string;
        pr_number: number | null;
        namespace: string | null;
        name: string;
        slug: string;
      }
    | undefined;
  if (!sujet) return null;
  const derniere = (action: string, reussie = false): ActionRun | null => {
    const ligne = db
      .prepare(
        `SELECT * FROM actions WHERE topic_id = ? AND action = ?
      ${reussie ? "AND state = 'succeeded'" : ''} ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(topicId, action) as Record<string, unknown> | undefined;
    return ligne
      ? {
          id: ligne.id as string,
          topicId,
          workspaceId: ligne.workspace_id as string,
          action,
          state: ligne.state as ActionRun['state'],
          exitCode: ligne.exit_code as number | null,
          result: ligne.result ? JSON.parse(ligne.result as string) : null,
          startedAt: ligne.started_at as string,
          finishedAt: ligne.finished_at as string | null,
        }
      : null;
  };
  const pr = lirePr(derniere('pr.rafraichir', true)?.result ?? null);
  const page = memory.get(`${sujet.namespace ?? sujet.name}/review/${sujet.slug}`) ?? null;
  const source = sourceRevue(page, pr?.reviews ?? []);
  const revue =
    source?.commit && /^[0-9a-f]{4,40}$/.test(source.commit) ? source.commit : undefined;
  const manque = !sujet.worktree || !existsSync(sujet.worktree);
  const sansBranche = !sujet.branch;
  const git = manque || sansBranche ? null : await gitLivraison(sujet.worktree, sujet.base, revue);
  const fraicheur = fraicheurRevue(source, git?.revue ?? null);
  const controles = lireControles(pr, derniere('topic.test'));
  const head = pr?.headRefOid ?? git?.head ?? null;
  const blocage = manque
    ? 'le worktree du sujet manque.'
    : sansBranche
      ? 'le sujet n’a pas de branche.'
      : blocageMerge({
          fusionne: sujet.state === 'merged',
          aPr: sujet.pr_number !== null,
          pr,
          teteLocale: git?.head ?? null,
          fraicheur,
        });
  return {
    head,
    fichiers: (git?.files ?? []).map((f) => ({
      nom: filtrerTexte(
        isAbsolute(f.path) || win32.isAbsolute(f.path) || f.path.split(/[\\/]/).includes('..')
          ? '[masqué]'
          : f.path,
      ),
      ajouts: f.additions ?? 0,
      retraits: f.deletions ?? 0,
    })),
    controles: controles.map((c) => ({ nom: filtrerTexte(c.nom), etat: c.etat })),
    revue: { etat: fraicheur.etat, surLaTete: fraicheur.etat === 'a-jour' },
    blocage: blocage === null ? null : filtrerTexte(blocage),
    citations: citations(fraicheur, compterControles(controles, head)).map(filtrerTexte),
    prNumber: pr?.number ?? sujet.pr_number,
  };
}
