import { useEffect, useId, useRef, type RefObject } from 'react';
import type { QuestionRepere } from './MarkRail.js';

const LONGUEUR_MAX_LIGNE = 60;

const tronquer = (s: string): string =>
  s.length > LONGUEUR_MAX_LIGNE ? `${s.slice(0, LONGUEUR_MAX_LIGNE)}…` : s;

const heure = (at: string): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Menu « Repères · N/M » (§5.3.2) : liste des questions, Échap rend le focus, clic hors du menu ferme sans y revenir.
export function MarkMenu({
  questions,
  active,
  onSelect,
  onClose,
  triggerRef,
  dataNode,
}: {
  questions: QuestionRepere[];
  active: number | null;
  onSelect: (seq: number) => void;
  onClose: (renvoyerFocus: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  dataNode: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titreId = useId();

  useEffect(() => {
    // Un clic sur le bouton déclencheur passe par ici avant son propre onClick : l'ignorer évite
    // de refermer puis rouvrir le menu dans la même interaction (review A.7).
    const onDown = (e: MouseEvent) => {
      const cible = e.target as Node;
      if (ref.current?.contains(cible) || triggerRef.current?.contains(cible)) return;
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(true);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, triggerRef]);

  return (
    <div
      className="repere-menu"
      data-node={dataNode}
      role="region"
      aria-labelledby={titreId}
      ref={ref}
    >
      <p className="repere-menu-titre" id={titreId}>
        Questions de cette discussion
      </p>
      {questions.map((q) => (
        <button
          key={q.seq}
          type="button"
          aria-current={q.seq === active ? 'true' : undefined}
          className={`repere-menu-ligne${q.seq === active ? ' repere-menu-ligne--actif' : ''}`}
          data-node={`${dataNode}.q-${q.seq}`}
          onClick={() => onSelect(q.seq)}
        >
          <span className="repere-menu-etoile" aria-hidden="true">
            {q.marked ? '★' : '☆'}
          </span>
          <span className="repere-menu-texte">{tronquer(q.text)}</span>
          <span className="texte-faible">{heure(q.at)}</span>
        </button>
      ))}
      <p className="repere-menu-rappel">
        <kbd className="raccourci">j</kbd> / <kbd className="raccourci">k</kbd> question suivante /
        précédente · <kbd className="raccourci">m</kbd> marquer · <kbd className="raccourci">e</kbd>{' '}
        détail
      </p>
    </div>
  );
}
