import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Server } from '../../../src/shared/model.js';
import { useSessionsClaudeServeur, type ServerDiscussionView } from '../data/discussionsServeur.js';
import { useAid } from '../data/useAidState.js';
import { Dialogue } from './Dialogue.js';

/** Une reprise crée un fork indépendant : la session source reste utilisable dans son terminal. */
export function RepriseSessionServeur({
  server,
  onClose,
  onNouvelle,
}: {
  server: Server;
  onClose: () => void;
  onNouvelle: () => void;
}) {
  const { sessions, erreur: erreurListe } = useSessionsClaudeServeur(server.id);
  const { call } = useAid();
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState('');
  const [name, setName] = useState('Discussion');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const creer = async (event: FormEvent) => {
    event.preventDefault();
    if (!sessionId || !name.trim() || enCours) return;
    setEnCours(true);
    setErreur(null);
    try {
      const discussion = await call<ServerDiscussionView>(
        'POST',
        `/api/servers/${server.id}/discussions`,
        {
          name: name.trim(),
          kind: 'claude',
          resumeSessionId: sessionId,
        },
      );
      onClose();
      navigate(`/serveurs/${server.id}/discussions/${discussion.id}`);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
      setEnCours(false);
    }
  };
  return (
    <Dialogue titre={`Nouvelle discussion sur ${server.name}`} onClose={onClose}>
      <form
        className="formulaire"
        aria-label="Reprendre une session existante"
        onSubmit={(e) => void creer(e)}
      >
        <div className="dialogue-actions">
          <button
            className="bouton bouton--fantome"
            type="button"
            disabled={enCours}
            onClick={onNouvelle}
          >
            Nouvelle
          </button>
          <span>Reprendre une session existante</span>
        </div>
        <p className="texte-discret">
          Une copie indépendante reprend l’historique. La session d’origine reste intacte.
        </p>
        <label>
          Nom
          <input
            className="champ"
            value={name}
            maxLength={120}
            disabled={enCours}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {sessions === null && !erreurListe && <p role="status">Chargement des sessions…</p>}
        {sessions?.length === 0 && <p>Aucune session Claude disponible sur ce serveur.</p>}
        {sessions && sessions.length > 0 && (
          <label>
            Session Claude
            <select
              className="selecteur"
              value={sessionId}
              required
              disabled={enCours}
              onChange={(e) => setSessionId(e.target.value)}
            >
              <option value="">Choisir une session</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} — {s.cwd} — {new Date(s.updatedAt).toLocaleString('fr-FR')}
                </option>
              ))}
            </select>
          </label>
        )}
        {(erreurListe || erreur) && (
          <p className="message-erreur" role="alert">
            {erreurListe || erreur}
          </p>
        )}
        <div className="dialogue-actions">
          <button className="bouton bouton--fantome" type="button" onClick={onClose}>
            Annuler
          </button>
          <button
            className="bouton bouton--primaire"
            type="submit"
            disabled={enCours || !name.trim() || !sessionId}
          >
            Créer et ouvrir
          </button>
        </div>
      </form>
    </Dialogue>
  );
}
