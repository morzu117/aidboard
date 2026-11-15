import { verifierCibleMesh } from '../mesh/cible-ecriture.js';
import type { MeshRegistry } from '../mesh/registre.js';
import { creerActionsAvis } from './avis.js';
import type { AvisMeshService } from '../mesh/avis.js';
import { creerActionEtat } from './etats.js';
import { creerActionEcriture } from './ecritures.js';
import type { BoardReader } from '../mesh/board.js';
import { creerActionsHost, type DependancesHost } from './host.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIONS_MESH,
  resumeAction,
  type ParametresActions,
  type ParamsAction,
} from '../../shared/confirmations.js';
import { lirePr } from '../../shared/livraison.js';
import { startAction, scriptEnv, type ActionContext, type ActionSpec } from '../actions/service.js';
import { findAssetDir } from '../assets.js';
import type { AidConfig } from '../config.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { git } from '../git/exec.js';
import { gitLiveInfo } from '../git/inspect.js';
import type { StructuralService } from '../structural/service.js';
import type { ActionsPorte, ContexteAction, ActionPorte } from './porte.js';
import { creerReglage } from './reglage.js';

interface Sujet {
  id: string;
  workspace_id: string;
  branch: string;
  base: string;
  worktree: string;
  state: string;
  pr_number: number | null;
}
interface Projet {
  id: string;
  root: string;
  remote: string | null;
}
const TWO_MIN = 2 * 60_000;
const LIVE = ['starting', 'working', 'needs_input', 'idle'];

