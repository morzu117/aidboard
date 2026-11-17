import { texteCommandantValide, controlerLigneCommandant } from '../../shared/commandant.js';
import { validerParamsAction, type ParametresActions } from '../../shared/confirmations.js';
import type { ServiceCommandant } from '../commandant/service.js';
import type { ErreurCommandant } from '../commandant/client.js';
import { AidHttpError } from '../errors.js';
import type { Action, ContexteAction } from './porte.js';

type Parametres = ParametresActions['mesh.commandant.repondre'];
function refusPasserelle(ctx: ContexteAction, erreur: ErreurCommandant) {
  ctx.envoi =
    erreur.genre === 'transport'
      ? {
          code: erreur.code === 'delai' ? 'delai' : erreur.code === 'json' ? 'format' : 'connexion',
          open_obligations: [],
        }
      : { code: erreur.code, status: erreur.http, open_obligations: [] };
}
export function creerActionCommandant(
  service?: ServiceCommandant,
): Action<'mesh.commandant.repondre'> {
  const obtenir = () => {
    if (!service) throw new AidHttpError(404, 'commandant_indisponible');
    return service;
  };
  return {
    async preparer(entree, ctx) {
      const p = (entree.params ?? entree) as Partial<Parametres>;
      const mesh = ctx.mesh ?? entree.mesh;
      if (
        !mesh ||
        !Number.isSafeInteger(p.requestId) ||
        p.requestId! < 0 ||
        typeof p.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(p.digest)
      )
        throw new AidHttpError(400, 'commandant_parametres');
      const controle = await obtenir().detail(mesh, p.requestId!);
      if ('erreur' in controle) throw new AidHttpError(409, `commandant_${controle.erreur.code}`);
      if (!controle.valide) throw new AidHttpError(409, `commandant_illisible_${controle.raison}`);
      const { ligne } = controle;
      if (ligne.type !== 'decision') throw new AidHttpError(409, 'commandant_type');
      if (ligne.status !== 'pending') throw new AidHttpError(409, 'commandant_not_pending');
      if (ligne.needs_sso) throw new AidHttpError(409, 'commandant_needs_sso');
      if (!controle.repondable) throw new AidHttpError(409, 'commandant_limites');
      if (ligne.digest !== p.digest) throw new AidHttpError(409, 'commandant_digest_mismatch');
      const options = ligne.params.options as string[];
      if (
        options.length
          ? !options.includes(p.decision!)
          : !texteCommandantValide(p.decision, 1000) || !p.decision.trim()
      )
        throw new AidHttpError(400, 'commandant_bad_answer');
      const params: Parametres = {
        mesh,
        requestId: ligne.id,
        type: 'decision',
        digest: ligne.digest,
        decision: p.decision!,
        question: ligne.params.question as string,
        options: [...options],
      };
      if (!validerParamsAction('mesh.commandant.repondre', params))
        throw new AidHttpError(400, 'commandant_bad_answer');
      return params;
    },
    async executer(p, ctx) {
      if (!ctx.confirmation) throw new AidHttpError(409, 'confirmation_requise');
      if (!validerParamsAction('mesh.commandant.repondre', p) || ctx.mesh !== p.mesh)
        throw new AidHttpError(409, 'perime');
      const controle = await obtenir().detail(p.mesh, p.requestId);
      if ('erreur' in controle) {
        refusPasserelle(ctx, controle.erreur);
        return;
      }
      if (
        !controle.valide ||
        !controle.repondable ||
        controle.ligne.type !== p.type ||
        controle.ligne.status !== 'pending' ||
        controle.ligne.needs_sso ||
        controle.ligne.digest !== p.digest ||
        controle.ligne.params.question !== p.question ||
        JSON.stringify(controle.ligne.params.options) !== JSON.stringify(p.options)
      )
        throw new AidHttpError(409, 'perime');
      const resultat = await obtenir().decider(p.mesh, p.requestId, p.decision, p.digest);
      if (!resultat.ok) {
        refusPasserelle(ctx, resultat.erreur);
        return;
      }
      const ligne = controlerLigneCommandant(resultat.valeur);
      if (
        !ligne.valide ||
        ligne.ligne.id !== p.requestId ||
        ligne.ligne.digest !== p.digest ||
        ligne.ligne.answer !== p.decision ||
        ligne.ligne.status !== 'answered' ||
        ligne.ligne.decided_via !== 'cockpit'
      ) {
        ctx.envoi = { code: 'format', open_obligations: [] };
        return;
      }
      ctx.envoi = { code: 'succes', open_obligations: [] };
    },
  };
}
