import { liensAid } from '../../shared/aid-board.js';
import type { Topic, Workspace } from '../../shared/model.js';
import type { Db } from '../db.js';
import type { BoardReader } from '../mesh/board.js';
import { IdentitesWorkspaces } from './workspace.js';

type Sujet = Pick<Topic, 'slug' | 'state' | 'phase' | 'branch' | 'prNumber' | 'prUrl'> & {
  sujetId: string;
  workspace: string;
  titre: string;
};

/** D291 : lecture locale indépendante de la recherche gateway ; aucune écriture. */
export async function lireBoardAid(
  db: Db,
  board: BoardReader | null,
  identites: IdentitesWorkspaces,
) {
  const locale = Promise.resolve().then(async () => {
    const workspaces = db
      .prepare('SELECT * FROM workspaces ORDER BY name')
      .all() as Array<Workspace>;
    const projets = new Map(
      await Promise.all(
        workspaces.map(async (w) => [w.id, await identites.lireWorkspace(w)] as const),
      ),
    );
    const lignes = db
      .prepare(
        `SELECT id AS sujetId, workspace_id AS workspace, slug, title AS titre,
      state, phase, branch, pr_number AS prNumber, pr_url AS prUrl FROM topics ORDER BY created_at, id`,
      )
      .all() as Sujet[];
    return lignes.map((s) => ({
      ...s,
      prUrl: s.prUrl?.startsWith('https://github.com/') ? s.prUrl : null,
      lien: projets.get(s.workspace) ? `${projets.get(s.workspace)}#${s.slug}` : null,
    }));
  });
  const [local, lecture] = await Promise.allSettled([
    locale,
    board?.chercherCartes('AID: ') ??
      Promise.resolve({ ok: false as const, kind: 'not-configured' as const }),
  ]);
  const sujetsLocaux = local.status === 'fulfilled' ? local.value : [];
  const lectureBoard =
    lecture.status === 'fulfilled'
      ? lecture.value
      : { ok: false as const, kind: 'lecture' as const };
  const cartes = lectureBoard.ok
    ? lectureBoard.data.cards.flatMap((carte) => {
        const liens = liensAid(carte.body ?? '');
        return liens.length
          ? [
              {
                ...carte,
                sujets: liens.map((l) => {
                  const lien = `${l.projet}#${l.slug}`;
                  return {
                    lien,
                    sujet: sujetsLocaux.find((s) => s.lien === lien)?.sujetId ?? 'absent',
                  };
                }),
              },
            ]
          : [];
      })
    : [];
  const sujets = sujetsLocaux.map((s) => {
    const ids = [
      ...new Set(cartes.filter((c) => c.sujets.some((l) => l.lien === s.lien)).map((c) => c.id)),
    ];
    return { ...s, carte: ids.length === 1 ? ids[0]! : null, conflit: ids.length > 1 ? ids : [] };
  });
  return {
    sujets,
    cartes,
    board: lectureBoard,
    erreurs: local.status === 'rejected' ? ['lecture locale'] : [],
  };
}
