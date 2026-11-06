// Chantier 30 : les formes échangées entre le daemon et l'onglet Artefacts.

/** L'état du second port d'écoute (D162). */
export interface EtatArtefacts {
  disponible: boolean;
  port: number | null;
  /** quand il est indisponible : pourquoi (port occupé, réservé) */
  raison?: string;
}

/** Un lien vers le second port (D163) : valable 10 minutes, réutilisable dans la fenêtre. */
export interface LienArtefact {
  url: string;
  /** 30.9 : l'enveloppe de « Ouvrir à part » (le cadre seul, sur le même port) */
  aPart: string;
  /** ISO 8601 */
  expireA: string;
}

/** Un artefact de la liste (D161) : un fichier du worktree, modifié ou ajouté par le sujet. */
export interface Artefact {
  path: string;
  name: string;
  type: 'html' | 'md' | 'svg';
  /** A ajouté, M modifié, U non suivi (lettres de l'onglet Fichiers) */
  status: 'A' | 'M' | 'U' | 'R';
  /** ISO 8601, heure de modification du fichier */
  modifieA: string;
}

export interface ArtefactsResponse {
  artefacts: Artefact[];
  etat: EtatArtefacts;
}
