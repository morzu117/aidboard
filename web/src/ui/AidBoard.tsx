import { liensAid } from '../../../src/shared/aid-board.js';
import { useState } from 'react';
import { Link } from 'react-router';
import { libelleAid, useAidBoard } from '../data/aid-board.js';
import { useAid } from '../data/useAidState.js';
import { PHASES } from './rangement.js';
import { pluriel } from './pluriel.js';

export function ErreursAid() {
  const { result, erreur } = useAidBoard();
  return erreur || (result?.board && !result.board.ok) || (result?.erreurs?.length ?? 0) > 0 ? (
    <p role="alert">{"Les liens A-I-D n'ont pas pu être lus."}</p>
  ) : null;
}

export function AidCarte({ carte, fiche = false }: { carte: number; fiche?: boolean }) {
  const { result } = useAidBoard();
  const { state } = useAid();
  return (
    <>
      {result?.sujets
        ?.filter((s) => s.carte === carte || s.conflit.includes(carte))
        .map((s) => (
          <section className={fiche ? 'carte-board-bloc' : undefined} key={s.sujetId}>
            {s.conflit.length > 0 ? (
              <span>{`Lien A-I-D en double : cartes ${s.conflit.map((id) => `#${id}`).join(', ')}.`}</span>
            ) : (
              <>
                <span className="board-pastille">A-I-D · {libelleAid(s.state)}</span>
                {fiche && (
                  <>
                    <h2>A-I-D</h2>
                    <dl>
                      <dt>Workspace</dt>
                      <dd>
                        {state?.workspaces.find((w) => w.id === s.workspace)?.name ?? s.workspace}
                      </dd>
                      <dt>Branche</dt>
                      <dd>{s.branch}</dd>
                      <dt>Phase</dt>
                      <dd>{s.phase ? PHASES[s.phase] : '—'}</dd>
                      {s.agents && (
                        <>
                          <dt>Agents</dt>
                          <dd>
                            {[
                              `${s.agents.enMarche} en marche`,
                              `${s.agents.enAttente} en attente`,
                              pluriel(s.agents.termine, 'terminé'),
                            ].join(', ')}
                          </dd>
                        </>
                      )}
                      <dt>État</dt>
                      <dd>{libelleAid(s.state)}</dd>
                      {s.prNumber !== null && (
                        <>
                          <dt>PR</dt>
                          <dd>
                            {s.prUrl ? <a href={s.prUrl}>#{s.prNumber}</a> : `#${s.prNumber}`}
                          </dd>
                        </>
                      )}
                    </dl>
                    <Link className="bouton" to={`/sujets/${s.sujetId}`}>
                      Ouvrir le sujet
                    </Link>
                  </>
                )}
              </>
            )}
          </section>
        ))}
      {result?.cartes?.find((c) => c.id === carte)?.sujets.some((s) => s.sujet === 'absent') && (
        <p>{"Sujet d'A-I-D absent de cette machine"}</p>
      )}
    </>
  );
}

export function SansCarteAid() {
  const { result } = useAidBoard();
  const { state, appareil } = useAid();
  const [message, setMessage] = useState('');
  if (!state || appareil) return null;
  const sansCarte = result?.sujets?.filter((s) => s.carte === null && s.conflit.length === 0) ?? [];
  const vivants = sansCarte.filter((s) => ['draft', 'active', 'review'].includes(s.state));
  const termines = sansCarte.filter((s) => ['merged', 'archived'].includes(s.state));
  async function copier(lien: string) {
    try {
      await navigator.clipboard.writeText(`AID: ${lien}`);
      setMessage('Copié.');
    } catch {
      setMessage('Copie impossible : accès au presse-papiers refusé.');
    }
  }
  return (
    <section>
      <ErreursAid />
      <details>
        <summary>Sujets sans carte ({vivants.length})</summary>
        <p>
          {pluriel(termines.length, 'sujet')} merged ou archived sans carte non{' '}
          {termines.length > 1 ? 'listés' : 'listé'}.
        </p>
        <ul>
          {vivants.map((s) => (
            <li key={s.sujetId}>
              <span>
                {s.titre} ·{' '}
                {state.workspaces.find((w) => w.id === s.workspace)?.name ?? s.workspace}
              </span>
              {s.lien === null ? (
                <span>Pas de remote GitHub : pas de lien possible</span>
              ) : (
                <button onClick={() => void copier(s.lien!)}>Copier la ligne</button>
              )}
            </li>
          ))}
        </ul>
        <p role="status">{message}</p>
      </details>
    </section>
  );
}

/** D292 : aucune écriture gateway ; le titre reste dans l'état de navigation. */
export function NouveauSujetCarte({
  carte,
  titre,
  corps,
}: {
  carte: number;
  titre: string;
  corps: string;
}) {
  const { state, appareil } = useAid();
  const { result, erreur } = useAidBoard();
  if (
    !state ||
    appareil ||
    !result ||
    erreur ||
    result.erreurs?.length ||
    !result.board?.ok ||
    liensAid(corps).length ||
    result.cartes.some((c) => c.id === carte) ||
    result.sujets.some((s) => s.carte === carte || s.conflit.includes(carte))
  )
    return null;
  return (
    <Link className="bouton" to="/sujets/nouveau" state={{ carte, titre: titre.slice(0, 200) }}>
      Nouveau sujet
    </Link>
  );
}
