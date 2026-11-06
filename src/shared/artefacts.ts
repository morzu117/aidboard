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
  /** ISO 8601 */
  expireA: string;
}
