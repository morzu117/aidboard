import { createContext, useContext } from 'react';

/** Ce que l'écran Discussion ajoute au fil d'un agent distant (§11.3). */
export interface Distant {
  /** nom du serveur, à côté de l'agent sur chaque tour */
  serveur: string;
  /** serveur injoignable : bandeau au-dessus du composer, composer fermé */
  injoignable: boolean;
  raison?: string | null;
  onReconnecter?: () => Promise<void>;
  /** chaque événement du fil : l'écran relit l'agent (statut, demande en cours) sans attendre sa relecture */
  onEvent?: () => void;
}

/**
 * Chantier 17 (R.6) : où le fil d'un agent lit et écrit. Un agent de sujet par défaut ; un agent distant passe par
 * `/api/server-agents` et `/ws/server-agent`, mêmes formes.
 */
export interface AgentRoutes {
  api: string;
  ws: string;
  distant?: Distant;
}

export const ROUTES_LOCALES: AgentRoutes = { api: '/api/agents', ws: '/ws/agent' };

export const routesDistantes = (distant: Distant): AgentRoutes => ({
  api: '/api/server-agents',
  ws: '/ws/server-agent',
  distant,
});

export const AgentRoutesContext = createContext<AgentRoutes>(ROUTES_LOCALES);

export const useAgentRoutes = (): AgentRoutes => useContext(AgentRoutesContext);
