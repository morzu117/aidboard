import type { GitTransfert } from '../../../src/shared/git.js';

// Chantier 28 : les règles du dialogue Reprendre, sans rendu (D146, D147, D149).

export type OptionReprise = 'reconnecter' | 'reprendre' | 'transferer';

/** Ce que la sonde dit d'un agent de serveur (D148) ; null tant qu'elle n'est pas revenue. */
export type Processus = 'vivant' | 'arrete' | 'injoignable';

export type CibleReprise =
  | {
      lieu: 'local';
      kind: string;
      /** claude ou codex en `stream` : il repart sous le même id (`isResumable`) */
      reprenable: boolean;
      session: boolean;
      /** sujet actif, avec son worktree */
      sujetOuvert: boolean;
    }
  | {
      lieu: 'serveur';
      kind: string;
      session: boolean;
      suivi?: 'coupe' | 'echec';
      processus: Processus | null;
    };

export interface Disponibilite {
  possible: boolean;
  raison?: string;
}

export interface OptionsReprise {
  reconnecter: Disponibilite;
  reprendre: Disponibilite;
  transferer: Disponibilite;
  /** l'option cochée à l'ouverture, null si aucune n'est possible */
  defaut: OptionReprise | null;
}

const oui: Disponibilite = { possible: true };
const non = (raison: string): Disponibilite => ({ possible: false, raison });

/**
 * D147. Une coupure de suivi ne relance jamais une tâche active : tant que la sonde dit le processus vivant,
 * seul Reconnecter est possible. Sans réponse de la sonde, rien n'est possible encore.
 */
export function optionsReprise(c: CibleReprise): OptionsReprise {
  if (c.lieu === 'local') {
    const reprendre = !c.reprenable
      ? non('Cet agent ne se reprend pas : il est mort avec son terminal.')
      : !c.session
        ? non('Aucune session à reprendre : cet agent n’a pas encore eu de tour.')
        : !c.sujetOuvert
          ? non('Le sujet est fermé ou son worktree manque.')
          : oui;
    const transferer = c.sujetOuvert ? oui : non('Le sujet est fermé ou son worktree manque.');
    return {
      reconnecter: non('Un agent local ne perd pas son suivi sans s’arrêter.'),
      reprendre,
      transferer,
      defaut: reprendre.possible ? 'reprendre' : transferer.possible ? 'transferer' : null,
    };
  }
  const transferer = non('Le transfert ne vaut que pour un sujet local.');
  if (c.processus === null) {
    const attente = non('Vérification du processus…');
    return { reconnecter: attente, reprendre: attente, transferer, defaut: null };
  }
  if (c.processus === 'injoignable') {
    const loin = non('Le serveur ne répond pas.');
    return { reconnecter: loin, reprendre: loin, transferer, defaut: null };
  }
  if (c.processus === 'vivant') {
    return {
      reconnecter: oui,
      reprendre: non('Le processus répond : le relancer couperait son tour.'),
      transferer,
      defaut: 'reconnecter',
    };
  }
  const reprendre = c.session ? oui : non('Aucune session à reprendre.');
  return {
    reconnecter: non('Le processus est arrêté : rien à rattacher.'),
    reprendre,
    transferer,
    defaut: reprendre.possible ? 'reprendre' : null,
  };
}

/** D146 : le constat, avant « Que veux-tu retrouver ? ». */
export function titreReprise(c: CibleReprise): string {
  if (c.lieu === 'serveur' && c.suivi === 'coupe') return `Le suivi de ${c.kind} est coupé.`;
  if (c.lieu === 'serveur' && c.suivi === 'echec') return `La session de ${c.kind} est perdue.`;
  return `${c.kind} est arrêté.`;
}

export const LIBELLE: Record<OptionReprise, string> = {
  reconnecter: 'Reconnecter le processus',
  reprendre: 'Reprendre la session',
  transferer: 'Transférer à un autre agent',
};

export const REVIENT: Record<OptionReprise, { revient: string; neRevientPas: string }> = {
  reconnecter: {
    revient: 'Le même processus, son tour en cours, le fil depuis la coupure.',
    neRevientPas: 'Rien n’est perdu.',
  },
  reprendre: {
    revient: 'La conversation de la session.',
    neRevientPas: 'Le tour interrompu : ses commandes sont à rejouer.',
  },
  transferer: {
    revient: 'Ce que git établit : branche, commits, fichiers ; les pages plan et passation.',
    neRevientPas: 'La conversation brute et ce que l’agent savait sans l’écrire.',
  },
};

/** Le libellé du bouton principal, qui suit le choix. */
export function boutonReprise(o: OptionReprise, versAgent?: string): string {
  if (o === 'reconnecter') return 'Reconnecter';
  if (o === 'reprendre') return 'Reprendre la session';
  return versAgent ? `Transférer à ${versAgent}` : 'Transférer';
}

/** Ce que lit `GET /api/topics/:id/git/transfert` (D148). */
export type { GitTransfert };

/** D149 : l'alerte, seulement avec Transférer. Rien n'y est bloquant. */
export function alerteTransfert(g: Pick<GitTransfert, 'nonPousses' | 'dirty'>): {
  nonPousses: string | null;
  nonCommites: string | null;
} {
  return {
    nonPousses:
      g.nonPousses > 0
        ? `${g.nonPousses} commit${g.nonPousses > 1 ? 's' : ''} non poussé${g.nonPousses > 1 ? 's' : ''}.`
        : null,
    nonCommites: g.dirty
      ? 'Des fichiers ne sont pas commités : le nouvel agent les verra, sans leur raison.'
      : null,
  };
}

/** D149 : le message du nouvel agent. Il repart de ce que git et les pages établissent, pas de la conversation. */
export function messageTransfert(p: {
  ancien: string;
  git: GitTransfert;
  pages: string[];
}): string {
  const { git } = p;
  const lignes = [
    `Tu reprends ce sujet après ${p.ancien}. La conversation de l’agent précédent ne te suit pas.`,
    `Branche ${git.branche}, base ${git.base}.`,
  ];
  if (git.commits.length > 0) {
    lignes.push(`Commits depuis ${git.base} :`, ...git.commits.map((c) => `- ${c}`));
  } else lignes.push(`Aucun commit depuis ${git.base}.`);
  if (git.dirty) lignes.push('Des fichiers ne sont pas commités : regarde git status.');
  if (p.pages.length > 0) lignes.push(`Lis d’abord les pages mémoire : ${p.pages.join(', ')}.`);
  lignes.push('Dis ce que tu comprends de l’état du travail avant de modifier quoi que ce soit.');
  return lignes.join('\n');
}
