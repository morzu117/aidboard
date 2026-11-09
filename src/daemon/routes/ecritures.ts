import type { FastifyInstance } from 'fastify';
import { argvEcriture, lireParamsEcriture, resumeEcriture } from '../../shared/ecritures.js';
import { nettoyer } from '../../shared/nettoyage.js';
import { AidHttpError } from '../errors.js';
import type { BoardReader } from '../mesh/board.js';

export function registerEcrituresRoutes(
  app: FastifyInstance,
  deps: { board: BoardReader | null; cell: string; hotesPrives?: string[] },
): void {
  app.post('/api/swarph/ecrire/apercu', async (req) => {
    if (!deps.cell || !deps.board)
      throw new AidHttpError(404, 'mesh désactivé : `mesh.cell` vide dans config.yaml');
    const corps = req.body as { action?: unknown; params?: unknown } | null;
    const action = corps?.action;
    if (action !== 'carte.note' && action !== 'dm.envoyer' && action !== 'canal.poster')
      throw new AidHttpError(400, 'action inconnue');
    const lecture = lireParamsEcriture(action, corps?.params, deps.cell);
    if (!lecture.ok) return { ok: false, kind: 'schema', message: lecture.message };
    const params = lecture.params;
    const nettoyage = nettoyer(params.texte, { hotesPrives: deps.hotesPrives ?? [] });
    if (!nettoyage.ok)
      return {
        ok: false,
        kind: 'nettoyage',
        message:
          nettoyage.classe +
          (action === 'canal.poster' ? ' Ce post serait lu par tous les membres du canal.' : ''),
      };
    let rappel: { obligations: number[] } | { indisponible: true } | null = null;
    if (action === 'carte.note' && 'carte' in params) {
      try {
        const resultat = await deps.board.obligations(params.carte);
        if (!resultat.ok) rappel = { indisponible: true };
        else {
          const ids = resultat.data.obligations
            .filter((o) => o.status === 'open' && o.holder === deps.cell)
            .map((o) => o.id);
          if (ids.length) rappel = { obligations: ids };
        }
      } catch {
        rappel = { indisponible: true };
      }
    }
    return {
      ok: true,
      aBlanc: true,
      argv: argvEcriture(action, params, deps.cell),
      resume: resumeEcriture(action, params),
      texte: params.texte,
      rappel,
    };
  });
}
