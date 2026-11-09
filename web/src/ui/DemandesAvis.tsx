import { useState } from 'react';
import type { Ask, AskResult } from '../../../src/shared/swairm-ask.js';
import { relireAsk, useAsks, useEtatAsk } from '../data/swairm.js';
import { useAidClient } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { TableauAvis } from '../ecrans/TableauAvis.js';
import { DemanderAvis } from './DemanderAvis.js';

/** Les lectures vivent sur l'écran, jamais à l'ouverture de la boîte de saisie. */
export function DemandesAvis() {
  const client = useAidClient();
  const etat = useEtatAsk();
  const liste = useAsks();
  const [ouverte, setOuverte] = useState(false);
  const [resultat, setResultat] = useState<AskResult<Ask> | null>(null);
  const [erreur, setErreur] = useState('');
  async function ouvrir(id: string) {
    setErreur('');
    try {
      setResultat(await relireAsk(id, client));
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    }
  }
  const demandes = liste.result && 'data' in liste.result ? liste.result.data.demandes : [];
  return (
    <section className="groupe" aria-label="Demandes d’avis">
      <button
        className="bouton"
        data-node="swarph.ask"
        disabled={!etat.result}
        onClick={() => setOuverte(true)}
      >
        Demander N avis
      </button>
      {etat.erreur && <p role="alert">{etat.erreur}</p>}
      {liste.erreur && <p role="alert">{liste.erreur}</p>}
      {erreur && <p role="alert">{erreur}</p>}
      <ul>
        {demandes.map((demande) => (
          <li key={demande.id}>
            <button onClick={() => void ouvrir(demande.id)}>
              <time dateTime={demande.genere_a}>
                {new Date(demande.genere_a).toLocaleString('fr-FR')}
              </time>{' '}
              — {demande.question} — {demande.accord.map((a) => `${a.n}. ${a.accord}`).join(', ')}
            </button>
          </li>
        ))}
      </ul>
      {ouverte && etat.result && (
        <DemanderAvis
          etat={etat.result}
          onClose={() => setOuverte(false)}
          onResultat={() => {
            void liste.relire();
            void etat.relire();
          }}
        />
      )}
      {resultat && (
        <Dialogue titre="Avis archivés" onClose={() => setResultat(null)}>
          <TableauAvis resultat={resultat} />
          <button autoFocus onClick={() => setResultat(null)}>
            Fermer
          </button>
        </Dialogue>
      )}
    </section>
  );
}
