import { useState } from 'react';
import {
  commandeSwairm,
  libelleSwairm,
  ligneSwairm,
  useSwairmBoard,
  type SujetBoardSwairm,
} from '../data/swairm-board.js';

function Etat({ sujet }: { sujet: SujetBoardSwairm }) {
  return (
    <span className={sujet.conflit.length === 0 ? 'board-pastille' : undefined}>
      {sujet.conflit.length > 0
        ? `Lien en double : cartes ${sujet.conflit.map((id) => `#${id}`).join(', ')}.`
        : `Swairm · ${libelleSwairm(sujet.etat)}`}
    </span>
  );
}

export function SwairmCarte({ carte, fiche = false }: { carte: number; fiche?: boolean }) {
  const { result } = useSwairmBoard();
  return (
    <>
      {result?.sujets
        ?.filter((s) => s.carte === carte || s.conflit.includes(carte))
        .map((s) => (
          <section className={fiche ? 'carte-board-bloc' : undefined} key={`${s.projet}#${s.id}`}>
            <Etat sujet={s} />
            {fiche && (
              <>
                <h2>Swairm</h2>
                <dl>
                  <dt>Projet</dt>
                  <dd>{s.projet}</dd>
                  <dt>Id</dt>
                  <dd>{s.id}</dd>
                  <dt>Colonne</dt>
                  <dd>{s.colonne}</dd>
                  <dt>Pas : total</dt>
                  <dd>{s.pas.total}</dd>
                  {Object.entries(s.pas.par_etat).map(([etat, nombre]) => (
                    <div key={etat}>
                      <dt>{etat}</dt>
                      <dd>{nombre}</dd>
                    </div>
                  ))}
                  <dt>maj</dt>
                  <dd>{s.maj}</dd>
                </dl>
                {s.en_pause && <p>en pause</p>}
                {s.vol && (
                  <p>
                    Vol en cours : {s.vol.machine} · depuis {s.vol.depuis}
                  </p>
                )}
              </>
            )}
          </section>
        ))}
    </>
  );
}

export function ErreursSwairm() {
  const { result, erreur } = useSwairmBoard();
  return (
    <>
      {erreur && <p role="alert">Swairm : {erreur}.</p>}
      {result?.swairm?.etat === 'non-configure' && <p>{"Swairm n'est pas configuré."}</p>}
      {result?.swairm?.etat === 'erreur' && <p role="alert">Swairm : {result.swairm.erreur}.</p>}
      {result?.swairm?.etat === 'ok' &&
        result.swairm.data.erreurs.map((e, i) => (
          <p role="alert" key={i}>
            Swairm : {e.erreur}.
          </p>
        ))}
      {result?.board && !result.board.ok && (
        <p role="alert">{"Les liens n'ont pas pu être lus."}</p>
      )}
    </>
  );
}

export function SansCarteSwairm() {
  const { result } = useSwairmBoard();
  const [message, setMessage] = useState('');
  const sansCarte = result?.sujets?.filter((s) => s.carte === null && s.conflit.length === 0) ?? [];
  const termines = sansCarte.filter((s) => s.etat === 'merged' || s.etat === 'abandoned');
  const vivants = sansCarte.filter((s) => s.etat !== 'merged' && s.etat !== 'abandoned');
  async function copier(texte: string) {
    try {
      await navigator.clipboard.writeText(texte);
      setMessage('Copié.');
    } catch {
      setMessage('Copie impossible : accès au presse-papiers refusé.');
    }
  }
  return (
    <section>
      <ErreursSwairm />
      <details>
        <summary>Sujets Swairm sans carte ({vivants.length})</summary>
        <p>{termines.length} sujets merged ou abandoned sans carte non listés.</p>
        <ul>
          {vivants.map((s) => (
            <li key={`${s.projet}#${s.id}`}>
              <span>
                {s.projet}#{s.id} · {s.titre} · {libelleSwairm(s.etat)}
              </span>
              <button onClick={() => void copier(ligneSwairm(s))}>Copier la ligne</button>
              <button onClick={() => void copier(commandeSwairm(s))}>Copier la commande</button>
            </li>
          ))}
        </ul>
        <p role="status">{message}</p>
      </details>
    </section>
  );
}
