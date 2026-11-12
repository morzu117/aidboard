import { RefusCommittee } from '../mesh/committee.js';
import type { AvisMeshService } from '../mesh/avis.js';
import { AidHttpError } from '../errors.js';
import type { Action } from './porte.js';
import type { ParametresAvisMesh, ConfirmationMotionAvis } from '../../shared/avis-mesh-api.js';

export function creerActionsAvis(avis?: AvisMeshService): {
  'mesh.avis': Action<'mesh.avis'>;
  'mesh.avis.motion': Action<'mesh.avis.motion'>;
  'mesh.avis.baseline-absent': Action<'mesh.avis.baseline-absent'>;
} {
  const service = () => {
    if (!avis) throw new AidHttpError(404, 'mesh désactivé');
    return avis;
  };
  return {
    'mesh.avis': {
      async preparer(entree) {
        const p = service().verifier(entree.params as ParametresAvisMesh);
        // Le texte exact et tous les choix sont signés, sans dupliquer question et charter.
        return {
          params: {
            id: p.id,
            nom: p.nom,
            sieges: p.sieges,
            carte: p.carte,
            echeances: p.echeances,
            texte: p.texte,
          },
        };
      },
      async executer(p, ctx) {
        if (!ctx.confirmation) throw new AidHttpError(409, 'confirmation_requise');
        try {
          await service().ouvrir(service().verifier(p.params));
        } catch (e) {
          if (e instanceof RefusCommittee) {
            ctx.envoi = {
              code: 'upstream_error',
              status: e.status,
              detail: e.message,
              open_obligations: [],
            };
            return;
          }
          throw e;
        }
      },
    },
    'mesh.avis.motion': {
      async preparer(entree) {
        const p = entree.params as ConfirmationMotionAvis;
        return { params: service().preparerMotion(p.id, p.echeances) };
      },
      async executer(p, ctx) {
        if (!ctx.confirmation) throw new AidHttpError(409, 'confirmation_requise');
        try {
          await service().reprendreMotion(p.params);
        } catch (e) {
          if (e instanceof RefusCommittee) {
            ctx.envoi = {
              code: 'upstream_error',
              status: e.status,
              detail: e.message,
              open_obligations: [],
            };
            return;
          }
          throw e;
        }
      },
    },
    'mesh.avis.baseline-absent': {
      async preparer(entree) {
        return { params: await service().verifierAbsence((entree.params as { id: string }).id) };
      },
      async executer(p, ctx) {
        if (!ctx.confirmation) throw new AidHttpError(409, 'confirmation_requise');
        try {
          await service().declarerAbsent(p.params.id);
        } catch (e) {
          if (e instanceof RefusCommittee) {
            ctx.envoi = {
              code: 'upstream_error',
              status: e.status,
              detail: e.message,
              open_obligations: [],
            };
            return;
          }
          throw e;
        }
      },
    },
  };
}
