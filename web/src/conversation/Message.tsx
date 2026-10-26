const heure = (at: string): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Texte brut uniquement : les enfants React échappent toujours le contenu, jamais de HTML injecté.
export function Message({
  role,
  text,
  kind,
  at,
  seq,
  marked,
  onToggleMark,
  dataNode,
}: {
  role: 'user' | 'assistant';
  text: string;
  kind: string;
  at: string;
  seq?: number;
  marked?: boolean;
  onToggleMark?: (seq: number, marked: boolean) => void;
  dataNode: string;
}) {
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
        </div>
      </div>
    );
  return (
    <div className="message-agent" data-node={dataNode}>
      <div className="message-agent-entete">
        <span className="message-agent-kind">{kind}</span>
        <span className="texte-faible">{heure(at)}</span>
      </div>
      <div className="message-agent-texte">{text}</div>
    </div>
  );
}
