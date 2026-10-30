import type { Server, ServerState } from '../../../src/shared/model.js';

/** §11.1 : libellé de la pastille d'état. */
export const ETAT_SERVEUR: Record<ServerState, string> = {
  unknown: 'Non contrôlé',
  connecting: 'Connexion…',
  connected: 'Connecté',
  unreachable: 'Injoignable',
  error: 'Erreur',
};

/** §5.2 : trait vert = connecté, ambre = connexion, gris = injoignable ; rouge = erreur (§3). */
export const COULEUR_ETAT_SERVEUR: Record<ServerState, string> = {
  unknown: 'var(--s-inactif)',
  connecting: 'var(--s-attente)',
  connected: 'var(--acc)',
  unreachable: 'var(--s-inactif)',
  error: 'var(--s-erreur)',
};

export const MODE_SERVEUR: Record<Server['mode'], string> = {
  ssh_alias: 'alias ssh',
  ssh_host: 'hôte ssh',
  command: 'commande locale',
};

/** Deux baies empilées (maquettes Servers, Nav) ; le trait porte l'état. */
export function IconeServeur({ state, taille = 22 }: { state: ServerState; taille?: number }) {
  return (
    <svg
      className="icone-serveur"
      width={taille}
      height={taille}
      viewBox="0 0 24 24"
      fill="none"
      stroke={COULEUR_ETAT_SERVEUR[state]}
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}

export function PastilleEtatServeur({
  state,
  dataNode,
}: {
  state: ServerState;
  dataNode?: string;
}) {
  return (
    <span
      className={`pastille-serveur pastille-serveur--${state}`}
      data-node={dataNode}
      data-etat={state}
    >
      <span className="pastille-serveur-point" aria-hidden="true" />
      {ETAT_SERVEUR[state]}
    </span>
  );
}
