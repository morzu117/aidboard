import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { packageRoot } from '../../cli/version.js';
import { git } from '../git/exec.js';

type GenreAgent = 'claude' | 'codex';
export type RoleEtape = 'plan' | 'acceptation' | 'dev' | 'review';

type Delais = Record<'plan' | 'acceptation' | 'dev' | 'gate' | 'revue', number>;

export interface ReglagesBoucle {
  phases: string[];
  gate?: string;
  redevCap: number;
  genres: Record<RoleEtape, GenreAgent>;
  delais: Delais;
}

interface Manifeste {
  phases?: string[];
  gates?: { gate?: string };
  guardrails?: { redev_cap?: number };
  capabilities?: { dev_agent?: unknown; review_agent?: unknown };
  boucle?: { delais?: Partial<Delais> };
}

function genre(capacite: string, valeur: unknown): GenreAgent {
  if (typeof valeur === 'string') {
    if (/^claude(?:-|$)/.test(valeur)) return 'claude';
    if (/^codex(?:-|$)/.test(valeur)) return 'codex';
  }
  const erreur = new Error(`${capacite} : genre inconnu (${String(valeur)})`);
  erreur.name = 'GenreAgentInconnu';
  throw erreur;
}

export async function lireReglagesBoucle(
  depot: string,
  commit: string,
  revueParDefaut?: GenreAgent,
): Promise<ReglagesBoucle> {
  const resultat = await git(depot, ['show', '--end-of-options', `${commit}:agent.yml`]);
  if (!resultat.ok) {
    throw new Error(`Impossible de lire agent.yml au commit du GO : ${resultat.stderr}`);
  }

  const projet = (parse(resultat.stdout) as Manifeste | null) ?? {};
  const defauts = parse(await readFile(join(packageRoot(), 'kernel/defaults.yml'), 'utf8')) as {
    phases: string[];
    guardrails: { redev_cap: number };
    capabilities: { dev_agent: string; review_agent: string };
    boucle: { delais: Delais };
  };
  const capacites = { ...defauts.capabilities, ...projet.capabilities };
  const dev = genre('dev_agent', capacites.dev_agent);

  return {
    phases: projet.phases ?? defauts.phases,
    gate: projet.gates?.gate,
    redevCap: projet.guardrails?.redev_cap ?? defauts.guardrails.redev_cap,
    genres: {
      plan: dev,
      acceptation: dev,
      dev,
      review: genre(
        'review_agent',
        projet.capabilities?.review_agent ?? revueParDefaut ?? capacites.review_agent,
      ),
    },
    delais: { ...defauts.boucle.delais, ...projet.boucle?.delais },
  };
}
