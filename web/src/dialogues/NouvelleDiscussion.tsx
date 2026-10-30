import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Server } from '../../../src/shared/model.js';
import type { ServerDiscussionView } from '../data/discussionsServeur.js';
import { useAid } from '../data/useAidState.js';
import { Dialogue } from './Dialogue.js';

/** Les agents qu'une discussion sait piloter (R.4) ; seuls ceux détectés au dernier test sont proposés. */
const PILOTABLES = ['claude', 'codex'];

/**
 * Chantier 17 (R.6) : « Ouvrir la discussion » sur un serveur qui n'en a aucune. L'agent démarre sur le serveur dès
 * la création, dans le répertoire de travail du serveur ; l'écran Discussion prend le relais.
 */
export function NouvelleDiscussion({ server, onClose }: { server: Server; onClose: () => void }) {
  const { call } = useAid();
  const navigate = useNavigate();
  const agents = (server.detectedAgents ?? []).filter((a) => PILOTABLES.includes(a));
  const [name, setName] = useState('Discussion');
  const [kind, setKind] = useState(agents[0] ?? '');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const creer = async (e: FormEvent) => {
    e.preventDefault();
    setErreur(null);
    setEnCours(true);
    try {
      const d = await call<ServerDiscussionView>('POST', `/api/servers/${server.id}/discussions`, {
        name: name.trim(),
        kind,
      });
      onClose();
      navigate(`/serveurs/${server.id}/discussions/${d.id}`);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
      setEnCours(false);
    }
  };

  return (
    <Dialogue titre={`Nouvelle discussion sur ${server.name}`} onClose={onClose}>
      <form
        onSubmit={(e) => void creer(e)}
        className="formulaire"
        aria-label="Créer une discussion"
        data-node="nouvelle-discussion"
      >
        <label>
          Nom
          <input
            className="champ"
            data-node="nouvelle-discussion.nom"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            disabled={enCours}
            autoFocus
          />
        </label>
        {agents.length > 0 ? (
          <label>
            Agent
            <select
              className="selecteur"
              data-node="nouvelle-discussion.agent"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              disabled={enCours}
            >
              {agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="texte-discret" data-node="nouvelle-discussion.aucun-agent">
            Aucun agent détecté sur {server.name}. Lance « Tester la connexion » : le test cherche
            claude et codex sur le serveur.
          </p>
        )}
        <p className="texte-discret">
          L’agent démarre sur le serveur, dans <code>{server.workdir}</code>.
        </p>
        {erreur && (
          <p className="message-erreur" role="alert" data-node="nouvelle-discussion.erreur">
            {erreur}
          </p>
        )}
        <div className="dialogue-actions">
          <button className="bouton bouton--fantome" type="button" onClick={onClose}>
            Annuler
          </button>
          <button
            className="bouton bouton--primaire"
            data-node="nouvelle-discussion.creer"
            type="submit"
            disabled={enCours || !name.trim() || !kind}
          >
            Créer et ouvrir
          </button>
        </div>
      </form>
    </Dialogue>
  );
}
