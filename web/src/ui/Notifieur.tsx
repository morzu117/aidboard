import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import type { Agent } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';

const TITRE = 'A-I-D';

/** Une demande ne se notifie qu'une fois : son id, ou à défaut le moment où l'agent s'est mis à attendre. */
const cle = (a: Agent) => a.pending?.id ?? `${a.id}@${a.statusAt ?? ''}`;

/**
 * Le titre de l'onglet compte les agents qui attendent ; une notification du navigateur signale chaque
 * nouvelle demande quand l'onglet est caché (06.11). Monté une fois, au-dessus des écrans.
 */
export function Notifieur() {
  const { state } = useAid();
  const navigate = useNavigate();
  const vues = useRef<Set<string> | null>(null);

  const attente = state?.agents.filter((a) => a.status === 'needs_input' && !a.pausedAt) ?? [];
  useEffect(() => {
    document.title = attente.length > 0 ? `(${attente.length}) ${TITRE}` : TITRE;
  }, [attente.length]);

  useEffect(() => {
    if (!state) return;
    // au premier instantané, ce qui attend déjà n'est pas nouveau : pas de rafale au rechargement
    const premier = vues.current === null;
    const seen = (vues.current ??= new Set());
    for (const a of attente) {
      const k = cle(a);
      if (seen.has(k)) continue;
      seen.add(k);
      if (premier || document.visibilityState !== 'hidden') continue;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') continue;
      const topicId = state.runs.find((r) => r.id === a.runId)?.topicId;
      const n = new Notification(`${a.kind} attend ta réponse`, {
        body: a.pending?.question ?? a.statusMessage ?? '',
        tag: k,
      });
      n.onclick = () => {
        window.focus();
        if (topicId) navigate(`/sujets/${topicId}?agent=${a.id}`);
        n.close();
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return null;
}
