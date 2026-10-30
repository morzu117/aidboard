import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useRef, useState } from 'react';
import type { AgentSettings } from '../../../src/shared/agentSettings.js';
import type { AgentStatus } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { ComposerReglages } from './ComposerReglages.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// D70 : mêmes bornes que le daemon, vérifiées ici pour refuser avant de lire le fichier.
const PIECES_MAX = 5;
const PIECE_MAX_OCTETS = 10 * 1024 * 1024;

const enBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error ?? new Error(`lecture impossible : ${f.name}`));
    r.readAsDataURL(f);
  });

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
  const [pieces, setPieces] = useState<File[]>([]);
  const fichierRef = useRef<HTMLInputElement>(null);
  // pièces jointes : agents `stream` seulement (D70), les mêmes qui ont des réglages
  const joindre = settings !== undefined;

  const needsInput = status === 'needs_input';
  const working = status === 'working';

  const envoyer = async () => {
    const t = text.trim();
    if ((!t && pieces.length === 0) || needsInput || busy) return;
    setBusy(true);
    setErreur(null);
    try {
      const attachments = await Promise.all(
        pieces.map(async (f) => ({
          name: f.name,
          type: f.type || 'application/octet-stream',
          data: await enBase64(f),
        })),
      );
      await call(
        'POST',
        `/api/agents/${agentId}/input`,
        attachments.length > 0 ? { text, attachments } : { text },
      );
      setText('');
      setPieces([]);
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

  const ajouter = (fichiers: File[]) => {
    if (!joindre || fichiers.length === 0) return;
    const trop = fichiers.find((f) => f.size > PIECE_MAX_OCTETS);
    if (trop) {
      setErreur(`${trop.name} dépasse 10 Mio`);
      return;
    }
    if (pieces.length + fichiers.length > PIECES_MAX) {
      setErreur(`${PIECES_MAX} pièces jointes au plus`);
      return;
    }
    setErreur(null);
    setPieces([...pieces, ...fichiers]);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (!joindre || images.length === 0) return;
    e.preventDefault();
    ajouter(images);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!joindre || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    ajouter(Array.from(e.dataTransfer.files));
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
    <div
      className="composer"
      data-node={dataNode}
      onDragOver={(e) => joindre && e.preventDefault()}
      onDrop={onDrop}
    >
      {pieces.length > 0 && (
        <ul
          className="composer-pieces"
          aria-label="Pièces jointes"
          data-node={`${dataNode}.pieces`}
        >
          {pieces.map((f, i) => (
            <li key={`${i}-${f.name}`} className="composer-piece">
              <span className="composer-piece-nom">{f.name}</span>
              <button
                type="button"
                className="composer-piece-retirer"
                aria-label={`Retirer ${f.name}`}
                onClick={() => setPieces(pieces.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
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
        onPaste={onPaste}
        onCompositionStart={() => (composingRef.current = true)}
        onCompositionEnd={() => (composingRef.current = false)}
      />
      <div className="composer-barre">
        {joindre && (
          <>
            <button
              className="composer-trombone"
              data-node={`${dataNode}.joindre`}
              type="button"
              aria-label="Joindre des fichiers"
              disabled={needsInput}
              onClick={() => fichierRef.current?.click()}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12l-8.5 8.5a5 5 0 01-7-7L14 5a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 8" />
              </svg>
            </button>
            <input
              ref={fichierRef}
              type="file"
              multiple
              hidden
              data-node={`${dataNode}.fichiers`}
              onChange={(e) => {
                ajouter(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          </>
        )}
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
          disabled={(!text.trim() && pieces.length === 0) || needsInput || busy}
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
