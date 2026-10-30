import { useState } from 'react';
import type { PendingOption, PendingRequest } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Ce que le fil sait de la demande : en attente, répondue (par l'opérateur ou par une règle), ou close sans réponse. */
export type ConfirmResolution =
  { answer: PendingOption['answer']; auto?: boolean } | { cancelled: true } | null;

function issue(r: Exclude<ConfirmResolution, null>): string {
  if ('cancelled' in r) return 'Demande close';
  if (r.auto) return 'Autorisée par une règle du serveur';
  if (r.answer === 'always') return 'Toujours autorisée sur ce serveur';
  return r.answer === 'no' ? 'Refusée' : 'Autorisée';
}

/**
 * Chantier 17 (R.5, §11.3) : carte de confirmation d'une commande destructive sur un serveur distant. La commande
 * est montrée telle que l'agent l'a écrite ; « Toujours autoriser sur ce serveur » écrit une règle, révocable dans
 * la configuration du serveur.
 */
export function ConfirmCard({
  agentId,
  request,
  resolution,
  dataNode,
}: {
  agentId: string;
  request: PendingRequest;
  resolution: ConfirmResolution;
  dataNode: string;
}) {
  const { call } = useAid();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoyee, setEnvoyee] = useState<PendingOption['answer'] | null>(null);
  const resolue = resolution ?? (envoyee ? { answer: envoyee } : null);

  const repondre = async (answer: PendingOption['answer']) => {
    setBusy(true);
    setErreur(null);
    try {
      await call('POST', `/api/server-agents/${agentId}/answer`, { pendingId: request.id, answer });
      setEnvoyee(answer);
    } catch (err) {
      setErreur(message(err));
    } finally {
      setBusy(false);
    }
  };

  const etat = !resolue
    ? 'attente'
    : 'cancelled' in resolue
      ? 'close'
      : resolue.answer === 'no'
        ? 'refusee'
        : 'autorisee';
  return (
    <div
      className={`confirm-carte confirm-carte--${etat}`}
      data-node={dataNode}
      role="group"
      aria-label="Confirmation requise"
    >
      <p className="confirm-titre" data-node={`${dataNode}.titre`}>
        <span className="confirm-point" aria-hidden="true" />
        Confirmation requise · {request.confirm?.server ?? 'serveur'}
      </p>
      <pre className="confirm-commande" data-node={`${dataNode}.commande`}>
        {request.command ?? request.question}
      </pre>
      {!resolue ? (
        <div className="confirm-options">
          {request.options.map((o, i) => (
            <button
              key={o.answer}
              className={`bouton confirm-option confirm-option--${o.answer}`}
              data-node={`${dataNode}.option-${i + 1}`}
              type="button"
              disabled={busy}
              onClick={() => void repondre(o.answer)}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="confirm-issue" data-node={`${dataNode}.issue`}>
          {issue(resolue)}
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
