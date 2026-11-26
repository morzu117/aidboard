import { limitesBoucle } from '../../../src/shared/limites-boucle.js';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ServiceBoucle } from '../../../src/daemon/boucle/service.js';
import { useAidClient } from '../data/useAidState.js';
import { useConfirmation } from '../ui/AttenteConfirmation.js';

type VueBoucle = ReturnType<ServiceBoucle['lire']>;
const LIBELLES = {
  plan: 'Plan',
  attente_go: 'En attente du GO',
  acceptation: 'Acceptation',
  dev: 'Dev',
  gate: 'Gate',
  revue: 'Revue',
  triage: 'Triage',
  livraison_prete: 'Livraison prête',
  escalade: 'Escalade',
  arretee: 'Arrêtée',
};

export function Boucle({ sujetId }: { sujetId: string }) {
  const client = useAidClient();
  const chemin = `/api/topics/${encodeURIComponent(sujetId)}/boucle`;
  const [vue, setVue] = useState<VueBoucle>();
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [reponse, setReponse] = useState('');
  const actualiser = useCallback(async () => {
    setVue(await client.request<VueBoucle>('GET', chemin));
  }, [client, chemin]);
  const confirmation = useConfirmation(actualiser, true);
  const occupée = enCours || Boolean(confirmation.id && !confirmation.terminee);

  useEffect(() => {
    let monte = true;
    let lecture = false;
    async function lire() {
      if (lecture) return;
      lecture = true;
      try {
        const projection = await client.request<VueBoucle>('GET', chemin);
        if (monte) setVue(projection);
      } catch (e) {
        if (monte) setErreur(e instanceof Error ? e.message : String(e));
      } finally {
        lecture = false;
      }
    }
    void lire();
    const timer = setInterval(() => void lire(), 700);
    return () => {
      monte = false;
      clearInterval(timer);
    };
  }, [client, chemin]);

  async function envoyer(suffixe: string, corps = {}) {
    setEnCours(true);
    setErreur('');
    try {
      const resultat = await client.request<{ confirmation?: string }>(
        'POST',
        chemin + suffixe,
        corps,
      );
      if (confirmation.recevoir(resultat)) return;
      if (suffixe === '/reponse') setReponse('');
      await actualiser();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setEnCours(false);
    }
  }

  function repondre(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void envoyer('/reponse', { reponse: reponse.trim() });
  }

  return (
    <section className="sujet-boucle" aria-label="Boucle">
      <p>{limitesBoucle}</p>
      {erreur && (
        <p role="alert" className="bandeau-erreur">
          {erreur}
        </p>
      )}
      {confirmation.attente}
      {vue && (
        <>
          <h2 className="titre-panneau" data-testid="boucle-phase" aria-live="polite">
            {vue.phase ? LIBELLES[vue.phase] : 'Aucune boucle'}
          </h2>
          {(!vue.phase || vue.phase === 'arretee' || vue.phase === 'livraison_prete') && (
            <button
              type="button"
              className="bouton bouton--primaire"
              data-testid="boucle-lancer"
              data-node="boucle-lancer"
              disabled={occupée}
              onClick={() => void envoyer('')}
            >
              Lancer
            </button>
          )}
          {vue.plan && <p className="sujet-boucle-plan">{vue.plan}</p>}
          {vue.phase === 'attente_go' && (
            <button
              type="button"
              className="bouton bouton--primaire"
              data-testid="boucle-go"
              data-node="boucle-go"
              disabled={occupée}
              onClick={() => void envoyer('/go')}
            >
              GO
            </button>
          )}
          {vue.escalade?.question && (
            <form className="sujet-boucle-reponse" onSubmit={repondre}>
              <p>{vue.escalade.question}</p>
              <label>
                Réponse
                <input
                  className="champ"
                  data-testid="boucle-reponse"
                  data-node="boucle-reponse"
                  value={reponse}
                  onChange={(event) => setReponse(event.target.value)}
                  maxLength={4096}
                  disabled={occupée}
                />
              </label>
              <button
                type="submit"
                className="bouton bouton--primaire"
                data-testid="boucle-envoyer-reponse"
                data-node="boucle-envoyer-reponse"
                disabled={occupée || !reponse.trim()}
              >
                Envoyer la réponse
              </button>
            </form>
          )}
          {vue.escalade && !vue.escalade.question && <p>{vue.escalade.raison}</p>}
          {vue.escalade?.constats?.length ? (
            <ul>
              {vue.escalade.constats.map((constat) => (
                <li key={constat}>{constat}</li>
              ))}
            </ul>
          ) : null}
          {vue.etapeCourante && (
            <div>
              <p>
                Tentative {vue.etapeCourante.tentative}{' '}
                {vue.etapeCourante.teteDepart && (
                  <code title={vue.etapeCourante.teteDepart}>
                    {vue.etapeCourante.teteDepart.slice(0, 12)}
                  </code>
                )}
              </p>
              <button
                type="button"
                className="bouton bouton--danger"
                data-testid="boucle-arreter"
                data-node="boucle-arreter"
                disabled={occupée}
                onClick={() => void envoyer('/arreter')}
              >
                Arrêter
              </button>
            </div>
          )}
          {vue.historique.length > 0 && (
            <div data-testid="boucle-historique">
              <h3 className="titre-panneau">Historique</h3>
              <ul>
                {vue.historique.map((etape) => {
                  const tete = etape.teteArrivee ?? etape.teteDepart;
                  return (
                    <li key={`${etape.type}-${etape.tentative}`}>
                      {LIBELLES[etape.type]} · tentative {etape.tentative} · {etape.issue}{' '}
                      {etape.route && <>· {etape.route} </>}
                      {tete && <code title={tete}>{tete.slice(0, 12)}</code>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {vue.phase && (
            <div>
              <h3 className="titre-panneau">Mesures</h3>
              <dl className="sujet-boucle-mesures">
                <dt>Interventions humaines</dt>
                <dd>{vue.mesures.interventionsHumaines}</dd>
                <dt>Re-dev</dt>
                <dd>{vue.mesures.redevs}</dd>
                {Object.entries(vue.mesures.tempsParEtapeMs).map(([etape, duree]) => (
                  <div key={etape}>
                    <dt>{LIBELLES[etape as keyof typeof LIBELLES]}</dt>
                    <dd>{Math.round(duree)} ms</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </>
      )}
    </section>
  );
}
