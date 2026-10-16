import { type FormEvent, useState } from 'react';
import type { Workspace } from '../../../src/shared/model.js';
import { AidApiError } from '../data/api.js';
import { useAid } from '../data/useAidState.js';
import { Dialogue } from './Dialogue.js';

type Created = Workspace & { warnings: string[] };

export function NouveauWorkspace({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { refresh, call } = useAid();
  const [path, setPath] = useState('');
  const [base, setBase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ws = await call<Created>('POST', '/api/workspaces', {
        path: path.trim(),
        ...(base.trim() && { baseBranch: base.trim() }),
      });
      await refresh();
      if (ws.warnings.length > 0) setWarnings(ws.warnings);
      else onDone();
    } catch (err) {
      setError(err instanceof AidApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (warnings) {
    return (
      <Dialogue titre="Workspace enregistré" onClose={onDone}>
        {warnings.map((w) => (
          <p key={w} className="message-info">
            {w}
          </p>
        ))}
        <div className="dialogue-actions">
          <button className="bouton bouton--primaire" type="button" onClick={onDone}>
            Continuer
          </button>
        </div>
      </Dialogue>
    );
  }
  return (
    <Dialogue titre="Nouveau workspace" onClose={onClose}>
      <form onSubmit={submit} className="formulaire" aria-label="Enregistrer un dépôt">
        <label>
          Chemin du dépôt git (sa racine)
          <input
            className="champ"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/moi/Projects/mon-depot"
            autoFocus
          />
        </label>
        <label>
          Branche de base (facultatif : détectée depuis origin)
          <input
            className="champ"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="main"
          />
        </label>
        {error && (
          <p className="message-erreur" role="alert">
            {error}
          </p>
        )}
        <div className="dialogue-actions">
          <button className="bouton bouton--fantome" type="button" onClick={onClose}>
            Annuler
          </button>
          <button
            className="bouton bouton--primaire"
            type="submit"
            disabled={busy || path.trim() === ''}
          >
            Enregistrer
          </button>
        </div>
      </form>
    </Dialogue>
  );
}
