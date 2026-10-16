import { useState } from 'react';
import { AidApiError } from '../data/api.js';
import { useAid } from '../data/useAidState.js';

export type Nettoyage =
  | { phase: 'repos' }
  | { phase: 'en-cours' }
  | { phase: 'confirmer'; commits: number }
  | { phase: 'refuse'; message: string };

// Un nettoyage peut être refusé pour du travail non commité (rien à faire que le dire) ou pour des commits
// non fusionnés (l'humain peut confirmer en répétant leur nombre exact).
export function useNettoyage(topicId: string) {
  const { state, outputs, call } = useAid();
  const [actionId, setActionId] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const action = state?.actions.find((a) => a.id === actionId);

  let phase: Nettoyage = { phase: 'repos' };
  if (failure) phase = { phase: 'refuse', message: failure };
  else if (requesting || (actionId && (!action || action.state === 'running')))
    phase = { phase: 'en-cours' };
  else if (action && action.state !== 'succeeded') {
    const commits = action.result?.unmergedCommits;
    if (action.state === 'needs_human' && typeof commits === 'number')
      phase = { phase: 'confirmer', commits };
    else {
      const last = (actionId ? outputs[actionId] : undefined)?.at(-1)?.line;
      phase = {
        phase: 'refuse',
        message:
          last ??
          (action.state === 'needs_human' ? 'Action humaine requise.' : 'Le nettoyage a échoué.'),
      };
    }
  }

  async function start(confirmUnmerged?: number) {
    setFailure(null);
    setActionId(null);
    setRequesting(true);
    try {
      const r = await call<{ actionId: string }>(
        'POST',
        `/api/topics/${topicId}/actions/topic.cleanup`,
        {
          ...(confirmUnmerged !== undefined && { confirmUnmerged }),
        },
      );
      setActionId(r.actionId);
    } catch (err) {
      setFailure(err instanceof AidApiError ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  }

  return {
    phase,
    start,
    reset: () => {
      setActionId(null);
      setFailure(null);
    },
  };
}
