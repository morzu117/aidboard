import { useEffect, useRef, useState } from 'react';
import {
  MODELES_ASK,
  type Ask,
  type AskResult,
  type ModeleAsk,
} from '../../../src/shared/swairm-ask.js';
import { AidApiError } from '../data/api.js';
import { annulerAvis, demanderAvis, type EtatAsk } from '../data/swairm.js';
import { FormulaireAvisMesh } from './FormulaireAvisMesh.js';
import { useAid, useAidClient } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { TableauAvis } from '../ecrans/TableauAvis.js';

export function DemanderAvis({
  etat,
  onClose,
  onResultat,
}: {
  etat: EtatAsk;
  onClose: () => void;
  onResultat?: () => void;
}) {
  const client = useAidClient();
  const { state } = useAid();
  const [destination, setDestination] = useState('mac');
  const mesh = destination === 'mesh' && state?.mesh?.state.connected;
  const [question, setQuestion] = useState('');
  const [n, setN] = useState(3);
  const [modeles, setModeles] = useState<ModeleAsk[]>(['sonnet', 'opus']);
  const [depuis, setDepuis] = useState<string | null>(etat.enCours ? etat.depuis : null);
  const [attente, setAttente] = useState(etat.enCours);
  const [maintenant, setMaintenant] = useState(() => Date.now());
  const [erreur, setErreur] = useState('');
  const [resultat, setResultat] = useState<AskResult<Ask> | null>(null);
  const cadre = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const avant = document.activeElement as HTMLElement | null;
    cadre.current?.querySelector<HTMLElement>('textarea, button')?.focus();
    return () => avant?.focus();
  }, []);
  useEffect(() => {
    if (!attente) return;
    const minuterie = setInterval(() => setMaintenant(Date.now()), 1000);
    return () => clearInterval(minuterie);
  }, [attente]);
  async function envoyer() {
    if (attente || !question.trim() || !modeles.length) return;
    setAttente(true);
    setDepuis(new Date().toISOString());
    setMaintenant(Date.now());
    setErreur('');
    try {
      setResultat(await demanderAvis({ question, n, modeles }, client));
      onResultat?.();
    } catch (e) {
      setErreur(
        e instanceof AidApiError && e.status === 409
          ? 'Une demande est déjà en cours.'
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setAttente(false);
    }
  }
  async function annuler() {
    try {
      await annulerAvis(client);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <Dialogue titre="Demander N avis" onClose={onClose}>
      <div
        ref={cadre}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return;
          const elements = cadre.current?.querySelectorAll<HTMLElement>(
            'textarea:enabled, input:enabled, select:enabled, button:enabled, summary',
          );
          if (!elements?.length) return;
          const premier = elements[0]!;
          const dernier = elements[elements.length - 1]!;
          if (e.shiftKey && document.activeElement === premier) {
            e.preventDefault();
            dernier.focus();
          } else if (!e.shiftKey && document.activeElement === dernier) {
            e.preventDefault();
            premier.focus();
          }
        }}
      >
        {state?.mesh?.state.connected && !attente && !resultat && (
          <div aria-label="Destination">
            <button aria-pressed={!mesh} onClick={() => setDestination('mac')}>
              Au Mac
            </button>
            <button aria-pressed={!!mesh} onClick={() => setDestination('mesh')}>
              Au mesh
            </button>
          </div>
        )}
        {mesh ? (
          <FormulaireAvisMesh onResultat={onResultat} />
        ) : resultat ? (
          <TableauAvis resultat={resultat} />
        ) : (
          <>
            <fieldset disabled={attente}>
              <label>
                Question{' '}
                <textarea
                  aria-describedby="ask-aide"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </label>
              <p id="ask-aide">Numérote les sous-questions : 1. 2. 3.</p>
              <label>
                N{' '}
                <select value={n} onChange={(e) => setN(Number(e.target.value))}>
                  {[1, 2, 3, 4, 5].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend>Modèles</legend>
                {MODELES_ASK.map((modele) => (
                  <label key={modele}>
                    <input
                      type="checkbox"
                      checked={modeles.includes(modele)}
                      onChange={(e) =>
                        setModeles(
                          e.target.checked
                            ? [...modeles, modele]
                            : modeles.filter((m) => m !== modele),
                        )
                      }
                    />
                    {modele}
                  </label>
                ))}
              </fieldset>
            </fieldset>
            <p>Coût maximal : {(n * etat.budgetUsd).toFixed(2)} USD</p>
            <p>
              Le texte part chez le fournisseur de Swairm. N&apos;y mets ni secret ni contenu de
              carte.
            </p>
            {attente ? (
              <>
                <p role="status">
                  Temps écoulé :{' '}
                  {depuis ? Math.max(0, Math.floor((maintenant - Date.parse(depuis)) / 1000)) : 0} s
                </p>
                <button onClick={() => void annuler()}>Annuler</button>
              </>
            ) : (
              <button disabled={!question.trim() || !modeles.length} onClick={() => void envoyer()}>
                Envoyer
              </button>
            )}
          </>
        )}
        {erreur && <p role="alert">{erreur}</p>}
        <button onClick={onClose}>Fermer</button>
      </div>
    </Dialogue>
  );
}
