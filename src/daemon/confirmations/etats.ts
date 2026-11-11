import { raisonDeplacement } from '../../shared/deplacements.js';
import { randomUUID } from 'node:crypto';
import {
  argsEtat,
  hashAccept,
  lireParamsEtat,
  textesAPurger,
  type Etat,
  type ParametresEtat,
} from '../../shared/etats.js';
import { nettoyer } from '../../shared/nettoyage.js';
import type { AidConfig } from '../config.js';
import { AidHttpError } from '../errors.js';
import type { BoardReader } from '../mesh/board.js';
import { creerProxyClient } from '../mesh/proxy.js';
import type { Action } from './porte.js';

export function creerActionEtat(deps: {
  config?: AidConfig;
  board?: BoardReader | null;
  hotesPrives?: string[];
  journal?: (type: string, donnees: Record<string, string>) => void;
}): Action<'mesh.etat'> {
  return {
    async preparer(entree) {
      const mesh = deps.config?.mesh;
      if (!mesh?.cell || !deps.board) throw new AidHttpError(404, 'mesh désactivé');
      const action = entree.action;
      if (
        action !== 'obligation.prendre' &&
        action !== 'obligation.refuser' &&
        action !== 'obligation.clore' &&
        action !== 'carte.deplacer'
      )
        throw new AidHttpError(400, 'action inconnue');
      const lecture = lireParamsEtat(action, entree.params);
      if (!lecture.ok) throw new AidHttpError(400, 'paramètres d’état invalides');
      const params = lecture.params;
      for (const texte of textesAPurger(params)) {
        const nettoyage = nettoyer(texte, { hotesPrives: deps.hotesPrives ?? [] });
        if (!nettoyage.ok) throw new AidHttpError(422, nettoyage.classe);
      }
      if (!mesh.proxySocket) throw new AidHttpError(409, 'proxy_absent');
      if (action === 'carte.deplacer') {
        const deplacement = params as ParametresEtat['carte.deplacer'];
        const fiche = await deps.board
          .card(params.carte, { fresh: true, sansCache: true })
          .catch(() => null);
        if (
          !fiche?.card.ok ||
          raisonDeplacement(fiche.card.data, mesh.cell) !== null ||
          fiche.card.data.stage !== deplacement.attendu.stage ||
          fiche.card.data.stageVersion !== deplacement.attendu.stageVersion
        )
          throw new AidHttpError(409, 'perime');
        return { action, params } as Etat;
      }
      // Sans lecture fiable, aucune écriture : le téléphone devra relire la carte.
      const resultat = await deps.board.obligations(params.carte).catch(() => null);
      const obligation = resultat?.ok
        ? resultat.data.obligations.find(
            (o) => o.id === (params as ParametresEtat['obligation.prendre']).obligation,
          )
        : null;
      if (
        !obligation ||
        obligation.status !== 'open' ||
        (action !== 'obligation.clore' && obligation.takenAt !== null) ||
        ('acceptSha256' in params.attendu &&
          (await hashAccept(obligation.accept)) !== params.attendu.acceptSha256)
      )
        throw new AidHttpError(409, 'perime');
      return { action, params } as Etat;
    },
    async executer(etat, ctx) {
      const { verb, args } = argsEtat(etat.action, etat.params);
      const request_id = randomUUID();
      const reponse = await creerProxyClient({
        socket: deps.config!.mesh.proxySocket!,
        uuid: () => request_id,
      }).appeler(verb, args);
      const envoi = {
        code: reponse.ok ? ('succes' as const) : reponse.code,
        ...('status' in reponse && { status: reponse.status }),
        ...(etat.action === 'carte.deplacer' &&
          !reponse.ok && { refusal: reponse.refusal, current_stage: reponse.current_stage }),
        ...(etat.action === 'carte.deplacer' &&
          reponse.ok &&
          reponse.body.avertissement === true && {
            avertissement: true,
          }),
      };
      ctx.envoi = envoi;
      deps.journal?.('mesh.etat', {
        action: etat.action,
        carte: String(etat.params.carte),
        ...('obligation' in etat.params && { obligation: String(etat.params.obligation) }),
        request_id,
        code: envoi.code,
      });
    },
  };
}
