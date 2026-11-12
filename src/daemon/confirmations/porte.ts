import { createHash } from 'node:crypto';
import type { ResultatEnvoi } from '../../shared/ecritures.js';
import { ACTIONS_MESH, validerParamsAction } from '../../shared/confirmations.js';
import type { FastifyRequest } from 'fastify';
import { jsonCanonique, type ParametresActions, type ParamsAction } from '../../shared/pda.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { DemandeTropGrande } from '../pda/demande.js';
import type { FilePda, LigneDemande } from '../pda/file.js';
import { creerReglage } from './reglage.js';

export type ActionPorte =
  | 'mesh.avis.motion'
  | 'mesh.avis'
  | 'mesh.avis.baseline-absent'
  | 'mesh.etat'
  | 'mesh.ecrire'
  | 'merge'
  | 'push'
  | 'nettoyage'
  | 'projet.retirer'
  | 'reglage'
  | 'appairage'
  | 'pda.activer'
  | 'host.option'
  | 'desarmement';
export interface EntreeAction {
  params?: unknown;
  topicId?: string;
  workspaceId?: string;
  strategy?: 'squash' | 'merge' | 'rebase';
  head?: string;
  message?: string;
  deleteBranch?: boolean;
  cleanupAfter?: boolean;
  confirmUnmerged?: number;
  dirtyAction?: 'stash' | 'force';
  confirmed?: boolean;
  action?:
    | ParametresActions['reglage']['action']
    | ParametresActions['mesh.ecrire']['action']
    | ParametresActions['mesh.etat']['action'];
  actif?: boolean;
  appairageId?: string;
  sansIdentite?: boolean;
  appareilId?: string;
  empreinte?: unknown;
  option?: 'code' | 'push';
}
export interface ContexteAction {
  envoi?: ResultatEnvoi | Pick<ResultatEnvoi, 'code' | 'status'>;
  confirmation: boolean;
  amorcage?: boolean;
  entree?: EntreeAction;
  actionId?: string;
  etatAvantNettoyage?: string;
}
export interface Action<A extends ActionPorte> {
  preparer(entree: EntreeAction, ctx: ContexteAction): Promise<ParametresActions[A]>;
  executer(params: ParametresActions[A], ctx: ContexteAction): Promise<void>;
}
export type ActionsPorte = { [A in ActionPorte]: Action<A> };

