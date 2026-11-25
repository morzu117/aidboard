import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { racineDepot, verifierAcceptation } from '../../acceptation/verifier.js';

async function lireChemins(depot: string): Promise<string[]> {
  let contenu: string;
  try {
    contenu = await readFile(join(depot, 'agent.yml'), 'utf8');
  } catch (erreur) {
    if ((erreur as NodeJS.ErrnoException).code === 'ENOENT') return ['test/', 'e2e/'];
    throw erreur;
  }
  const manifeste = parse(contenu) as { acceptation?: { chemins?: unknown } } | null;
  const chemins = manifeste?.acceptation?.chemins;
  if (chemins === undefined) return ['test/', 'e2e/'];
  if (!Array.isArray(chemins) || !chemins.every((chemin) => typeof chemin === 'string' && chemin)) {
    throw new Error('acceptation.chemins doit contenir une liste de chemins');
  }
  return chemins;
}

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
    if (commande === 'preuve' || commande === 'couverture') {
      throw new Error(`acceptation ${commande} n’est pas encore disponible`);
    }
    if (commande !== 'verifier') throw new Error('Sous-commande d’acceptation inconnue');

    const { values } = parseArgs({
      args: options,
      options: { base: { type: 'string' }, json: { type: 'boolean' } },
    });
    if (!values.base) throw new Error('L’option --base est obligatoire');

    const depot = await racineDepot(opts?.cwd ?? process.cwd());
    const chemins = await lireChemins(depot);
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
