import { randomUUID } from 'node:crypto';
import {
  argsProxy,
  lireParamsEcriture,
  lireReponseEcriture,
  type ResultatEnvoi,
  type Ecriture,
} from '../../shared/ecritures.js';
import { nettoyer } from '../../shared/nettoyage.js';
import type { AidConfig } from '../config.js';
import { AidHttpError } from '../errors.js';
import type { BoardReader } from '../mesh/board.js';
import { creerProxyClient } from '../mesh/proxy.js';
import type { Action } from './porte.js';

export function creerActionEcriture(deps: {
  config?: AidConfig;
  board?: BoardReader | null;
  hotesPrives?: string[];
  journal?: (type: string, donnees: Record<string, string>) => void;
}): Action<'mesh.ecrire'> {
  return {
    async preparer(entree) {
      const mesh = deps.config?.mesh;
      if (!mesh?.cell || !deps.board) throw new AidHttpError(404, 'mesh désactivé');
      if (!mesh.proxySocket) throw new AidHttpError(409, 'proxy_absent');
      const action = entree.action;
      if (action !== 'carte.note' && action !== 'dm.envoyer' && action !== 'canal.poster')
        throw new AidHttpError(400, 'action inconnue');
      const lecture = lireParamsEcriture(action, entree.params, mesh.cell);
      // Ne jamais inclure une clé fournie par le client dans une erreur d'envoi.
      if (!lecture.ok) throw new AidHttpError(400, 'paramètres d’écriture invalides');
      const params = lecture.params;
      const nettoyage = nettoyer(params.texte, { hotesPrives: deps.hotesPrives ?? [] });
      if (!nettoyage.ok) throw new AidHttpError(422, nettoyage.classe);
      try {
        argsProxy(action, params);
      } catch (e) {
        throw new AidHttpError(400, (e as Error).message);
      }
      if (action === 'carte.note' && 'carte' in params) {
        // Rappel non bloquant du 35, relu sans cache ; il n'entre pas dans les params signés.
        try {
          await deps.board.obligations(params.carte);
        } catch {
          /* Une lecture indisponible ne bloque pas une note. */
        }
      }
      return { action, params } as Ecriture;
    },
    async executer(ecriture, ctx) {
      const { verb, args } = argsProxy(ecriture.action, ecriture.params);
      const request_id = randomUUID();
      const reponse = await creerProxyClient({
        socket: deps.config!.mesh.proxySocket!,
        uuid: () => request_id,
      }).appeler(verb, args);
      let envoi: ResultatEnvoi;
      if (!reponse.ok)
        envoi = {
          code: reponse.code,
          open_obligations: [],
          ...('status' in reponse && { status: reponse.status }),
        };
      else {
        const lecture = lireReponseEcriture(reponse.body);
        envoi = lecture.ok
          ? {
              code: 'succes',
              id: lecture.id,
              open_obligations: lecture.open_obligations,
              status: reponse.status,
            }
          : { code: lecture.kind, open_obligations: [], status: reponse.status };
      }
      ctx.envoi = envoi;
      const params = ecriture.params;
      deps.journal?.('mesh.ecrire', {
        action: ecriture.action,
        request_id,
        code: envoi.code,
        ...('carte' in params
          ? { carte: String(params.carte) }
          : 'pair' in params
            ? { pair: params.pair }
            : { canal: params.canal }),
      });
    },
  };
}
