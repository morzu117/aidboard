import { type FormEvent, useState } from 'react';
import type { Workspace } from '../../../src/shared/model.js';
import { AidApiError } from '../data/api.js';
import { useAid } from '../data/useAidState.js';
import { Dialogue } from './Dialogue.js';
import { SelecteurDossier } from './SelecteurDossier.js';

type Created = Workspace & { warnings: string[] };

export function NouveauWorkspace({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { refresh, call, state } = useAid();
  const [path, setPath] = useState<string | null>(null);
  const [base, setBase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  // on repart du dossier qui contient le dernier dépôt enregistré : les dépôts d'une même personne sont souvent côte à côte
  const last = state?.workspaces.at(-1)?.root;
  const start = last ? last.slice(0, last.lastIndexOf('/')) || '/' : undefined;

  async function submit(e: FormEvent) {
    if (path === null) return;
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ws = await call<Created>('POST', '/api/workspaces', {
        path,
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
      <Dialogue titre="Projet enregistré" onClose={onDone}>
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
    <Dialogue titre="Nouveau projet" onClose={onClose}>
      <form onSubmit={submit} className="formulaire" aria-label="Enregistrer un dépôt">
        <SelecteurDossier start={start} selected={path} onSelect={setPath} />
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
            disabled={busy || path === null}
          >
            Enregistrer
          </button>
        </div>
      </form>
    </Dialogue>
  );
}
