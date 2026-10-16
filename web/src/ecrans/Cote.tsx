import { Link } from 'react-router';
import { useAid } from '../data/useAidState.js';
import { aggregateStatus, Point, statusView } from '../ui/Statut.js';

export function Cote({ activeTopicId }: { activeTopicId: string }) {
  const { state, daemon } = useAid();
  if (!state) {
    return (
      <nav className="cote" data-node="1-3.sujets" aria-label="Sujets">
        {daemon === 'injoignable' || daemon === 'session-expiree' ? (
          <p className="texte-faible" data-node="1-3.sujets.indisponible">
            Liste indisponible
          </p>
        ) : (
          [1, 2, 3].map((n) => (
            <div key={n} className="squelette" data-node={`1-3.sujets.squelette-${n}`}>
              <span className="sq sq--ligne" />
            </div>
          ))
        )}
      </nav>
    );
  }
  // numérotation continue des sujets d'un groupe à l'autre, calculée avant le rendu
  const groups = state.workspaces
    .map((w, gi) => ({ w, gi, topics: state.topics.filter((t) => t.workspaceId === w.id) }))
    .filter((g) => g.topics.length > 0);
  const offsets = groups.map((_, i) =>
    groups.slice(0, i).reduce((sum, g) => sum + g.topics.length, 0),
  );
  return (
    <nav className="cote" data-node="1-3.sujets" aria-label="Sujets ouverts">
      {groups.map(({ w, gi, topics }, groupIndex) => {
        return (
          <div key={w.id} className="cote-groupe" data-node={`1-3.sujets.groupe-${gi + 1}`}>
            <h2 className="titre-zone" data-node={`1-3.sujets.groupe-${gi + 1}.nom`}>
              {w.name}
            </h2>
            {topics.map((t, ti) => {
              const n = (offsets[groupIndex] ?? 0) + ti + 1;
              const runIds = state.runs.filter((r) => r.topicId === t.id).map((r) => r.id);
              const agg = aggregateStatus(
                state.agents.filter((a) => runIds.includes(a.runId)).map((a) => a.status),
              );
              const view = agg
                ? statusView(agg)
                : { label: 'Aucun agent', tone: 'inactif' as const };
              return (
                <Link
                  key={t.id}
                  to={`/sujets/${t.id}`}
                  className={`cote-sujet${t.id === activeTopicId ? ' est-actif' : ''}`}
                  data-node={`1-3.sujets.sujet-${n}`}
                  data-action="sujet.ouvrir"
                >
                  <Point tone={view.tone} label={view.label} />
                  <span data-node={`1-3.sujets.sujet-${n}.branche`} data-bind="sujet.branche">
                    {t.branch}
                  </span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
