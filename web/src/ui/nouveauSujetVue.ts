// Chantier 28 : les règles de l'écran Nouveau sujet, sans rendu (D144, D145).

export type AgentCree = 'claude' | 'codex';

const FOURNISSEUR: Record<AgentCree, string> = { claude: 'Anthropic', codex: 'OpenAI' };

/** D144 : où vont les données. Rien sans agent : aucun modèle ne tourne. */
export function phraseDonnees(agent: AgentCree | null): string | null {
  if (!agent) return null;
  return `Le modèle tourne chez ${FOURNISSEUR[agent]}. Les outils et les fichiers restent sur ce Mac.`;
}

export const fournisseur = (agent: AgentCree): string => FOURNISSEUR[agent];

export interface Verification {
  etat: 'ok' | 'info' | 'ko';
  texte: string;
}

/**
 * D144 : « Vérifié à l'instant ». `disponible` est la lecture du daemon pour l'agent choisi (absente tant
 * qu'elle n'est pas revenue) ; `baseEnRetard` vaut null quand `origin/<base>` est inconnu.
 */
export function verifications(p: {
  agent: AgentCree | null;
  disponible?: { trouve: boolean; version: string | null };
  base: string;
  baseEnRetard: number | null;
}): Verification[] {
  const out: Verification[] = [];
  if (p.agent && p.disponible) {
    out.push(
      p.disponible.trouve
        ? {
            etat: 'ok',
            texte: p.disponible.version
              ? `${p.agent} détecté, version ${p.disponible.version}`
              : `${p.agent} détecté`,
          }
        : { etat: 'ko', texte: `${p.agent} introuvable dans le PATH du daemon` },
    );
  }
  if (p.baseEnRetard !== null && p.baseEnRetard > 0) {
    out.push({
      etat: 'info',
      texte: `${p.base} en retard de ${p.baseEnRetard} commit${p.baseEnRetard > 1 ? 's' : ''} sur origin/${p.base}`,
    });
  }
  return out;
}

/** D145 : le message envoyé à l'agent après la création, pour qu'il établisse le plan sans rien écrire. */
export function messagePlan(p: { titre: string; page: string }): string {
  return [
    `Nouveau sujet : « ${p.titre} ».`,
    'Établis le plan en suivant le rôle plan du noyau : intention en une phrase, rayon d’impact tiré de l’index structurel, options écartées et leur raison, ce qui reste incertain.',
    `Écris-le dans la page mémoire ${p.page}.`,
    'Ne modifie aucun fichier et ne fais aucun commit.',
  ].join('\n');
}
