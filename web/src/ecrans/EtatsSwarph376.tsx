import type { BoardResult } from '../../../src/shared/board.js';
import { MessageBoard } from './Board.js';

/** États propres au point 37.6, les autres gardent les messages du Board. */
export function EtatsSwarph376<T>({
  result,
  erreur,
  relire,
  node,
  memoire = false,
}: {
  result: BoardResult<T> | null;
  erreur: string | null;
  relire: () => void;
  node: string;
  memoire?: boolean;
}) {
  if (erreur) return <MessageBoard kind="unknown" node={`${node}.erreur`} onRelire={relire} />;
  if (!result || result.ok) return null;
  if (result.kind === 'proxy-indisponible') {
    return (
      <p data-node={`${node}.etat`} data-kind={result.kind}>
        Les liens ne sont pas disponibles par le proxy.
      </p>
    );
  }
  const texte =
    result.kind === 'no-index'
      ? "Aucun index local. Ce n'est pas un résultat négatif : rien n'a été cherché."
      : memoire && result.kind === 'forbidden'
        ? "Ta cellule n'a pas, ou plus, accès à cette mémoire."
        : memoire && result.kind === 'not-configured'
          ? "Le gateway n'est pas configuré pour la mémoire."
          : null;
  return texte ? (
    <p data-node={`${node}.etat`} data-kind={result.kind}>
      {texte}
    </p>
  ) : (
    <MessageBoard kind={result.kind} node={`${node}.etat`} onRelire={relire} />
  );
}

export function LectureSwarph376({
  luA,
  enLecture,
  relire,
  node,
  desactive = false,
  raison,
}: {
  luA: string | null;
  enLecture: boolean;
  relire: () => void;
  node: string;
  desactive?: boolean;
  raison?: string;
}) {
  return (
    <div data-node={`${node}.lecture`}>
      <span>Lu à {luA ? new Date(luA).toLocaleTimeString('fr-FR') : '—'}</span>{' '}
      <button
        type="button"
        className="bouton"
        disabled={enLecture || desactive}
        aria-describedby={raison ? `${node}-raison` : undefined}
        onClick={relire}
        data-node={`${node}.recharger`}
      >
        Recharger
      </button>
      {raison && (
        <p id={`${node}-raison`} data-node={`${node}.raison`}>
          {raison}
        </p>
      )}
    </div>
  );
}
