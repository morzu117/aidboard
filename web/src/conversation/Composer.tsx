import { type KeyboardEvent, useRef, useState } from 'react';
import type { AgentSettings } from '../../../src/shared/agentSettings.js';
import type { AgentStatus } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { ComposerReglages } from './ComposerReglages.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function Composer({
  agentId,
  kind,
  status,
  settings,
  dataNode,
}: {
  agentId: string;
  kind: string;
  status: AgentStatus;
  /** Agent `stream` (chantier 16) : présent, les chips mode et modèle s'affichent. */
  settings?: AgentSettings;
  dataNode: string;
}) {
  const { call } = useAid();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [arretBusy, setArretBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const composingRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const needsInput = status === 'needs_input';
  const working = status === 'working';

  const envoyer = async () => {
    const t = text.trim();
    if (!t || needsInput || busy) return;
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
    if (arretBusy) return;
    setArretBusy(true);
    setErreur(null);
    try {
      await call('POST', `/api/agents/${agentId}/interrupt`);
    } catch (err) {
      setErreur(message(err));
    } finally {
      setArretBusy(false);
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
        {settings && (
          <ComposerReglages
            agentId={agentId}
            kind={kind === 'codex' ? 'codex' : 'claude'}
            settings={settings}
            onErreur={setErreur}
            dataNode={dataNode}
          />
        )}
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
            disabled={arretBusy}
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