export function creerPorte(deps: {
  db: Db;
  actions: ActionsPorte;
  file: () => FilePda | null;
  signaler?: () => void;
}) {
  const reglage = creerReglage(deps.db);
  const terminer = (id: string, resultat: string, raison: string | null = null) => {
    deps.db
      .prepare('UPDATE pda_demandes SET resultat = ?, raison = ? WHERE id = ?')
      .run(resultat, raison, id);
    deps.signaler?.();
  };
  const reconstruire = (action: ActionPorte, p: ParametresActions[ActionPorte]): EntreeAction => {
    switch (action) {
      case 'merge': {
        const m = p as ParametresActions['merge'];
        return {
          topicId: m.topicId,
          strategy: m.strategie,
          head: m.tete,
          deleteBranch: m.supprimerBranche,
          cleanupAfter: m.nettoyer,
        };
      }
      case 'nettoyage': {
        const n = p as ParametresActions['nettoyage'];
        return {
          topicId: n.topicId,
          ...(n.nonFusionnes !== null && { confirmUnmerged: n.nonFusionnes }),
          ...(n.sale !== 'refuser' && { dirtyAction: n.sale }),
          confirmed: n.sale === 'force',
        };
      }
      default:
        return p as EntreeAction;
    }
  };
  return {
    // La préparation asynchrone précède la transaction ; le contrôle d'état et
    // l'archivage renvoyés sont exécutés avec la consommation (D224).
    async preparerConsommation(ligne: LigneDemande): Promise<() => void> {
      if (ligne.action !== 'nettoyage') return () => {};
      try {
        const params = JSON.parse(ligne.params!) as ParametresActions['nettoyage'];
        if (!validerParamsAction('nettoyage', params)) throw new Error('schema');
        const relus = await deps.actions.nettoyage.preparer(reconstruire('nettoyage', params), {
          confirmation: true,
        });
        if (jsonCanonique(relus) !== jsonCanonique(params)) throw new Error('perime');
        return () => {
          const modifie = deps.db
            .prepare(
              `UPDATE topics SET state = 'archived' WHERE id = ? AND branch = ? AND state = ? AND state != 'archived'
            AND NOT EXISTS (SELECT 1 FROM agents a JOIN runs r ON r.id = a.run_id WHERE r.topic_id = topics.id AND a.status IN ('starting', 'working', 'needs_input', 'idle'))`,
            )
            .run(params.topicId, params.branche, params.etat);
          if (modifie.changes !== 1) ligne.perimee = true;
          else ligne.etatAvantNettoyage = params.etat;
        };
      } catch {
        ligne.perimee = true;
        return () => {};
      }
    },
    async demander<A extends ActionPorte>(action: A, entree: EntreeAction, req: FastifyRequest) {
      if (req.principal?.kind !== 'admin') throw new AidHttpError(403, 'admin seulement');
      const arme = reglage.arme();
      if (ACTIONS_MESH.has(action) && !arme) throw new AidHttpError(409, 'confirmation_requise');
      const confirmation = arme && reglage.exige(action);
      if (ACTIONS_MESH.has(action) && !confirmation)
        throw new AidHttpError(409, 'confirmation_requise');
      const params = await deps.actions[action].preparer(entree, { confirmation, entree });
      if (!confirmation) return { direct: params };
      const file = deps.file();
      if (
        !file?.disponible() ||
        !deps.db.prepare("SELECT 1 FROM pda_appareils WHERE etat = 'actif' LIMIT 1").get()
      )
        throw new AidHttpError(409, 'confirmation_impossible', {
          message: 'Allume le PDA et active un téléphone pour cette action',
        });
      const { id } = await file.creerDemande({ action, params } as ParamsAction).catch((e) => {
        if (e instanceof DemandeTropGrande) throw new AidHttpError(413, 'demande_trop_grande');
        throw e;
      });
      return { confirmation: id };
    },
    async executer<A extends ActionPorte>(
      action: A,
      params: ParametresActions[A],
      entree: EntreeAction,
    ) {
      const ctx: ContexteAction = { confirmation: false, entree };
      await deps.actions[action].executer(params, ctx);
      return ctx.actionId;
    },
    async executerConfirmee(ligne: LigneDemande) {
      if (ligne.perimee || !Object.hasOwn(deps.actions, ligne.action) || ligne.params === null) {
        terminer(ligne.id, 'perimee', 'perime');
        return;
      }
      const action = ligne.action as ActionPorte;
      const definition = deps.actions[action] as Action<ActionPorte>;
      let params: ParametresActions[ActionPorte];
      try {
        params = JSON.parse(ligne.params);
        if (ACTIONS_MESH.has(action)) {
          const stockee = deps.db
            .prepare('SELECT resume, cree_a FROM pda_demandes WHERE id = ?')
            .get(ligne.id) as { resume: string; cree_a: string };
          const corps = {
            v: 2,
            id: ligne.id,
            action,
            classe: ligne.classe,
            params,
            resume: stockee.resume,
            numero: ligne.numero,
            echeance: ligne.echeance,
            emise: Date.parse(stockee.cree_a),
          };
          if (
            createHash('sha256').update(jsonCanonique(corps)).digest('base64url') !== ligne.hDemande
          )
            throw new Error('perime');
        }
        if (!validerParamsAction(action, params)) throw new Error('schema');
        const relus = await definition.preparer(reconstruire(action, params), {
          confirmation: true,
          etatAvantNettoyage: ligne.etatAvantNettoyage,
        });
        if (jsonCanonique(relus) !== jsonCanonique(params)) throw new Error('perime');
      } catch {
        terminer(ligne.id, 'perimee', 'perime');
        return;
      }
      try {
        const ctx: ContexteAction = { confirmation: true };
        await definition.executer(params, ctx);
        if (ctx.envoi) {
          deps.db
            .prepare('UPDATE pda_demandes SET envoi = ? WHERE id = ?')
            .run(JSON.stringify(ctx.envoi), ligne.id);
          terminer(ligne.id, ctx.envoi.code === 'succes' ? 'executee' : 'echouee');
        } else terminer(ligne.id, 'executee');
      } catch (e) {
        terminer(
          ligne.id,
          e instanceof AidHttpError && e.status === 409 ? 'perimee' : 'echouee',
          e instanceof AidHttpError && e.status === 409
            ? 'perime'
            : e instanceof Error && e.message === 'delai'
              ? 'delai'
              : 'script',
        );
      }
    },
  };
}
export type Porte = ReturnType<typeof creerPorte>;
