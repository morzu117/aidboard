import { REMOTE_CONTROL } from './agentSettings.js';

/**
 * Chantier 29 (D153) : ce qu'une combinaison agent × machine sait faire depuis le cockpit. Seule source des
 * capacités : l'écran Machines la montre, le composer la lit (une capacité absente n'est jamais proposée).
 */
export type Capacite =
  | 'outils'
  | 'images'
  | 'approbations'
  | 'interruption'
  | 'reprise'
  | 'effort'
  | 'distant'
  | 'conso';

export const CAPACITES: ReadonlyArray<{ id: Capacite; label: string }> = [
  { id: 'outils', label: 'Outils' },
  { id: 'images', label: 'Images' },
  { id: 'approbations', label: 'Approbations' },
  { id: 'interruption', label: 'Interruption' },
  { id: 'reprise', label: 'Reprise' },
  { id: 'effort', label: 'Effort' },
  { id: 'distant', label: 'Contrôle distant' },
  { id: 'conso', label: 'Consommation' },
];

/** Où tourne l'agent : un agent de serveur est toujours en `stream`. */
export interface Lieu {
  machine: 'mac' | 'serveur';
  transport: 'stream' | 'pty';
}

/**
 * `efforts` : l'agent annonce des niveaux d'effort (ses options, ou celles d'un de ses modèles). En PTY, l'agent
 * vit dans un terminal : ses outils, ses demandes et Ctrl-C y passent, rien d'autre ne remonte au cockpit.
 */
export function capacitesDe(
  kind: 'claude' | 'codex',
  lieu: Lieu,
  efforts = kind === 'claude',
): Record<Capacite, boolean> {
  const stream = lieu.machine === 'serveur' || lieu.transport === 'stream';
  return {
    outils: true,
    approbations: true,
    interruption: true,
    // R.6 (D70) : une pièce jointe est un fichier du daemon, rien ne part vers un serveur
    images: stream && lieu.machine === 'mac',
    reprise: stream,
    effort: stream && efforts,
    distant: stream && REMOTE_CONTROL[kind],
    // le coût d'un tour n'est affiché nulle part
    conso: false,
  };
}