export function creerActionsConfirmation(
  deps: DependancesHost & {
    avis?: AvisMeshService;
    meshes?: MeshRegistry;
    board?: BoardReader | null;
    db: Db;
    config?: AidConfig;
    actions?: ActionContext;
    engine?: StructuralService;
  },
): ActionsPorte {
  const scripts = findAssetDir('scripts/git', 'topic-create.sh');
  const reglage = creerReglage(deps.db);
  const lireSujet = (id?: string) => {
    const topic = deps.db.prepare('SELECT * FROM topics WHERE id = ?').get(id ?? '') as
      Sujet | undefined;
    if (!topic) throw new AidHttpError(404, 'sujet inconnu');
    const ws = deps.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(topic.workspace_id) as Projet;
    return { topic, ws };
  };
  const teteBranche = async (ws: Projet, topic: Sujet) => {
    const tete = await git(ws.root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${topic.branch}`,
    ]);
    return tete.ok ? tete.stdout : null;
  };
  const env = (valeurs: Record<string, string>) =>
    scriptEnv(process.env, deps.config!.env.strip, valeurs);
  const lancer = (spec: ActionSpec, ctx: ContexteAction) => {
    let echec: string | null = null;
    const tache = startAction(deps.actions!, {
      ...spec,
      afterFailure: (out) => {
        echec = out.reason === 'timeout' ? 'delai' : 'script';
        spec.afterFailure?.(out);
      },
    });
    ctx.actionId ??= tache.actionId;
    return async () => {
      await tache.done;
      // afterSuccess peut lui aussi échouer : le résultat projeté fait foi.
      const ligne = deps.db
        .prepare('SELECT state FROM actions WHERE id = ?')
        .get(tache.actionId) as { state: string } | undefined;
      if (echec || ligne?.state !== 'succeeded') throw new Error(echec ?? 'script');
    };
  };
  const preparerProjet = (workspaceId?: string) => {
    const id = workspaceId ?? '';
    const db = deps.db;
    const projet = db.prepare('SELECT root FROM workspaces WHERE id = ?').get(id) as
      { root: string } | undefined;
    if (!projet) throw new AidHttpError(404, `projet ${id} inconnu`);
    const open = db
      .prepare("SELECT count(*) AS n FROM topics WHERE workspace_id = ? AND state != 'archived'")
      .get(id) as { n: number };
    if (open.n > 0)
      throw new AidHttpError(
        409,
        `${open.n} sujet${open.n > 1 ? 's' : ''} ouvert${open.n > 1 ? 's' : ''} : les archiver avant de retirer le projet`,
      );
    const runs =
      'SELECT r.id FROM runs r JOIN topics t ON t.id = r.topic_id WHERE t.workspace_id = ?';
    const live = db
      .prepare(
        `SELECT count(*) AS n FROM agents WHERE run_id IN (${runs}) AND status NOT IN ('done', 'error', 'stopped')`,
      )
      .get(id) as { n: number };
    if (live.n > 0) throw new AidHttpError(409, 'un agent tourne encore pour ce projet');
    return { workspaceId: id, racine: projet.root };
  };
  const signables = <A extends ActionPorte>(
    action: A,
    params: ParametresActions[A],
    ctx: ContexteAction,
  ) => {
    if (ctx.confirmation) {
      try {
        resumeAction(action, params);
      } catch {
        throw new AidHttpError(422, 'paramètres de confirmation invalides');
      }
    }
    return params;
  };
  const actionsMesh = (ctx: ContexteAction) => {
    if (!deps.meshes) {
      if (ctx.mesh && ctx.mesh !== 'principal') throw new AidHttpError(404, 'mesh inconnu');
      return {
        ...creerActionsAvis(deps.avis),
        'mesh.ecrire': creerActionEcriture(deps),
        'mesh.etat': creerActionEtat(deps),
      };
    }
    if (!ctx.mesh) throw new AidHttpError(409, 'perime');
    const services = deps.meshes.obtenir(ctx.mesh);
    const config = { ...deps.config!, mesh: deps.meshes.configuration(ctx.mesh) };
    return {
      ...creerActionsAvis(services.avis),
      'mesh.ecrire': creerActionEcriture({ ...deps, config, board: services.board }),
      'mesh.etat': creerActionEtat({ ...deps, config, board: services.board }),
    };
  };
  const parMesh = <A extends keyof ReturnType<typeof actionsMesh>>(action: A): ActionsPorte[A] =>
    ({
      preparer: async (entree, ctx) => {
        const params = await actionsMesh(ctx)[action].preparer(entree, ctx);
        if (deps.meshes && ctx.mesh)
          await verifierCibleMesh(deps.meshes.obtenir(ctx.mesh), {
            action,
            params,
          } as ParamsAction);
        return params;
      },
      executer: (params, ctx) =>
        (actionsMesh(ctx)[action] as ActionsPorte[A]).executer(params, ctx),
    }) as ActionsPorte[A];
  return {
    ...creerActionsHost(deps),
    'mesh.avis': parMesh('mesh.avis'),
    'mesh.avis.motion': parMesh('mesh.avis.motion'),
    'mesh.avis.baseline-absent': parMesh('mesh.avis.baseline-absent'),
    'mesh.ecrire': parMesh('mesh.ecrire'),
    'mesh.etat': parMesh('mesh.etat'),
    push: {
      async preparer(entree, ctx) {
        const { topic, ws } = lireSujet(entree.topicId);
        if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
        const live = await gitLiveInfo(topic.worktree, topic.base);
        if (!live.aheadBehind || live.aheadBehind.ahead === 0)
          throw new AidHttpError(422, 'rien à pousser : pas d’avance sur origin/' + topic.base);
        const [tete, distante] = await Promise.all([
          teteBranche(ws, topic),
          git(ws.root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${topic.branch}`]),
        ]);
        if (!tete && ctx.confirmation) throw new AidHttpError(409, 'tête locale inconnue');
        return signables(
          'push',
          {
            topicId: topic.id,
            branche: topic.branch,
            tete: tete ?? '',
            distante: distante.ok ? distante.stdout : null,
          },
          ctx,
        );
      },
      async executer(params, ctx) {
        const { topic, ws } = lireSujet(params.topicId);
        const attendre = lancer(
          {
            workspaceId: ws.id,
            topicId: topic.id,
            action: 'git.pousser',
            script: join(scripts, 'topic-push.sh'),
            cwd: topic.worktree,
            timeoutMs: TWO_MIN,
            env: env({
              AID_BRANCH: params.branche,
              AID_PUSH_TETE: params.tete,
              AID_PUSH_DISTANTE: params.distante ?? '',
            }),
          },
          ctx,
        );
        if (ctx.confirmation) await attendre();
      },
    },
    merge: {
      async preparer(entree, ctx) {
        const { topic, ws } = lireSujet(entree.topicId);
        if (topic.pr_number == null) throw new AidHttpError(409, 'aucune PR ouverte pour ce sujet');
        if (topic.state === 'merged') throw new AidHttpError(409, 'ce sujet est déjà fusionné');
        if (!entree.strategy) throw new AidHttpError(422, 'stratégie de fusion requise');
        if (ctx.confirmation && !['squash', 'merge', 'rebase'].includes(entree.strategy))
          throw new AidHttpError(422, 'stratégie de fusion invalide');
        if (entree.head !== undefined && !/^[0-9a-f]{40}$/.test(entree.head))
          throw new AidHttpError(422, 'tête invalide : 40 caractères hexadécimaux');
        if (ctx.confirmation && entree.message !== undefined)
          throw new AidHttpError(
            422,
            'message de merge personnalisé indisponible sous confirmation',
          );
        const connue = deps.db
          .prepare(
            "SELECT result FROM actions WHERE topic_id = ? AND action = 'pr.rafraichir' AND state = 'succeeded' ORDER BY started_at DESC, id DESC LIMIT 1",
          )
          .get(topic.id) as { result: string | null } | undefined;
        const pr = lirePr(connue?.result ? JSON.parse(connue.result) : null);
        if (
          ctx.confirmation &&
          entree.head &&
          pr?.headRefOid &&
          (pr.number !== topic.pr_number || pr.headRefOid !== entree.head)
        )
          throw new AidHttpError(409, 'tête de la PR modifiée : rafraîchis la PR');
        const tete = entree.head ?? (pr?.number === topic.pr_number ? pr.headRefOid : null) ?? '';
        if (ctx.confirmation && !/^[0-9a-f]{40}$/.test(tete))
          throw new AidHttpError(409, 'tête de la PR inconnue : rafraîchis la PR');
        const remote = ctx.confirmation
          ? await git(ws.root, ['remote', 'get-url', ws.remote ?? 'origin'])
          : null;
        const depot = remote?.ok
          ? (/(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote.stdout)?.[1] ?? '')
          : '';
        if (ctx.confirmation && !depot) throw new AidHttpError(409, 'dépôt du remote inconnu');
        return signables(
          'merge',
          {
            topicId: topic.id,
            depot,
            pr: topic.pr_number,
            tete,
            strategie: entree.strategy,
            supprimerBranche: !!entree.deleteBranch,
            nettoyer: !!entree.cleanupAfter,
            teteNettoyage: entree.cleanupAfter ? await teteBranche(ws, topic) : null,
          },
          ctx,
        );
      },
      async executer(params, ctx) {
        const { topic, ws } = lireSujet(params.topicId);
        let nettoyage: (() => Promise<void>) | undefined;
        const attendre = lancer(
          {
            workspaceId: ws.id,
            topicId: topic.id,
            action: 'topic.merge',
            script: join(scripts, 'topic-merge.sh'),
            cwd: topic.worktree,
            timeoutMs: TWO_MIN,
            env: env({
              AID_PR_NUMBER: String(params.pr),
              AID_MERGE_STRATEGY: params.strategie,
              ...(ctx.entree?.message && { AID_MERGE_MESSAGE: ctx.entree.message }),
              ...(params.supprimerBranche && { AID_MERGE_DELETE_BRANCH: '1' }),
              // Le chemin historique sans tête reste disponible avant l'armement.
              ...(params.tete && { AID_MERGE_EXIGER_TETE: '1', AID_MERGE_HEAD: params.tete }),
            }),
            afterSuccess: () => {
              deps.actions!.store.append({
                source: 'daemon',
                type: 'topic.state',
                workspaceId: ws.id,
                topicId: topic.id,
                data: { state: 'merged' },
              });
              if (params.nettoyer)
                nettoyage = lancer(
                  nettoyageSpec(
                    { topic, ws },
                    {
                      topicId: topic.id,
                      branche: topic.branch,
                      tete: params.teteNettoyage,
                      etat: 'merged',
                      nonFusionnes: null,
                      sale: 'refuser',
                    },
                    true,
                  ),
                  ctx,
                );
            },
          },
          ctx,
        );
        if (ctx.confirmation) {
          await attendre();
          await nettoyage?.();
        }
      },
    },
    nettoyage: {
      async preparer(entree, ctx) {
        const { topic, ws } = lireSujet(entree.topicId);
        const id = topic.id;
        if (
          ctx.etatAvantNettoyage !== undefined
            ? topic.state !== 'archived'
            : topic.state === 'archived'
        )
          throw new AidHttpError(409, 'ce sujet est déjà archivé');
        const alive = deps.db
          .prepare(
            `SELECT a.id, a.kind FROM agents a JOIN runs r ON r.id = a.run_id WHERE r.topic_id = ? AND a.status IN (${LIVE.map(() => '?').join(',')})`,
          )
          .all(id, ...LIVE) as Array<{ id: string; kind: string }>;
        if (alive.length > 0)
          throw new AidHttpError(
            409,
            'des agents tournent encore : les arrêter avant de nettoyer',
            { agents: alive },
          );
        if (entree.dirtyAction === 'force' && entree.confirmed !== true)
          throw new AidHttpError(422, 'suppression forcée : confirmation requise');
        if (
          ctx.confirmation &&
          entree.dirtyAction !== undefined &&
          !['stash', 'force'].includes(entree.dirtyAction)
        )
          throw new AidHttpError(422, 'traitement des modifications invalide');
        if (
          ctx.confirmation &&
          entree.confirmUnmerged !== undefined &&
          (!Number.isInteger(entree.confirmUnmerged) ||
            entree.confirmUnmerged < 0 ||
            entree.confirmUnmerged > 1e6)
        )
          throw new AidHttpError(422, 'nombre de commits invalide');
        return signables(
          'nettoyage',
          {
            topicId: id,
            branche: topic.branch,
            tete: await teteBranche(ws, topic),
            etat: ctx.etatAvantNettoyage ?? topic.state,
            nonFusionnes: entree.confirmUnmerged ?? null,
            sale: entree.dirtyAction ?? 'refuser',
          },
          ctx,
        );
      },
      async executer(params, ctx) {
        const sujet = lireSujet(params.topicId);
        const attendre = lancer(nettoyageSpec(sujet, params), ctx);
        if (ctx.confirmation) await attendre();
      },
    },
    'projet.retirer': {
      async preparer(entree, ctx) {
        return signables('projet.retirer', preparerProjet(entree.workspaceId), ctx);
      },
      async executer(params) {
        const id = params.workspaceId;
        const db = deps.db;
        const runs =
          'SELECT r.id FROM runs r JOIN topics t ON t.id = r.topic_id WHERE t.workspace_id = ?';
        db.transaction(() => {
          const relu = preparerProjet(id);
          if (relu.racine !== params.racine) throw new AidHttpError(409, 'racine modifiée');
          // Le groupe par défaut du projet disparaît avec lui ; un sujet d'un autre projet qui
          // y avait été déplacé (nav/placements) revient dans le groupe de son propre projet.
          const navGroup = db.prepare('SELECT id FROM nav_group WHERE workspace_id = ?').get(id) as
            { id: string } | undefined;
          if (navGroup) {
            const elsewhere = db
              .prepare(
                'SELECT p.topic_id AS topicId, t.workspace_id AS workspaceId FROM nav_placement p ' +
                  'JOIN topics t ON t.id = p.topic_id WHERE p.group_id = ? AND t.workspace_id != ?',
              )
              .all(navGroup.id, id) as Array<{ topicId: string; workspaceId: string }>;
            for (const p of elsewhere) {
              const home = db
                .prepare('SELECT id FROM nav_group WHERE workspace_id = ?')
                .get(p.workspaceId) as { id: string } | undefined;
              if (!home) continue;
              const ord =
                (
                  db
                    .prepare(
                      'SELECT COALESCE(MAX(ord), -1) AS m FROM nav_placement WHERE group_id = ?',
                    )
                    .get(home.id) as { m: number }
                ).m + 1;
              db.prepare('UPDATE nav_placement SET group_id = ?, ord = ? WHERE topic_id = ?').run(
                home.id,
                ord,
                p.topicId,
              );
            }
            db.prepare('DELETE FROM nav_placement WHERE group_id = ?').run(navGroup.id);
            db.prepare('DELETE FROM nav_group WHERE id = ?').run(navGroup.id);
          }
          db.prepare(`DELETE FROM agents WHERE run_id IN (${runs})`).run(id);
          db.prepare(
            'DELETE FROM runs WHERE topic_id IN (SELECT id FROM topics WHERE workspace_id = ?)',
          ).run(id);
          db.prepare(
            'DELETE FROM nav_placement WHERE topic_id IN (SELECT id FROM topics WHERE workspace_id = ?)',
          ).run(id);
          db.prepare('DELETE FROM topics WHERE workspace_id = ?').run(id);
          db.prepare('DELETE FROM actions WHERE workspace_id = ?').run(id);
          db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
        })();
      },
    },
    reglage: {
      async preparer(entree, ctx) {
        if (ACTIONS_MESH.has(entree.action ?? ''))
          throw new AidHttpError(400, 'confirmation obligatoire');
        if (
          entree.actif !== false ||
          !reglage.lire().some((l) => l.action === entree.action && l.actif)
        )
          throw new AidHttpError(409, 'réglage déjà coupé ou inconnu');
        return signables(
          'reglage',
          { action: entree.action! as ParametresActions['reglage']['action'], actif: false },
          ctx,
        );
      },
      async executer(params) {
        deps.db.transaction(() => {
          if (!reglage.exige(params.action)) throw new AidHttpError(409, 'réglage déjà coupé');
          reglage.couperConfirme(params.action);
        })();
      },
    },
  };
  function nettoyageSpec(
    { topic, ws }: { topic: Sujet; ws: Projet },
    params: ParametresActions['nettoyage'],
    apresMerge = false,
  ): ActionSpec {
    return {
      workspaceId: ws.id,
      topicId: topic.id,
      action: 'topic.cleanup',
      script: join(scripts, 'topic-cleanup.sh'),
      cwd: existsSync(topic.worktree) ? topic.worktree : ws.root,
      timeoutMs: TWO_MIN,
      env: env({
        AID_REPO_ROOT: ws.root,
        AID_TOPIC: topic.id,
        AID_SLUG: topic.worktree.split('/').at(-1) ?? '',
        AID_BRANCH: params.branche,
        AID_BASE: topic.base,
        ...(!apresMerge && { AID_REMOTE: ws.remote ?? '' }),
        AID_CLEANUP_TETE: params.tete ?? '',
        AID_WORKTREE: topic.worktree,
        ...(deps.engine?.bin && { AID_CODEGRAPH_BIN: deps.engine.bin }),
        ...(params.nonFusionnes !== null && { AID_CONFIRM_UNMERGED: String(params.nonFusionnes) }),
        ...(params.sale !== 'refuser' && { AID_DIRTY_ACTION: params.sale }),
      }),
      afterSuccess: (out) => {
        deps.actions!.store.append({
          source: 'daemon',
          type: 'topic.state',
          workspaceId: ws.id,
          topicId: topic.id,
          data: { state: 'archived' },
        });
        if (typeof out.result.stashRef === 'string')
          deps.actions!.store.append({
            source: 'daemon',
            type: 'topic.stash',
            workspaceId: ws.id,
            topicId: topic.id,
            data: { stashRef: out.result.stashRef },
          });
      },
    };
  }
}
