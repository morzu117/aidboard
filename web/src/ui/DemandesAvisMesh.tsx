import { instantaneMesh } from '../data/meshLecture.js';
import { useAid } from '../data/useAidState.js';
import { EnteteMesh } from './SelecteurMesh.js';
import { DureesAvis, daterEcheances } from './FormulaireAvisMesh.js';
import { useConfirmation } from './AttenteConfirmation.js';
import { useState } from 'react';
import {
  agirAvisMesh,
  ETATS_AVIS,
  lireAvisMesh,
  useDemandesAvisMesh,
  type ResultatAvisMesh,
} from '../data/avis-mesh.js';
import { useAidClient } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { TableauAvisMesh } from '../ecrans/TableauAvisMesh.js';

/** Liste sœur : les demandes mesh ont leur propre état, carte et cycle de lecture. */
export function DemandesAvisMesh({ mesh }: { mesh: string }) {
  return <ListeDemandesMesh key={mesh} mesh={mesh} />;
}

type SalleMesh = { id: string; mesh: string };

function ListeDemandesMesh({ mesh }: { mesh: string }) {
  const { state } = useAid();
  const client = useAidClient();
  const liste = useDemandesAvisMesh(mesh);
  const [id, setId] = useState<string | null>(null);
  const [resultat, setResultat] = useState<(ResultatAvisMesh & { mesh: string }) | null>(null);
  const [attente, setAttente] = useState(false);
  const [erreur, setErreur] = useState('');
  const [luA, setLuA] = useState(0);
  const confirmation = useConfirmation(() => liste.relire(), true);
  const [reprise, setReprise] = useState<SalleMesh | null>(null);
  const [heures, setHeures] = useState({ positions: 24, rebuttal: 1, vote: 1 });
  async function agir(salle: SalleMesh, action: 'motion' | 'baseline-absent') {
    setAttente(true);
    setErreur('');
    try {
      confirmation.recevoir(
        await agirAvisMesh(
          salle.id,
          action,
          client,
          action === 'motion' ? daterEcheances(heures) : undefined,
          salle.mesh,
        ),
      );
      setReprise(null);
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setAttente(false);
    }
  }
  async function ouvrir(demande: SalleMesh) {
    setAttente(true);
    setErreur('');
    try {
      setResultat({
        ...(await lireAvisMesh(demande.id, client, demande.mesh)),
        mesh: demande.mesh,
      });
      setLuA(Date.now);
      setId(demande.id);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setAttente(false);
    }
  }
  return (
    <section aria-label="Demandes au mesh">
      <h3>Demandes au mesh</h3>
      <EnteteMesh mesh={mesh} />
      <button onClick={() => void liste.relire()}>Relire les demandes au mesh</button>
      {liste.erreur && <p role="alert">{liste.erreur}</p>}
      {erreur && <p role="alert">{erreur}</p>}
      <ul>
        {liste.result?.demandes?.map((demande) => (
          <li key={demande.id}>
            <button disabled={attente} onClick={() => void ouvrir(demande)}>
              <time dateTime={demande.date}>{new Date(demande.date).toLocaleString('fr-FR')}</time>{' '}
              — {demande.cells.join(', ')} — Carte {demande.carte} —{' '}
              {ETATS_AVIS[demande.etat] ?? demande.etat}
            </button>
            {demande.erreur && (
              <p role="alert">
                {demande.erreur.status} — {demande.erreur.message}
              </p>
            )}
            {demande.etat === 'confirmation' && demande.confirmation && (
              <button onClick={() => confirmation.recevoir(demande)}>Suivre la confirmation</button>
            )}
            {demande.etat === 'salle-sans-motion' && (
              <button
                disabled={attente}
                onClick={() => {
                  setReprise(demande);
                  setHeures({ positions: 24, rebuttal: 1, vote: 1 });
                }}
              >
                Rouvrir la motion
              </button>
            )}
          </li>
        ))}
      </ul>
      {confirmation.attente}
      {reprise && (
        <section aria-label="Nouvelles durées">
          <DureesAvis heures={heures} onChange={setHeures} />
          <button
            disabled={
              attente || Object.values(heures).some((h) => !Number.isFinite(h) || h < 1 || h > 168)
            }
            onClick={() => void agir(reprise, 'motion')}
          >
            Envoyer la motion
          </button>
        </section>
      )}
      {resultat && id && (
        <Dialogue
          titre="Avis au mesh"
          onClose={() => {
            setResultat(null);
            setId(null);
          }}
        >
          <button disabled={attente} onClick={() => void ouvrir({ id, mesh: resultat.mesh })}>
            Relire
          </button>
          {resultat.phase === 'positions' &&
            luA > Date.parse(resultat.echeances.positions) &&
            resultat.baseline?.etat === 'attendu' && (
              <button
                disabled={attente}
                onClick={() => void agir({ id, mesh: resultat.mesh }, 'baseline-absent')}
              >
                Déclarer le baseline absent
              </button>
            )}
          <TableauAvisMesh
            resultat={resultat}
            cellLocale={instantaneMesh(state, resultat.mesh)?.state.cell}
          />
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
