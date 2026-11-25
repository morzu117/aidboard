import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { mesurerCouverture } from '../../acceptation/couverture.js';
import { produirePreuves } from '../../acceptation/preuve.js';
import { racineDepot, verifierAcceptation } from '../../acceptation/verifier.js';

export async function lireManifesteAcceptation(depot: string) {
  let contenu: string;
  try {
    contenu = await readFile(join(depot, 'agent.yml'), 'utf8');
  } catch (erreur) {
    if ((erreur as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw erreur;
  }
  return parse(contenu) as {
    phases?: unknown;
    acceptation?: { chemins?: unknown; lancer?: unknown };
  } | null;
}

export function lireChemins(chemins: unknown): string[] {
  if (chemins === undefined) return ['test/', 'e2e/'];
  if (!Array.isArray(chemins) || !chemins.every((chemin) => typeof chemin === 'string' && chemin)) {
    throw new Error('acceptation.chemins doit contenir une liste de chemins');
  }
  return chemins;
}

export function lireLanceurs(lancer: unknown): Record<string, string> {
  if (lancer === undefined) return {};
  if (
    typeof lancer !== 'object' ||
    lancer === null ||
    Array.isArray(lancer) ||
    !Object.entries(lancer).every(
      ([chemin, commande]) => chemin && typeof commande === 'string' && commande.trim(),
    )
  ) {
    throw new Error('acceptation.lancer doit associer des chemins à des commandes');
  }
  return lancer as Record<string, string>;
}

const resultats = { pass: 'réussi', fail: 'échec', cannot_evaluate: 'non évaluable' };

const raisons = {
  hors_chemins: 'fichier hors des chemins d’acceptation',
  modifie_par_dev: 'fichier modifié par le dev',
  renomme_par_dev: 'fichier renommé par le dev',
  supprime_par_dev: 'fichier supprimé par le dev',
};

export async function runAcceptation(
  args: string[],
  opts?: { cwd?: string; out?: (ligne: string) => void; err?: (ligne: string) => void },
): Promise<number> {
  const out = opts?.out ?? console.log;
  const err = opts?.err ?? console.error;

  try {
    const [commande, ...options] = args;
    if (commande === 'couverture') {
      const { values } = parseArgs({
        args: options,
        options: { base: { type: 'string' }, plan: { type: 'string' }, json: { type: 'boolean' } },
      });
      if (!values.base) throw new Error('L’option --base est obligatoire');
      if (!values.plan) throw new Error('L’option --plan est obligatoire pour couverture');

      const cwd = opts?.cwd ?? process.cwd();
      const depot = await racineDepot(cwd);
      const rapport = await mesurerCouverture({
        depot,
        base: values.base,
        plan: resolve(cwd, values.plan),
      });
      if (values.json) {
        out(JSON.stringify(rapport));
      } else {
        for (const { point, etat, raison } of rapport.points) {
          const detail = etat === 'non_testable' ? `non testable à l’avance : ${raison}` : etat;
          out(`Point ${point} — ${detail}`);
        }
      }
      return rapport.manquants === 0 ? 0 : 1;
    }
    if (commande !== 'verifier' && commande !== 'preuve') {
      throw new Error('Sous-commande d’acceptation inconnue');
    }

    const { values } = parseArgs({
      args: options,
      options: { base: { type: 'string' }, json: { type: 'boolean' } },
    });
    if (!values.base) throw new Error('L’option --base est obligatoire');

    const depot = await racineDepot(opts?.cwd ?? process.cwd());
    const acceptation = (await lireManifesteAcceptation(depot))?.acceptation;
    const chemins = lireChemins(acceptation?.chemins);
    if (commande === 'preuve') {
      const lancer = lireLanceurs(acceptation?.lancer);
      const rapports = await produirePreuves({ depot, base: values.base, chemins, lancer });
      if (values.json) {
        out(JSON.stringify({ preuves: rapports.map(({ preuve }) => preuve) }));
      } else {
        for (const { point, preuve, fautes } of rapports) {
          const fichiers = [...fautes, ...preuve.not_checked];
          const detail = fichiers.length ? ` — ${fichiers.join(', ')}` : '';
          out(`Point ${point} — ${resultats[preuve.outcome]}${detail}`);
        }
      }
      return rapports.every(({ preuve }) => preuve.outcome === 'pass') ? 0 : 1;
    }
    const rapport = await verifierAcceptation({ depot, base: values.base, chemins });
    if (values.json) {
      out(JSON.stringify(rapport));
    } else if (rapport.ok) {
      for (const [point, detail] of Object.entries(rapport.points)) {
        out(`Point ${point} vérifié (${detail.fichiers.length} fichier(s))`);
      }
    } else {
      for (const { commit, fichier, raison } of rapport.fautes) {
        out(`${commit} ${fichier} — ${raisons[raison]}`);
      }
    }
    return rapport.ok ? 0 : 1;
  } catch (erreur) {
    err(erreur instanceof Error ? erreur.message : String(erreur));
    return 2;
  }
}
