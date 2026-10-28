import { useState } from 'react';
import { useAid } from '../data/useAidState.js';
import { isAlive } from '../ui/Statut.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Pause/reprise d'un agent PTY depuis l'écran Sujet (seule action de CarteSujet sans équivalent ici, D56). */
export function PiedPause({ agentId }: { agentId: string }) {
  const { state, call } = useAid();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const agent = state?.agents.find((a) => a.id === agentId);
  if (!agent || !isAlive(agent)) return null;
  const pause = async () => {
    setErreur(null);
    setBusy(true);
    try {
      await call('POST', `/api/agents/${agent.id}/${agent.pausedAt ? 'resume' : 'pause'}`);
    } catch (err) {
      setErreur(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="bouton bouton--fantome"
        data-node="1-3.terminaux.pied.pause"
        data-action={agent.pausedAt ? 'run.reprendre' : 'run.pause'}
        type="button"
        disabled={busy}
        onClick={() => void pause()}
      >
        {agent.pausedAt ? 'Reprendre' : 'Pause'}
      </button>
      {erreur && (
        <span className="texte-faible" role="alert" data-node="1-3.terminaux.pied.erreur">
          {erreur}
        </span>
      )}
    </>
  );
}
