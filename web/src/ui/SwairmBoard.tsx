import { EcrireAuMesh } from './EcrireAuMesh.js';
import { useAid, useAidClient } from '../data/useAidState.js';
import { instantaneMesh, useMeshLecture } from '../data/meshLecture.js';
import { boardStore } from '../data/board.js';
import type { BoardSwairm } from '../data/swairm-board.js';
import { useEffect, useState } from 'react';
import { pluriel } from './pluriel.js';
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
  const client = useAidClient();
  const mesh = useMeshLecture();
  const { state, appareil } = useAid();
  const disponible = !!state && !appareil;
  const etat = instantaneMesh(state, mesh)?.state;
  const raison = !etat?.proxyConfigure
    ? "Le proxy de ta cellule n'est pas configuré. Rien ne peut partir ; l'aperçu reste disponible."
    : !etat.ecritures
      ? 'Le proxy de ta cellule est en lecture seule : rien ne peut partir.'
      : '';
  const [creation, setCreation] = useState<SujetBoardSwairm | null>(null);
  const [vols, setVols] = useState<{ ligne_swairm: string }[] | null>(null);
  const [relecture, setRelecture] = useState(false);
  useEffect(() => {
    if (!disponible) return;
    let actif = true;
    const lire = () =>
      void client
        .request<{ ligne_swairm: string }[]>(
          'GET',
          `/api/swarph/cartes-en-vol?mesh=${encodeURIComponent(mesh)}`,
        )
        .then((r) => {
          if (actif) setVols(Array.isArray(r) ? r : null);
        })
        .catch(() => {
          if (actif) {
            setVols(null);
            setMessage('Impossible de lire les créations en cours.');
          }
        });
    lire();
    const minuteur = setInterval(lire, 5000);
    return () => {
      actif = false;
      clearInterval(minuteur);
    };
  }, [client, mesh, disponible]);
  async function relireBoard() {
    await boardStore<BoardSwairm>(
      client,
      '/api/swairm/board',
      (r) => r.board?.readAt ?? null,
    ).relire();
  }
  async function relire(s: SujetBoardSwairm) {
    setRelecture(true);
    try {
      const r = await client.request<{ ok: boolean }>('POST', '/api/swarph/cartes-en-vol/relire', {
        mesh,
        ligne: ligneSwairm(s),
      });
      setVols(
        await client.request('GET', `/api/swarph/cartes-en-vol?mesh=${encodeURIComponent(mesh)}`),
      );
      if (!r.ok) setMessage('Relecture du board impossible. Réessaie.');
      else {
        setMessage('Board relu.');
        await relireBoard();
      }
    } catch {
      setMessage('Relecture du board impossible. Réessaie.');
    } finally {
      setRelecture(false);
    }
  }
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
      {creation && (
        <EcrireAuMesh
          mesh={mesh}
          action="carte.creer"
          valeurs={{ titre: creation.titre, ligneSwairm: ligneSwairm(creation) }}
          onClose={() => setCreation(null)}
          onEnvoye={() => void relireBoard()}
          onRelire={() => relire(creation)}
        />
      )}
      <ErreursSwairm />
      <details>
        <summary>Sujets Swairm sans carte ({vivants.length})</summary>
        <p>
          {pluriel(termines.length, 'sujet')} merged ou abandoned sans carte non{' '}
          {termines.length > 1 ? 'listés' : 'listé'}.
        </p>
        <ul>
          {vivants.map((s) => (
            <li key={`${s.projet}#${s.id}`}>
              <span>
                {s.projet}#{s.id} · {s.titre} · {libelleSwairm(s.etat)}
              </span>
              <button onClick={() => void copier(ligneSwairm(s))}>Copier la ligne</button>
              <button onClick={() => void copier(commandeSwairm(s))}>Copier la commande</button>
              <button
                disabled={
                  !!raison ||
                  vols === null ||
                  vols.some((v) => v.ligne_swairm === ligneSwairm(s)) ||
                  relecture
                }
                title={raison || undefined}
                onClick={() => setCreation(s)}
              >
                Créer la carte
              </button>
              {raison && <p>{raison}</p>}
              {vols?.some((v) => v.ligne_swairm === ligneSwairm(s)) && (
                <button disabled={relecture} onClick={() => void relire(s)}>
                  Relire le board
                </button>
              )}
            </li>
          ))}
        </ul>
        <p role="status">{message}</p>
      </details>
    </section>
  );
}
