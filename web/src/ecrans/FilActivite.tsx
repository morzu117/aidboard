import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { StoredEvent } from '../../../src/shared/events.js';
import type { Phase, TopicState } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { PHASES } from '../ui/rangement.js';

function heure(ts: string): string {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function contexte(ev: StoredEvent): string | null {
  const parts = [ev.context?.topicBranch, ev.context?.workspaceName].filter(
    (p): p is string => !!p,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

// Chantier 25 (D109) : « Ce qui a bougé » dit l'événement en phrase. Un type absent de la table, ou un
// cas qu'elle ne sait pas dire, n'est pas affiché : jamais d'événement technique brut.
type Donnees = Record<string, unknown>;
const texte = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const AGENTS: Record<string, string> = { claude: 'Claude', codex: 'Codex', shell: 'Shell' };

const ETATS_SUJET: Partial<Record<TopicState, string>> = {
  draft: 'Sujet créé',
  active: 'Sujet ouvert',
  review: 'Sujet en revue',
  merged: 'Sujet fusionné',
  archived: 'Sujet archivé',
};

const DM: Record<string, string> = {
  question: 'Question de',
  answer: 'Réponse de',
  unblock: 'Déblocage par',
};

const PHRASES: Record<string, (d: Donnees) => string | null> = {
  'tour.marque': (d) =>
    `Tour marqué ${d.etat === 'relu' ? 'relu' : 'à reprendre'} par ${d.par === 'mac' ? 'Mac' : (texte(d.parNom) ?? 'un appareil')}`,
  'appareil.ecriture': (d) => `${texte(d.nom) ?? 'Un appareil'} a écrit depuis un appareil`,
  'approval.requested': () => 'Une autorisation t’attend',
  'approval.resolved': () => 'Autorisation tranchée',
  'agent.spawned': (d) => `${AGENTS[texte(d.kind) ?? ''] ?? 'Agent'} lancé`,
  'agent.exited': (d) =>
    d.reason === 'daemon_restart'
      ? 'Agent arrêté par le redémarrage du daemon'
      : d.exitCode === 0
        ? 'Agent terminé'
        : typeof d.exitCode === 'number'
          ? 'Agent sorti en erreur'
          : 'Agent arrêté',
  'topic.state': (d) => ETATS_SUJET[d.state as TopicState] ?? null,
  'topic.phase': (d) => {
    const phase = PHASES[d.phase as Phase];
    return phase ? `Phase : ${phase}` : d.phase == null ? 'Phase retirée' : null;
  },
  'topic.branch': () => 'Branche changée',
  'topic.pr': (d) => (typeof d.prNumber === 'number' ? `PR #${d.prNumber} ouverte` : 'PR ouverte'),
  'plan.updated': () => 'Plan mis à jour',
  'action.finished': (d) =>
    d.outcome === 'succeeded'
      ? 'Action réussie'
      : d.outcome === 'needs_human'
        ? 'Action à finir à la main'
        : 'Action échouée',
  'mesh.dm': (d) => {
    const de = texte(d.from);
    if (!de) return null;
    return `${DM[texte(d.kind) ?? ''] ?? 'DM de'} ${de}`;
  },
};

export function phraseActivite(ev: StoredEvent): string | null {
  const phrase = PHRASES[ev.type];
  return phrase ? phrase((ev.data ?? {}) as Donnees) : null;
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
  const lignes = events.flatMap((ev) => {
    const phrase = phraseActivite(ev);
    return phrase ? [{ ev, phrase }] : [];
  });

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
        ) : lignes.length === 0 ? (
          <p className="texte-discret" data-node="1-1.activite.vide">
            Aucune activité récente
          </p>
        ) : (
          <ol className="liste-activite" data-node="1-1.activite.liste">
            {lignes.map(({ ev, phrase }, i) => {
              const ligneId = `1-1.activite.ligne-${i + 1}`;
              const ctx = contexte(ev);
              const contenu = (
                <Fragment>
                  <span className="activite-heure" data-node={`${ligneId}.heure`}>
                    {heure(ev.ts)}
                  </span>
                  <div className="activite-corps">
                    <span
                      className="activite-type"
                      data-node={`${ligneId}.type`}
                      data-type={ev.type}
                    >
                      {phrase}
                    </span>
                    {ctx && (
                      <span className="activite-contexte" data-node={`${ligneId}.contexte`}>
                        {ctx}
                      </span>
                    )}
                  </div>
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
