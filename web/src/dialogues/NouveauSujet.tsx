import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { TopicType } from '../../../src/shared/model.js';
import { slugify } from '../../../src/shared/slug.js';
import { AidApiError } from '../data/api.js';
import { useAid } from '../data/useAidState.js';
import { Dialogue } from './Dialogue.js';

export function NouveauSujet({
  onClose,
  onAddWorkspace,
  initialWorkspaceId,
}: {
  onClose: () => void;
  onAddWorkspace: () => void;
  initialWorkspaceId?: string;
}) {
  const { state, outputs, call } = useAid();
  const navigate = useNavigate();
  const workspaces = state?.workspaces ?? [];
  // le dernier enregistré : on vient en général de l'ajouter
  const latest = [...workspaces].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const [workspaceId, setWorkspaceId] = useState(
    workspaces.find((w) => w.id === initialWorkspaceId)?.id ?? latest?.id ?? '',
  );
  const [title, setTitle] = useState('');
  const [type, setType] = useState<TopicType>('feat');
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);

  const slug = useMemo(() => {
    try {
      return slugify(title);
    } catch {
      return null;
    }
  }, [title]);

  const action = state?.actions.find((a) => a.id === actionId);
  useEffect(() => {
    if (action?.state === 'succeeded' && action.topicId) {
      onClose();
      navigate(`/sujets/${action.topicId}`);
    }
  }, [action, navigate, onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await call<{ actionId: string }>('POST', '/api/topics', {
        workspaceId,
        title: title.trim(),
        type,
      });
      setActionId(r.actionId);
    } catch (err) {
      setError(err instanceof AidApiError ? err.message : String(err));
    }
  }

  const running = actionId !== null && (!action || action.state === 'running');
  const lines = actionId ? (outputs[actionId] ?? []) : [];
  return (
    <Dialogue titre="Nouveau sujet" onClose={onClose}>
      <form onSubmit={submit} className="formulaire" aria-label="Créer un sujet">
        <label>
          Projet
          <select
            className="selecteur"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            disabled={running}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="bouton bouton--fantome"
          data-action="workspace.ajouter"
          type="button"
          onClick={onAddWorkspace}
          disabled={running}
        >
          Ajouter un projet…
        </button>
        <label>
          Titre
          <input
            className="champ"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={running}
            autoFocus
          />
        </label>
        <label>
          Type
          <select
            className="selecteur"
            value={type}
            onChange={(e) => setType(e.target.value as TopicType)}
            disabled={running}
          >
            {(['feat', 'fix', 'chore', 'spike'] as const).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <p className="apercu-branche" data-bind="apercu.commande">
          {slug ? `branche : ${type}/${slug}` : 'branche : (titre à saisir)'}
        </p>
        {error && (
          <p className="message-erreur" role="alert">
            {error}
          </p>
        )}
        {actionId && (
          <>
            <div className="sortie-action" role="log" aria-label="Sortie de la création">
              {lines.map((l, i) => (
                <div key={i}>{l.line}</div>
              ))}
            </div>
            {action && action.state !== 'running' && action.state !== 'succeeded' && (
              <p className="message-erreur" role="alert">
                {action.state === 'needs_human'
                  ? 'Action humaine requise : voir la sortie ci-dessus.'
                  : 'La création a échoué : voir la sortie ci-dessus.'}
              </p>
            )}
          </>
        )}
        <div className="dialogue-actions">
          <button className="bouton bouton--fantome" type="button" onClick={onClose}>
            Fermer
          </button>
          <button
            className="bouton bouton--primaire"
            type="submit"
            disabled={running || !slug || !workspaceId}
          >
            {running ? 'Création…' : 'Créer le sujet'}
          </button>
        </div>
      </form>
    </Dialogue>
  );
}
