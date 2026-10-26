import { type KeyboardEvent, useRef, useState } from 'react';
import type { AgentStatus } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const ENDED: ReadonlySet<AgentStatus> = new Set(['done', 'error', 'stopped']);

export function Composer({
  agentId,
  kind,
  status,
  exited,
  dataNode,
}: {
  agentId: string;
  kind: string;
  status: AgentStatus;
  /** le canal structuré a reçu `exit` : s'ajoute à `status` pour couvrir le daemon précédent (D65) */
  exited: boolean;
  dataNode: string;
}) {
  const { call } = useAid();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const composingRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const ended = exited || ENDED.has(status);
  const needsInput = status === 'needs_input';
  const working = status === 'working';

  const envoyer = async () => {
    const t = text.trim();
    if (!t || ended || needsInput || busy) return;
    setBusy(true);
    setErreur(null);
    try {
      await call('POST', `/api/agents/${agentId}/input`, { text });
      setText('');
    } catch (err) {
      setErreur(message(err));
    } finally {
      setBusy(false);
    }
  };

  const arreter = async () => {
    setErreur(null);
    try {
      await call('POST', `/api/agents/${agentId}/interrupt`);
    } catch (err) {
      setErreur(message(err));
    }
  };

  const onInput = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
      e.preventDefault();
      void envoyer();
    }
  };

  if (ended)
    return (
      <div className="composer" data-node={dataNode}>
        <p className="composer-etat" data-node={`${dataNode}.etat`}>
          Agent arrêté
        </p>
      </div>
    );

  return (
    <div className="composer" data-node={dataNode}>
      <textarea
        ref={taRef}
        className="composer-champ"
        data-node={`${dataNode}.champ`}
        aria-label={`Message à ${kind}`}
        placeholder={`Écris à ${kind}…`}
        rows={2}
        maxLength={4000}
        disabled={needsInput}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onInput();
        }}
        onKeyDown={onKeyDown}
        onCompositionStart={() => (composingRef.current = true)}
        onCompositionEnd={() => (composingRef.current = false)}
      />
      <div className="composer-barre">
        {needsInput && (
          <span className="texte-discret" data-node={`${dataNode}.attente`}>
            Répondre d’abord à la demande
          </span>
        )}
        <div className="composer-pousser" />
        {working && (
          <button
            className="bouton"
            data-node={`${dataNode}.arreter`}
            type="button"
            onClick={() => void arreter()}
          >
            Arrêter
          </button>
        )}
        <button
          className="bouton-icone bouton--primaire"
          data-node={`${dataNode}.envoyer`}
          type="button"
          aria-label="Envoyer"
          disabled={!text.trim() || needsInput || busy}
          onClick={() => void envoyer()}
        >
          ↑
        </button>
      </div>
      {erreur && (
        <p className="message-erreur" role="alert" data-node={`${dataNode}.erreur`}>
          {erreur}
        </p>
      )}
    </div>
  );
}
