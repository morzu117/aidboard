import { useRef, useState, useSyncExternalStore } from 'react';
import type { PropositionAid } from '../../../src/daemon/aid/propositions.js';
import type { ParametresEtat } from '../../../src/shared/etats.js';
import { libelleDeplacement, type ReponseDeplacement } from '../../../src/shared/deplacements.js';
import { boardStore, type BoardLecture } from '../data/board.js';
import { useAid, useAidClient } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { AttenteConfirmation } from './AttenteConfirmation.js';
import { AidApiError } from '../data/api.js';

const vide: BoardLecture<PropositionAid[]> = {
  result: null,
  erreur: null,
  enLecture: false,
  luA: null,
};
const sansAbonnement = () => () => {};
const lireVide = () => vide;
export function usePropositionsAid() {
  const client = useAidClient();
  const { state, appareil } = useAid();
  const magasin =
    state && !appareil
      ? boardStore<PropositionAid[]>(client, '/api/aid/propositions', () => null)
      : null;
  const lecture = useSyncExternalStore(
    magasin?.subscribe ?? sansAbonnement,
    magasin?.getSnapshot ?? lireVide,
  );
  return {
    propositions: Array.isArray(lecture.result) ? lecture.result : [],
    erreur: lecture.erreur,
    relire: () => magasin?.lire(),
  };
}
export function PropositionAidVue({
  proposition: p,
  relire,
  annoncer,
}: {
  proposition: PropositionAid;
  relire: () => void;
  annoncer?: (message: string) => void;
}) {
  const client = useAidClient();
  const { state } = useAid();
  const [apercu, setApercu] = useState<{
    params: ParametresEtat['carte.deplacer'];
    resume: string;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [resultat, setResultat] = useState<ReponseDeplacement | null>(null);
  const [erreur, setErreur] = useState('');
  const [envoye, setEnvoye] = useState(false);
  const verrou = useRef(false);
  async function ouvrir() {
    try {
      setApercu(await client.request('GET', `/api/aid/propositions/${p.id}/apercu`));
      setConfirmation(null);
      setResultat(null);
      setErreur('');
      setEnvoye(false);
      verrou.current = false;
    } catch {
      setErreur('Déplacement indisponible. Relis la carte.');
    }
  }
  async function envoyer() {
    if (verrou.current || !apercu) return;
    verrou.current = true;
    setEnvoye(true);
    try {
      const r = await client.request<{ confirmation: string }>('POST', '/api/swarph/etat/envoyer', {
        mesh: 'principal',
        action: 'carte.deplacer',
        params: apercu.params,
        propositionAid: p.id,
      });
      setConfirmation(r.confirmation);
    } catch (e) {
      setErreur(
        e instanceof AidApiError && e.body.error === 'confirmation_requise'
          ? 'Confirmation du téléphone requise : arme la porte.'
          : e instanceof AidApiError && e.body.error === 'proxy_lecture_seule'
            ? 'Le proxy est en lecture seule.'
            : 'Déplacement indisponible. Relis la carte.',
      );
    }
  }
  return (
    <article className="element">
      <h3>
        Déplacer la carte #{p.carte} vers {p.etape}
      </h3>
      <button onClick={() => void ouvrir()}>Ouvrir</button>
      <button
        onClick={() =>
          void client
            .request('DELETE', `/api/aid/propositions/${p.id}`)
            .then(relire, () => setErreur('Impossible d’ignorer la proposition.'))
        }
      >
        Ignorer
      </button>
      {erreur && <p role="alert">{erreur}</p>}
      {apercu && (
        <Dialogue titre="Déplacer la carte" onClose={() => setApercu(null)}>
          <p>{apercu.resume}</p>
          <button disabled={envoye || !state?.mesh?.state.ecritures} onClick={() => void envoyer()}>
            Envoyer
          </button>
          {confirmation && (
            <AttenteConfirmation
              id={confirmation}
              toujours
              onTerminee={(d) => {
                if (d?.envoi) setResultat(d.envoi);
                if (d?.resultat === 'executee' && d.envoi?.code === 'succes') {
                  annoncer?.(libelleDeplacement(d.envoi));
                  relire();
                }
              }}
            />
          )}
          {resultat && <p role="status">{libelleDeplacement(resultat)}</p>}
          <button onClick={() => setApercu(null)}>Fermer</button>
        </Dialogue>
      )}
    </article>
  );
}
