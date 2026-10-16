import { Dialogue } from './Dialogue.js';

export function ConfirmerNettoyage({
  commits,
  onConfirm,
  onClose,
}: {
  commits: number;
  onConfirm: (commits: number) => void;
  onClose: () => void;
}) {
  return (
    <Dialogue titre="Nettoyer le sujet ?" onClose={onClose}>
      <p className="message-erreur" role="alert">
        {commits} commit{commits > 1 ? 's' : ''} absent{commits > 1 ? 's' : ''} de la branche de
        base
        {commits > 1 ? ' seront perdus' : ' sera perdu'} : ils ne sont ni poussés ni fusionnés.
      </p>
      <div className="dialogue-actions">
        <button className="bouton bouton--fantome" type="button" onClick={onClose}>
          Garder le sujet
        </button>
        <button className="bouton bouton--danger" type="button" onClick={() => onConfirm(commits)}>
          Supprimer quand même
        </button>
      </div>
    </Dialogue>
  );
}
