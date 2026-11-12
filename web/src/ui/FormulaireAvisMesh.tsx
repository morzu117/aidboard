import { useState } from 'react';
import { validerQuestionMesh } from '../../../src/shared/charter-avis.js';
import {
  demanderAvisMesh,
  type EcheancesAvisMesh,
  type DemandeAvisMesh,
} from '../data/avis-mesh.js';
import { useBoardCard } from '../data/board.js';
import { useCells } from '../data/swarph.js';
import { useAid, useAidClient } from '../data/useAidState.js';

/** Les durées des tours successifs deviennent des dates au moment du clic. */
function daterEcheances(
  heures: { positions: number; rebuttal: number; vote: number },
  tours: { rebuttal: boolean; vote: boolean },
): EcheancesAvisMesh {
  const echeances: EcheancesAvisMesh = {
    positions: new Date(Date.now() + heures.positions * 3600000).toISOString(),
  };
  let fin = Date.parse(echeances.positions);
  for (const tour of ['rebuttal', 'vote'] as const) {
    if (tours[tour]) {
      fin += heures[tour] * 3600000;
      echeances[tour] = new Date(fin).toISOString();
    }
  }
  return echeances;
}

function TitreCarte({ numero, onCarte }: { numero: number; onCarte: (numero: number) => void }) {
  const lecture = useBoardCard(numero);
  const carte = lecture.result?.card;
  // Le titre et l'autorisation d'envoi proviennent de la même réponse, pour ce numéro.
  return (
    <>
      <p>{carte?.ok && carte.data.id === numero ? carte.data.title : 'carte inconnue'}</p>
      <button
        type="button"
        disabled={!carte?.ok || carte.data.id !== numero}
        onClick={() => onCarte(numero)}
      >
        Confirmer la carte
      </button>
      {lecture.erreur && <p role="alert">{lecture.erreur}</p>}
    </>
  );
}
export function FormulaireAvisMesh({ onResultat }: { onResultat?: () => void }) {
  const client = useAidClient();
  const { state } = useAid();
  const lecture = useCells();
  const [question, setQuestion] = useState('');
  const [cells, setCells] = useState<string[]>([]);
  const [numero, setNumero] = useState('');
  const [carte, setCarte] = useState<number | null>(null);
  const [heures, setHeures] = useState({ positions: 24, rebuttal: 24, vote: 24 });
  const [tours, setTours] = useState({ rebuttal: false, vote: false });
  const [attente, setAttente] = useState(false);
  const [erreur, setErreur] = useState('');
  const [resultat, setResultat] = useState<DemandeAvisMesh | null>(null);
  const connectee = state?.mesh?.state.connected === true;
  const pairs = lecture.result?.peers;
  const noms = pairs?.ok
    ? [...new Set(pairs.data.map((p) => p.nom))].filter((nom) => nom !== state?.mesh?.state.cell)
    : [];
  const choisies = cells.filter((nom) => noms.includes(nom));
  const validation = validerQuestionMesh(question);
  const raison = !connectee
    ? 'La cell doit être connectée.'
    : !question.trim()
      ? 'Écris une question.'
      : !validation.ok
        ? `Question refusée : ${validation.classe}`
        : choisies.length < 2 || choisies.length > 8
          ? 'Choisis de 2 à 8 cells.'
          : carte !== Number(numero) || carte === null
            ? 'Choisis une carte connue et confirme son titre.'
            : Object.entries(heures).some(
                  ([tour, h]) =>
                    (tour === 'positions' || tours[tour as keyof typeof tours]) &&
                    (!Number.isFinite(h) || h < 1 || h > 168),
                )
              ? 'Chaque échéance doit être comprise entre 1 h et 7 j.'
              : '';
  async function envoyer() {
    if (raison || attente || carte === null) return;
    setAttente(true);
    setErreur('');
    const echeances = daterEcheances(heures, tours);
    try {
      setResultat(await demanderAvisMesh({ question, cells: choisies, carte, echeances }, client));
      onResultat?.();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setAttente(false);
    }
  }
  return (
    <>
      {resultat ? (
        <p role="status">
          Demande {resultat.id} — {resultat.etat}
        </p>
      ) : (
        <>
          <fieldset disabled={attente}>
            <label>
              Question <textarea value={question} onChange={(e) => setQuestion(e.target.value)} />
            </label>
            <p>Numérote les sous-questions : 1. 2. 3.</p>
            <fieldset>
              <legend>Cells</legend>
              {noms.map((nom) => (
                <label key={nom}>
                  <input
                    type="checkbox"
                    checked={choisies.includes(nom)}
                    disabled={choisies.length >= 8 && !choisies.includes(nom)}
                    onChange={(e) =>
                      setCells(
                        e.target.checked ? [...choisies, nom] : choisies.filter((n) => n !== nom),
                      )
                    }
                  />
                  {nom}
                </label>
              ))}
            </fieldset>
            <label>
              Numéro de carte{' '}
              <input
                type="number"
                min="1"
                step="1"
                value={numero}
                onChange={(e) => {
                  setNumero(e.target.value);
                  setCarte(null);
                }}
              />
            </label>
            {Number.isSafeInteger(Number(numero)) && Number(numero) > 0 && (
              <TitreCarte key={numero} numero={Number(numero)} onCarte={setCarte} />
            )}
            {(['positions', 'rebuttal', 'vote'] as const).map((tour) => (
              <div key={tour}>
                {tour !== 'positions' && (
                  <label>
                    <input
                      type="checkbox"
                      checked={tours[tour]}
                      onChange={(e) => setTours({ ...tours, [tour]: e.target.checked })}
                    />
                    Activer {tour}
                  </label>
                )}
                <label>
                  Durée {tour} (heures){' '}
                  <input
                    type="number"
                    min="1"
                    max="168"
                    value={heures[tour]}
                    disabled={tour !== 'positions' && !tours[tour]}
                    onChange={(e) => setHeures({ ...heures, [tour]: Number(e.target.value) })}
                  />
                </label>
              </div>
            ))}
          </fieldset>
          <p>
            Le texte part dans le mesh, vers les cells choisies et le gateway. N’y mets ni secret,
            ni contenu de carte, ni nom de client.
          </p>
          {raison && <p role="status">{raison}</p>}
          <button disabled={!!raison || attente} onClick={() => void envoyer()}>
            Envoyer
          </button>
        </>
      )}
      {lecture.erreur && <p role="alert">{lecture.erreur}</p>}
      {erreur && <p role="alert">{erreur}</p>}
    </>
  );
}
