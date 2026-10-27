import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { StoredEvent } from '../../../src/shared/events.js';
import { useAid } from '../data/useAidState.js';

function heure(ts: string): string {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function contexte(ev: StoredEvent): string | null {
  const parts = [ev.context?.topicBranch, ev.context?.workspaceName].filter(
    (p): p is string => !!p,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function FilActivite() {
  const { state, call } = useAid();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [erreur, setErreur] = useState(false);

  useEffect(() => {
    let annule = false;
    call<{ events: StoredEvent[] }>('GET', '/api/events/recent?limit=20').then(
      (r) => {
        if (!annule) {
          setEvents(Array.isArray(r.events) ? r.events : []);
          setErreur(false);
        }
      },
      () => !annule && setErreur(true),
    );
    return () => {
      annule = true;
    };
    // `state?.lastEventId` déclenche la relecture en direct sans nouvel abonnement socket (brief).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.lastEventId]);

  return (
    <div className="panneau" data-node="1-1.activite">
      <div className="panneau-entete">
        <h2 className="titre-zone" data-node="1-1.activite.titre">
          Activité récente
        </h2>
      </div>
      <div className="panneau-corps">
        {erreur ? (
          <p className="texte-discret" data-node="1-1.activite.erreur">
            Activité indisponible
          </p>
        ) : events.length === 0 ? (
          <p className="texte-discret" data-node="1-1.activite.vide">
            Aucune activité récente
          </p>
        ) : (
          <ol className="liste-activite" data-node="1-1.activite.liste">
            {events.map((ev, i) => {
              const ligneId = `1-1.activite.ligne-${i + 1}`;
              const ctx = contexte(ev);
              const contenu = (
                <Fragment>
                  <span className="activite-heure" data-node={`${ligneId}.heure`}>
                    {heure(ev.ts)}
                  </span>
                  <span className="activite-type" data-node={`${ligneId}.type`}>
                    {ev.type}
                  </span>
                  {ctx && (
                    <span className="activite-contexte" data-node={`${ligneId}.contexte`}>
                      {ctx}
                    </span>
                  )}
                </Fragment>
              );
              return (
                <li key={ev.id} className="activite-ligne" data-node={ligneId}>
                  {ev.topicId ? (
                    <Link className="activite-lien" to={`/sujets/${ev.topicId}`}>
                      {contenu}
                    </Link>
                  ) : (
                    <span className="activite-lien activite-lien--statique">{contenu}</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
