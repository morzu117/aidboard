import { type FormEvent, useMemo, useState } from 'react';
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
  const { state, call } = useAid();
  const navigate = useNavigate();
  const workspaces = state?.workspaces ?? [];
  // le dernier enregistré : on vient en général de l'ajouter
  const latest = [...workspaces].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  // le dialogue peut s'ouvrir avant l'hydratation de `state` (clic juste après un rechargement) :
  // tant qu'aucun choix explicite n'a été fait, le défaut se recalcule au rendu avec les projets.
  const [choixExplicite, setChoixExplicite] = useState<string | null>(null);
  const defaut = workspaces.find((w) => w.id === initialWorkspaceId)?.id ?? latest?.id ?? '';
  const workspaceId =
    choixExplicite && workspaces.some((w) => w.id === choixExplicite) ? choixExplicite : defaut;
  const [title, setTitle] = useState('');
  const [type, setType] = useState<TopicType>('feat');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const slug = useMemo(() => {
    try {
      return slugify(title);
    } catch {
      return null;
    }
  }, [title]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // D15 : le sujet existe en draft dès cette requête — l'écran 2.2 (Sujet.tsx) prend le
      // relais pour suivre topic.create, pas besoin d'attendre son succès ici.
      const r = await call<{ topicId: string }>('POST', '/api/topics', {
        workspaceId,
        title: title.trim(),
        type,
      });
      onClose();
      navigate(`/sujets/${r.topicId}`);
    } catch (err) {
      setError(err instanceof AidApiError ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const running = submitting;
  return (
    <Dialogue titre="Nouveau sujet" onClose={onClose}>
      <form onSubmit={submit} className="formulaire" aria-label="Créer un sujet">
        <label>
          Projet
          <select
            className="selecteur"
            value={workspaceId}
            onChange={(e) => setChoixExplicite(e.target.value)}
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
