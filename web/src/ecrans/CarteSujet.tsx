import { Link } from 'react-router';
import type { Agent, Topic, Workspace } from '../../../src/shared/model.js';
import { aggregateStatus, Badge, Point, statusView } from '../ui/Statut.js';
import { depuis } from '../ui/depuis.js';

export function CarteSujet({
  n,
  topic,
  workspace,
  agents,
}: {
  n: number;
  topic: Topic;
  workspace: Workspace | undefined;
  agents: Agent[];
}) {
  const id = (rest: string) => `1-1.grille.sujet-${n}.${rest}`;
  const aggregate = aggregateStatus(agents.map((a) => a.status));
  const view = aggregate
    ? statusView(aggregate)
    : { label: 'Aucun agent', tone: 'inactif' as const };
  const cls = view.tone === 'attente' || view.tone === 'erreur' ? ` carte--${view.tone}` : '';
  return (
    <article
      className={`carte${cls}`}
      data-node={`1-1.grille.sujet-${n}`}
      aria-label={topic.branch}
    >
      <div className="carte-entete">
        <Point tone={view.tone} grand />
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
        <Badge view={view} dataNode={id('statut')} />
      </div>
      <div className="carte-meta">
        <span
          className="pastille pastille--local"
          data-node={id('execution')}
          data-bind="agent.transport"
        >
          local
        </span>
        <div className="agents" data-node={id('agents')} role="group" aria-label="Agents du sujet">
          {agents.map((a, i) => {
            const v = statusView(a.status);
            return (
              <span key={a.id} className="puce-agent" data-node={id(`agent-${i + 1}`)}>
                <Point tone={v.tone} label={v.label} />
                <span data-node={id(`agent-${i + 1}.type`)} data-bind="agent.type">
                  {a.kind}
                </span>
                <span
                  className="agent-role"
                  data-node={id(`agent-${i + 1}.role`)}
                  data-bind="agent.role"
                >
                  {a.role}
                </span>
              </span>
            );
          })}
        </div>
        <span
          className="carte-activite"
          data-node={id('activite')}
          data-bind="sujet.derniere_activite"
        >
          {depuis(topic.updatedAt)}
        </span>
      </div>
      <div className="carte-actions" data-node={id('actions')}>
        <Link
          className="lien pousser"
          data-node={id('actions.ouvrir')}
          data-action="sujet.ouvrir"
          to={`/sujets/${topic.id}`}
        >
          Ouvrir le sujet →
        </Link>
      </div>
    </article>
  );
}
