import type { Topic, Workspace } from '../../../src/shared/model.js';
import { ConfirmerNettoyage } from '../dialogues/ConfirmerNettoyage.js';
import { Badge } from '../ui/Statut.js';
import { useNettoyage } from './useNettoyage.js';

export function CasErreurWorktree({
  n,
  topic,
  workspace,
}: {
  n: number;
  topic: Topic;
  workspace: Workspace | undefined;
}) {
  const id = (rest: string) => `1-1.erreur.sujet-${n}.${rest}`;
  const { phase, start, reset } = useNettoyage(topic.id);
  return (
    <article
      className="cas-erreur"
      data-node={`1-1.erreur.sujet-${n}`}
      aria-label="Worktree introuvable"
    >
      <div className="carte-entete">
        <div className="carte-ident">
          <span className="carte-branche" data-node={id('branche')} data-bind="sujet.branche">
            {topic.branch}
          </span>
          <span className="carte-sous-titre">
            <span data-node={id('workspace')} data-bind="workspace.nom">
              {workspace?.name ?? '?'}
            </span>{' '}
            ·{' '}
            <span data-node={id('titre')} data-bind="sujet.titre">
              {topic.title}
            </span>
          </span>
        </div>
        <Badge view={{ label: 'Erreur', tone: 'erreur' }} dataNode={id('statut')} />
      </div>
      <p className="element-detail" data-node={id('cause')} data-bind="erreur.cause">
        Worktree introuvable : {topic.worktree} a été supprimé hors d’A-I-D.
      </p>
      {phase.phase === 'refuse' && (
        <p className="message-erreur" role="alert">
          {phase.message}
        </p>
      )}
      <div className="cas-erreur-actions">
        <button
          className="bouton bouton--fantome"
          data-node={id('archiver')}
          data-action="topic.cleanup"
          type="button"
          onClick={() => void start()}
          disabled={phase.phase === 'en-cours'}
        >
          Archiver le sujet
        </button>
      </div>
      {phase.phase === 'confirmer' && (
        <ConfirmerNettoyage
          commits={phase.commits}
          onClose={reset}
          onConfirm={(n) => void start(n)}
        />
      )}
    </article>
  );
}
