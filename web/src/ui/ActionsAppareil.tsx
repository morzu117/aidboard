import { useState } from 'react';
import type { EtatPourAppareil } from '../../../src/shared/host.js';
import { AidApiError } from '../data/api.js';
import { useAidClient } from '../data/useAidState.js';

type Agent = EtatPourAppareil['agents'][number];
const REFUS: Record<string, string> = {
  mode: 'Cet agent accepte seul ses actions : tranche sur le Mac.',
  nature: "C'est une autorisation : elle se donne sur le Mac.",
  perimee: 'Déjà tranchée, ou la question a changé.',
  deja_tranchee: 'Déjà tranchée, ou la question a changé.',
  option: 'Réponse refusée.',
};

export function Decision({ agent, horsLigne }: { agent: Agent; horsLigne: boolean }) {
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

export function Tour({ agent, horsLigne }: { agent: Agent; horsLigne: boolean }) {
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
