import { useState } from 'react';
import { lireAvisMesh, useDemandesAvisMesh, type ResultatAvisMesh } from '../data/avis-mesh.js';
import { useAidClient } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { TableauAvisMesh } from '../ecrans/TableauAvisMesh.js';

/** Liste sœur : les demandes mesh ont leur propre état, carte et cycle de lecture. */
export function DemandesAvisMesh() {
  const client = useAidClient();
  const liste = useDemandesAvisMesh();
  const [id, setId] = useState<string | null>(null);
  const [resultat, setResultat] = useState<ResultatAvisMesh | null>(null);
  const [attente, setAttente] = useState(false);
  const [erreur, setErreur] = useState('');
  async function ouvrir(demande: string) {
    setAttente(true);
    setErreur('');
    try {
      setResultat(await lireAvisMesh(demande, client));
      setId(demande);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setAttente(false);
    }
  }
  return (
    <section aria-label="Demandes au mesh">
      <h3>Demandes au mesh</h3>
      <button onClick={() => void liste.relire()}>Relire les demandes au mesh</button>
      {liste.erreur && <p role="alert">{liste.erreur}</p>}
      {erreur && <p role="alert">{erreur}</p>}
      <ul>
        {liste.result?.demandes?.map((demande) => (
          <li key={demande.id}>
            <button disabled={attente} onClick={() => void ouvrir(demande.id)}>
              <time dateTime={demande.date}>{new Date(demande.date).toLocaleString('fr-FR')}</time>{' '}
              — {demande.cells.join(', ')} — Carte {demande.carte} — {demande.etat}
            </button>
          </li>
        ))}
      </ul>
      {resultat && id && (
        <Dialogue
          titre="Avis au mesh"
          onClose={() => {
            setResultat(null);
            setId(null);
          }}
        >
          <button disabled={attente} onClick={() => void ouvrir(id)}>
            Relire
          </button>
          <TableauAvisMesh resultat={resultat} />
          <button
            autoFocus
            onClick={() => {
              setResultat(null);
              setId(null);
            }}
          >
            Fermer
          </button>
        </Dialogue>
      )}
    </section>
  );
}
