import type { CreationsCartes } from './cartes.js';
import { randomUUID } from 'node:crypto';
import {
  argsProxy,
  ligneSwairm,
  creationIncertaine,
  messageCreation,
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
  cartes?: CreationsCartes;
  board?: BoardReader | null;
  hotesPrives?: string[];
  journal?: (type: string, donnees: Record<string, string>) => void;
}): Action<'mesh.ecrire'> {
  return {
    async preparer(entree, ctx) {
      const mesh = deps.config?.mesh;
      if (!mesh?.cell || !deps.board) throw new AidHttpError(404, 'mesh désactivé');
      if (!mesh.proxySocket) throw new AidHttpError(409, 'proxy_absent');
      if (mesh.proxyLectureSeule) throw new AidHttpError(409, 'proxy_lecture_seule');
      const action = entree.action;
      if (
        action !== 'carte.creer' &&
        action !== 'carte.note' &&
        action !== 'dm.envoyer' &&
        action !== 'canal.poster'
      )
        throw new AidHttpError(400, 'action inconnue');
      const lecture = lireParamsEcriture(action, entree.params, mesh.cell);
      // Ne jamais inclure une clé fournie par le client dans une erreur d'envoi.
      if (!lecture.ok) throw new AidHttpError(400, 'paramètres d’écriture invalides');
      const params = lecture.params;
      const textes = 'titre' in params ? [params.titre, params.corps] : [params.texte];
      for (const texte of textes) {
        const nettoyage = nettoyer(texte, { hotesPrives: deps.hotesPrives ?? [] });
        if (!nettoyage.ok) throw new AidHttpError(422, nettoyage.classe);
      }
      if ('projet' in params) {
        if (!deps.cartes) throw new AidHttpError(409, 'création indisponible');
        deps.cartes.verifier(ctx.mesh ?? 'principal', ligneSwairm(params.corps)!);
        const projets = await deps.board.projects({ fresh: true, sansCache: true });
        if (!projets.ok) throw new AidHttpError(409, 'liste des projets indisponible');
        if (!projets.data.some((p) => p.id === params.projet && p.title === params.projetNom))
          throw new AidHttpError(400, 'projet absent ou nom de projet différent');
      }
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
      const mesh = ctx.mesh ?? 'principal';
      const creation = ecriture.action === 'carte.creer' ? ecriture.params : null;
      const ligne = creation ? ligneSwairm(creation.corps)! : null;
      let reserve = false;
      let envoye = false;
      try {
        if (creation) {
          if (!deps.cartes) throw new AidHttpError(409, 'création indisponible');
          deps.cartes.reserver(mesh, ligne!, creation.projet);
          reserve = true;
          const avant = await deps.cartes.lire(mesh, ligne!);
          if (!avant.ok || avant.id !== null) {
            deps.cartes.effacer(mesh, ligne!);
            reserve = false;
            ctx.envoi = avant.ok
              ? {
                  code: 'succes',
                  id: avant.id!,
                  open_obligations: [],
                  cree: false,
                  message: `Une carte porte déjà ce sujet : #${avant.id}. Rien n'a été créé.`,
                }
              : {
                  code: 'verification_board',
                  open_obligations: [],
                  cree: false,
                  message: "La vérification du board a échoué. Rien n'a été créé.",
                };
            return;
          }
        }
        const { verb, args } = argsProxy(ecriture.action, ecriture.params);
        const request_id = randomUUID();
        const client = creerProxyClient({
          socket: deps.config!.mesh.proxySocket!,
          uuid: () => request_id,
        });
        envoye = true;
        const reponse = await client.appeler(verb, args);
        let envoi: ResultatEnvoi;
        if (!reponse.ok)
          envoi = {
            code: reponse.code,
            open_obligations: [],
            ...('status' in reponse && { status: reponse.status }),
          };
        else {
          const lecture = creation
            ? Number.isSafeInteger(reponse.body.id) && (reponse.body.id as number) > 0
              ? { ok: true as const, id: reponse.body.id as number, open_obligations: [] }
              : { ok: false as const, kind: 'format' as const }
            : lireReponseEcriture(reponse.body);
          envoi = lecture.ok
            ? {
                code: 'succes',
                id: lecture.id,
                open_obligations: lecture.open_obligations,
                status: reponse.status,
              }
            : { code: lecture.kind, open_obligations: [], status: reponse.status };
        }
        if (creation) {
          if (!reponse.ok) envoi.message = messageCreation(envoi.code, envoi.status);
          if (!reponse.ok && creationIncertaine(envoi.code)) {
            deps.cartes!.incertain(mesh, ligne!);
            reserve = false;
            const relu = await deps.cartes!.relire(mesh, ligne!);
            envoi.relecture = !relu.ok
              ? 'echec'
              : relu.attente
                ? 'attente'
                : relu.id === null
                  ? 'absente'
                  : 'trouvee';
            envoi.enVol = !relu.ok || !!relu.attente;
            if (relu.ok && relu.id !== null) {
              envoi.code = 'succes';
              envoi.id = relu.id;
            }
          } else {
            // Toute réponse 2xx est certaine, même si son id est illisible.
            deps.cartes!.effacer(mesh, ligne!);
            reserve = false;
            envoi.cree = reponse.ok;
            envoi.enVol = false;
          }
        }
        ctx.envoi = envoi;
        const params = ecriture.params;
        deps.journal?.('mesh.ecrire', {
          action: ecriture.action,
          request_id,
          code: envoi.code,
          ...('projet' in params
            ? { projet: String(params.projet) }
            : 'carte' in params
              ? { carte: String(params.carte) }
              : 'pair' in params
                ? { pair: params.pair }
                : { canal: params.canal }),
        });
      } catch (erreur) {
        if (reserve) {
          if (!envoye) deps.cartes!.effacer(mesh, ligne!);
          else {
            deps.cartes!.incertain(mesh, ligne!);
            await deps.cartes!.relire(mesh, ligne!).catch(() => {
              deps.journal?.('mesh.ecrire', { action: 'carte.creer', code: 'relecture_echec' });
            });
          }
        }
        throw erreur;
      }
    },
  };
}
