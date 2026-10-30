import { useCallback, useEffect, useState } from 'react';
import type {
  AgentStatus,
  PendingRequest,
  ServerAgent,
  ServerDiscussion,
} from '../../../src/shared/model.js';
import { useAidClient } from './useAidState.js';

/** Chantier 17 (R.6) : ce que rendent `/api/servers/:id/discussions` et `/api/server-agents/:id`. */
export type ServerAgentView = ServerAgent & { pending: PendingRequest | null };
export type ServerDiscussionView = ServerDiscussion & { agents: ServerAgentView[] };

/** Libellés courts d'un agent distant, pour la table des discussions et l'en-tête (« claude · libre »). */
export const ETAT_AGENT: Record<AgentStatus, string> = {
  starting: 'démarrage',
  working: 'travaille',
  needs_input: 'attend une réponse',
  idle: 'libre',
  done: 'terminé',
  error: 'en erreur',
  stopped: 'arrêté',
};

/** Dernière activité : un message de l'agent date son agent, pas la discussion (renommée seulement). */
export const activite = (d: ServerDiscussionView): string =>
  [d.updatedAt, ...d.agents.map((a) => a.updatedAt)].reduce((x, y) => (y > x ? y : x));

/** La plus récente non archivée, par activité. */
export const derniereDiscussion = (liste: ServerDiscussionView[]): ServerDiscussionView | null =>
  liste
    .filter((d) => !d.archived)
    .reduce<ServerDiscussionView | null>(
      (best, d) => (best === null || activite(d) > activite(best) ? d : best),
      null,
    );

/** Les discussions d'un serveur, lues à l'ouverture ; `recharger` après une création. */
export function useDiscussionsServeur(serverId: string): {
  discussions: ServerDiscussionView[] | null;
  erreur: string | null;
  recharger: () => Promise<void>;
} {
  const client = useAidClient();
  const [discussions, setDiscussions] = useState<ServerDiscussionView[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const recharger = useCallback(async () => {
    try {
      setDiscussions(
        await client.request<ServerDiscussionView[]>('GET', `/api/servers/${serverId}/discussions`),
      );
      setErreur(null);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
    }
  }, [client, serverId]);
  useEffect(() => {
    let actif = true;
    client
      .request<ServerDiscussionView[]>('GET', `/api/servers/${serverId}/discussions`)
      .then((l) => actif && setDiscussions(Array.isArray(l) ? l : []))
      .catch(
        (err: unknown) => actif && setErreur(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      actif = false;
    };
  }, [client, serverId]);
  return { discussions, erreur, recharger };
}
