import { useState, useSyncExternalStore } from 'react';
import type { PropositionSwairm } from '../../../src/daemon/swairm/propositions.js';
import { boardStore, type BoardLecture } from '../data/board.js';
import { libelleSwairm } from '../data/swairm-board.js';
import { useAid, useAidClient } from '../data/useAidState.js';
import { EcrireAuMesh } from './EcrireAuMesh.js';

const vide: BoardLecture<PropositionSwairm[]> = {
  result: null,
  erreur: null,
  enLecture: false,
  luA: null,
};
const sansAbonnement = () => () => {};
const lireVide = () => vide;

export function usePropositionsSwairm() {
  const client = useAidClient();
  const { state, appareil } = useAid();
  const magasin =
    state && !appareil
      ? boardStore<PropositionSwairm[]>(client, '/api/swairm/propositions', () => null)
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

export function PropositionSwairmVue({
  proposition: p,
  relire,
}: {
  proposition: PropositionSwairm;
  relire: () => void;
}) {
  const client = useAidClient();
  const [ouverte, setOuverte] = useState(false);
  const [erreur, setErreur] = useState('');
  async function ignorer() {
    try {
      await client.request('DELETE', `/api/swairm/propositions/${p.id}`);
      relire();
    } catch {
      setErreur('Impossible d’ignorer la proposition. Réessaie.');
    }
  }
  return (
    <article className="element">
      <h3>Proposer une note sur la carte #{p.carte}</h3>
      <p>
        {p.titre} · {libelleSwairm(p.etat)}
      </p>
      <button onClick={() => setOuverte(true)}>Ouvrir</button>
      <button onClick={() => void ignorer()}>Ignorer</button>
      {erreur && <p role="alert">{erreur}</p>}
      {ouverte && (
        <EcrireAuMesh
          mesh={p.mesh}
          action="carte.note"
          propositionSwairm={p.id}
          valeurs={{
            carte: p.carte,
            texte: `Swairm : ${p.titre} — ${libelleSwairm(p.etat)}.`,
            kind: 'fyi',
          }}
          onClose={() => setOuverte(false)}
          onEnvoye={() => {
            setOuverte(false);
            relire();
          }}
        />
      )}
    </article>
  );
}
