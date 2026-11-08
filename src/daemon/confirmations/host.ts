import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { jsonCanonique } from '../../shared/pda.js';
import type { ParametresActions } from '../../shared/confirmations.js';
import {
  ConfigError,
  ecrireModeHostCode,
  ecrireModeHostPush,
  parseConfig,
  type AidConfig,
} from '../config.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import type { ModeHost } from '../host/controleur.js';
import type { AidPaths } from '../paths.js';
import { RegistrePda } from '../pda/registre.js';
import type { FilePda } from '../pda/file.js';
import { creerReglage } from './reglage.js';
import type { ActionsPorte, EntreeAction } from './porte.js';

export interface DependancesHost {
  db: Db;
  config?: AidConfig;
  paths?: AidPaths;
  modeHost?: ModeHost;
  pda?: { obtenir: () => FilePda | null };
  journal?: (type: string, donnees: Record<string, string>) => void;
}
export function creerActionsHost(
  deps: DependancesHost,
): Pick<ActionsPorte, 'appairage' | 'pda.activer' | 'host.option' | 'desarmement'> {
  const reglage = creerReglage(deps.db);
  const registre = new RegistrePda(deps.db, (type, donnees) => deps.journal?.(type, donnees));
  const appairage = (entree: EntreeAction): ParametresActions['appairage'] => {
    const d = deps.modeHost?.appairages.vueMac();
    if (!d || d.id !== entree.appairageId || d.etat !== 'reclamee' || d.nom === null)
      throw new AidHttpError(404, 'demande inconnue, expirée ou annulée');
    if (d.identite === null && entree.sansIdentite !== true)
      throw new AidHttpError(409, 'identite-absente', {
        message: 'Aucune identité Tailscale : cocher « Appareil taggé, sans identité Tailscale »',
      });
    return {
      appairageId: d.id,
      nom: d.nom,
      hIdentite:
        d.identite === null
          ? null
          : createHash('sha256').update(d.identite, 'utf8').digest('base64url'),
      sansIdentite: entree.sansIdentite === true,
    };
  };
  const appareil = async (entree: EntreeAction) => {
    const d = (await registre.lister()).find((a) => a.id === entree.appareilId);
    if (!d || d.etat !== 'attente' || d.empreinte !== entree.empreinte)
      throw new AidHttpError(409, 'etat');
    return { appareilId: d.id, nom: d.nom, empreinte: d.empreinte };
  };
  return {
    appairage: {
      async preparer(entree) {
        return appairage(entree);
      },
      async executer(params) {
        deps.db.transaction(() => {
          try {
            if (jsonCanonique(appairage(params)) !== jsonCanonique(params))
              throw new AidHttpError(409, 'perime');
          } catch {
            throw new AidHttpError(409, 'perime');
          }
          if (!deps.modeHost!.appairages.approuver(params.appairageId, params).ok)
            throw new AidHttpError(409, 'perime');
        })();
      },
    },
    'pda.activer': {
      async preparer(entree) {
        return appareil(entree);
      },
      async executer(params, ctx) {
        // Le calcul cryptographique est asynchrone ; les clés relues sont ensuite
        // comparées dans la transaction qui active, sans fenêtre d'écriture.
        const lire = () =>
          deps.db.prepare('SELECT * FROM pda_appareils WHERE id = ?').get(params.appareilId);
        const avant = jsonCanonique(lire());
        const relus = await appareil(params);
        deps.db.transaction(() => {
          if (
            jsonCanonique(lire()) !== avant ||
            jsonCanonique(relus) !== jsonCanonique(params) ||
            !registre.activer(params.appareilId)
          )
            throw new AidHttpError(409, 'perime');
          if (ctx.amorcage) reglage.armer();
        })();
        if (ctx.amorcage) deps.journal?.('pda.amorcage', { appareil: params.appareilId });
        if (!ctx.confirmation) await deps.pda?.obtenir()?.publierAutorises();
      },
    },
    'host.option': {
      async preparer(entree) {
        if (!['code', 'push'].includes(entree.option ?? '') || entree.actif !== true)
          throw new AidHttpError(400, 'option invalide');
        // Même validation que l'écriture historique, sans modifier la configuration.
        const doc = parseDocument(
          existsSync(deps.paths!.config) ? readFileSync(deps.paths!.config, 'utf8') : '',
        );
        try {
          if (doc.errors.length) throw new ConfigError("config.yaml illisible : rien n'est écrit");
          try {
            doc.setIn(['modeHost', entree.option!], true);
          } catch {
            throw new ConfigError('config.yaml : modeHost doit être un objet');
          }
          parseConfig(doc.toString());
        } catch (e) {
          if (e instanceof ConfigError) throw new AidHttpError(409, e.message);
          throw e;
        }
        return { option: entree.option!, actif: true };
      },
      async executer(params) {
        if (!params.actif) throw new AidHttpError(409, 'perime');
        deps.db.transaction(() => {
          try {
            if (params.option === 'push') {
              deps.modeHost?.fournisseurPush?.obtenir();
              ecrireModeHostPush(deps.paths!, true);
            } else ecrireModeHostCode(deps.paths!, true);
          } catch (e) {
            if (e instanceof ConfigError) throw new AidHttpError(409, e.message);
            throw e;
          }
          deps.config!.modeHost[params.option] = true;
        })();
      },
    },
    desarmement: {
      async preparer() {
        if (!reglage.arme()) throw new AidHttpError(409, 'confirmations non armées');
        return {};
      },
      async executer() {
        deps.db.transaction(() => {
          if (!reglage.arme()) throw new AidHttpError(409, 'perime');
          reglage.desarmerConfirme();
        })();
        deps.journal?.('pda.desarmement', {});
      },
    },
  };
}
