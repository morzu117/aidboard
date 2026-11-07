import { useState } from 'react';
import type { EtatPourAppareil } from '../../../src/shared/host.js';
import { AidApiError } from '../data/api.js';
import { useAid, useAidClient } from '../data/useAidState.js';

type Agent = EtatPourAppareil['agents'][number];
const REFUS: Record<string, string> = {
  mode: 'Cet agent accepte seul ses actions : tranche sur le Mac.',
  nature: "C'est une autorisation : elle se donne sur le Mac.",
  perimee: 'Déjà tranchée, ou la question a changé.',
  deja_tranchee: 'Déjà tranchée, ou la question a changé.',
  option: 'Réponse refusée.',
};

function Decision({ agent, horsLigne }: { agent: Agent; horsLigne: boolean }) {
  const client = useAidClient();
  const [choix, setChoix] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const question = agent.question;
  if (!question) return <p>{"Une autorisation t'attend, sur le Mac"}</p>;
  const confirmer = async () => {
    if (horsLigne || envoi || choix === null) return;
    setEnvoi(true);
    try {
      await client.request(
        'POST',
        `/api/appareils/agents/${encodeURIComponent(agent.id)}/reponse`,
        { pendingId: question.pendingId, option: choix },
      );
      setMessage('Tranché');
    } catch (err) {
      setMessage(
        err instanceof AidApiError
          ? (REFUS[String(err.body.raison)] ?? 'Réponse refusée.')
          : 'Réponse refusée.',
      );
    } finally {
      setEnvoi(false);
    }
  };
  return (
    <>
      <p>
        {question.texte}
        {question.coupee && ' (texte coupé, la suite sur le Mac)'}
      </p>
      {message !== 'Tranché' && (
        <div className="appareil-actions">
          {question.options.map((option, index) => (
            <button
              key={index}
              disabled={horsLigne || envoi}
              aria-pressed={choix === index}
              onClick={() => setChoix(index)}
            >
              {option}
            </button>
          ))}
          {choix !== null && (
            <>
              <button disabled={horsLigne || envoi} onClick={() => void confirmer()}>
                Confirmer
              </button>
              <button disabled={horsLigne || envoi} onClick={() => setChoix(null)}>
                Annuler
              </button>
            </>
          )}
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}

function Tour({ agent, horsLigne }: { agent: Agent; horsLigne: boolean }) {
  const client = useAidClient();
  const [message, setMessage] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const tour = agent.tour!;
  const marquer = async (etat: 'relu' | 'a_reprendre') => {
    if (horsLigne || envoi) return;
    setEnvoi(true);
    try {
      await client.request('POST', `/api/appareils/agents/${encodeURIComponent(agent.id)}/tour`, {
        tourId: tour.id,
        etat,
      });
      setMessage(etat === 'relu' ? 'Tour relu' : 'À reprendre sur le Mac');
    } catch (err) {
      setMessage(
        err instanceof AidApiError && err.status === 409 ? 'Ce tour a changé.' : 'Marque refusée.',
      );
    } finally {
      setEnvoi(false);
    }
  };
  return (
    <>
      <p>{tour.resume}</p>
      {tour.marque === 'a_reprendre' && <p>À reprendre sur le Mac</p>}
      <div className="appareil-actions">
        <button disabled={horsLigne || envoi} onClick={() => void marquer('relu')}>
          Marquer relu
        </button>
        <button disabled={horsLigne || envoi} onClick={() => void marquer('a_reprendre')}>
          À reprendre sur le Mac
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </>
  );
}

export function AccueilAppareil() {
  const { appareil, horsLigne } = useAid();
  if (!appareil) return <main className="page" data-node="appareil.accueil" />;
  const runs = new Map(appareil.runs.map((r) => [r.id, r.topicId]));
  const sujets = new Map(appareil.topics.map((t) => [t.id, t]));
  const agents = appareil.agents.filter((a) => sujets.has(runs.get(a.runId) ?? ''));
  const decisions = agents.filter(
    (a) => a.question || (a.attend && a.statusReason === 'permission'),
  );
  const relectures = agents.filter((a) => a.tour && a.tour.marque !== 'relu');
  const enCours = agents.filter((a) => a.status === 'working' || a.status === 'starting');
  return (
    <main className="page appareil-accueil" data-node="appareil.accueil">
      <h1 className="titre-ecran">À traiter</h1>
      {decisions.length === 0 && (
        <div data-node="appareil.accueil.vide">
          <h2>{"Rien n'attend ta réponse"}</h2>
          <p>{"Tu seras prévenu dès qu'une décision arrive."}</p>
        </div>
      )}
      {[
        { titre: 'Décisions', liste: decisions },
        { titre: 'À relire', liste: relectures },
        { titre: 'En cours', liste: enCours },
      ].map(
        ({ titre, liste }) =>
          liste.length > 0 && (
            <section key={titre} aria-label={titre}>
              <h2 className="titre-zone">
                {titre} · {liste.length}
              </h2>
              <ul className="appareil-sujets">
                {liste.map((agent) => (
                  <li key={agent.id} data-node={`appareil.agent.${agent.id}`}>
                    <strong data-node={`appareil.sujet.${runs.get(agent.runId)}`}>
                      {sujets.get(runs.get(agent.runId)!)!.title}
                    </strong>
                    {titre === 'Décisions' && (
                      <Decision
                        key={agent.question?.pendingId}
                        agent={agent}
                        horsLigne={!!horsLigne}
                      />
                    )}
                    {titre === 'À relire' && (
                      <Tour key={agent.tour!.id} agent={agent} horsLigne={!!horsLigne} />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
      {!appareil.mesh?.state.cell && (
        <p className="texte-discret">
          {
            "Cet A-I-D n'est pas connecté à swarph : pas d'onglet Board. Pour le connecter, passe par ton Mac."
          }
        </p>
      )}
    </main>
  );
}
