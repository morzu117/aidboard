import type { ToolCall } from './thread.js';

const resumeEntree = (input: unknown): string => {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
};

const premiereLigne = (s: string | undefined): string => {
  const ligne = (s ?? '').split('\n').find((l) => l.trim().length > 0) ?? '';
  return ligne.length > 120 ? `${ligne.slice(0, 120)}…` : ligne;
};

export function ToolCallGroup({
  calls,
  open,
  onToggle,
  dataNode,
}: {
  calls: ToolCall[];
  open: boolean;
  onToggle: () => void;
  dataNode: string;
}) {
  return (
    <div className="outil-groupe" data-node={dataNode}>
      <div className="outil-groupe-entete">
        <span className="outil-groupe-compte">
          {calls.length} commande{calls.length > 1 ? 's' : ''}
        </span>
        <button
          className="bouton"
          data-node={`${dataNode}.detail`}
          type="button"
          onClick={onToggle}
        >
          {open ? 'Replier le détail' : 'Voir le détail'}
        </button>
      </div>
      {calls.map((c, i) => (
        <div key={c.toolId} className="outil-ligne" data-node={`${dataNode}.ligne-${i + 1}`}>
          <div className="outil-ligne-entete">
            <span
              className={`outil-statut${c.done ? (c.isError ? ' outil-statut--erreur' : ' outil-statut--succes') : ' outil-statut--cours'}`}
              role="img"
              aria-label={!c.done ? 'en cours' : c.isError ? 'erreur' : 'succès'}
            >
              {!c.done ? '…' : c.isError ? '✗' : '✓'}
            </span>
            <span className="outil-nom">
              {c.name}
              {resumeEntree(c.input) && (
                <span className="outil-entree"> {resumeEntree(c.input)}</span>
              )}
            </span>
            <span className="outil-resultat">{premiereLigne(c.output)}</span>
          </div>
          {open && <pre className="outil-detail">{c.output ?? ''}</pre>}
        </div>
      ))}
    </div>
  );
}
