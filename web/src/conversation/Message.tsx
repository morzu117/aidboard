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
  dataNode,
}: {
  role: 'user' | 'assistant';
  text: string;
  kind: string;
  at: string;
  dataNode: string;
}) {
  if (role === 'user')
    return (
      <div className="message-utilisateur" data-node={dataNode}>
        {text}
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
