import { useState } from 'react';
import type { PendingRequest } from '../../../src/shared/model.js';
import type { AidApi } from '../data/useAidState.js';
import { useAid } from '../data/useAidState.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** La route de réponse à une décision, partagée avec le bandeau de décisions de l'Accueil (D56, point 4). */
export async function answerPending(
  call: AidApi['call'],
  agentId: string,
  pendingId: string,
  answer: string,
): Promise<void> {
  await call('POST', `/api/agents/${agentId}/answer`, { pendingId, answer });
}

export function DecisionCard({
  agentId,
  request,
  resolved,
  dataNode,
}: {
  agentId: string;
  request: PendingRequest;
  resolved: boolean;
  dataNode: string;
}) {
  const { call } = useAid();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [reponse, setReponse] = useState<string | null>(null);

  const repondre = async (answer: string, label: string) => {
    setBusy(true);
    setErreur(null);
    try {
      await answerPending(call, agentId, request.id, answer);
      setReponse(label);
    } catch (err) {
      setErreur(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`decision-carte${resolved ? ' decision-carte--resolue' : ''}`}
      data-node={dataNode}
      role="group"
      aria-label="Décision"
    >
      <p className="decision-question" data-node={`${dataNode}.question`}>
        {request.question}
      </p>
      {!resolved ? (
        <div className="decision-options">
          {request.options.map((o, i) => (
            <button
              key={o.answer}
              className={`bouton${i === 0 ? ' bouton--primaire' : ''}`}
              data-node={`${dataNode}.option-${i + 1}`}
              type="button"
              disabled={busy || reponse !== null}
              onClick={() => void repondre(o.answer, o.label)}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="decision-issue" data-node={`${dataNode}.issue`}>
          {reponse ? `Réponse : ${reponse}` : 'Demande close'}
        </p>
      )}
      {erreur && (
        <p className="message-erreur" role="alert" data-node={`${dataNode}.erreur`}>
          {erreur}
        </p>
      )}
    </div>
  );
}
