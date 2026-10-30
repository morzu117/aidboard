import type { AttachmentInfo } from '../../../src/shared/conversation.js';
import { rendreMessage } from '../ui/markdownMessage.js';
import { useAgentRoutes } from './routes.js';

const heure = (at: string): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Le texte d'un utilisateur reste brut ; celui de l'agent est rendu en markdown par nos propres nœuds React,
// jamais de HTML injecté.
export function Message({
  role,
  text,
  kind,
  at,
  seq,
  marked,
  attachments,
  onToggleMark,
  dataNode,
}: {
  role: 'user' | 'assistant';
  text: string;
  kind: string;
  at: string;
  seq?: number;
  marked?: boolean;
  attachments?: AttachmentInfo[];
  onToggleMark?: (seq: number, marked: boolean) => void;
  dataNode: string;
}) {
  // R.6 : sur un serveur distant, chaque tour porte le nom du serveur à côté de l'agent
  const serveur = useAgentRoutes().distant?.serveur;
  if (role === 'user')
    return (
      <div className="message-utilisateur-ligne" data-node={dataNode} data-repere={seq}>
        <button
          className="etoile-marque"
          data-node={`${dataNode}.etoile`}
          type="button"
          aria-label={marked ? 'Démarquer la question' : 'Marquer la question'}
          aria-pressed={marked === true}
          onClick={() => seq !== undefined && onToggleMark?.(seq, !marked)}
        >
          {marked ? '★' : '☆'}
        </button>
        <div
          className={`message-utilisateur${marked ? ' message-utilisateur--marquee' : ''}`}
          data-node={`${dataNode}.bulle`}
        >
          {text}
          {attachments && attachments.length > 0 && (
            <ul
              className="message-pieces"
              aria-label="Pièces jointes"
              data-node={`${dataNode}.pieces`}
            >
              {attachments.map((a, i) => (
                <li key={i} className="message-piece">
                  📎 {a.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  const { corps, questions } = rendreMessage(text);
  return (
    <div className="message-agent" data-node={dataNode}>
      <div className="message-agent-entete">
        <span className="message-agent-kind">{kind}</span>
        {serveur && <span className="message-agent-serveur">{serveur}</span>}
        <span className="texte-faible">{heure(at)}</span>
        {questions > 0 && (
          <span className="message-agent-question" data-node={`${dataNode}.questions`}>
            {questions} question{questions > 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className="message-agent-texte md-message">{corps}</div>
    </div>
  );
}
