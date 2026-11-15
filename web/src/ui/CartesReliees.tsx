import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { BoardCard } from '../../../src/shared/board.js';
import {
  lireApercuRelie,
  lirePageReliee,
  relierCartes,
  retirerMembre,
  useGroupeRelie,
  type CibleCarte,
  type GroupeRelie,
  type MembreRelie,
  type PageCartesReliees,
} from '../data/cartes-reliees.js';
import { instantaneMesh, useMeshLecture } from '../data/meshLecture.js';
import { useMeshes } from '../data/meshes.js';
import { useAid, useAidClient } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { AvatarCell } from './AvatarCell.js';
import { useViewport } from './useViewport.js';

const statuts = {
  mesh_change: 'mesh changé',
  carte_remplacee: 'carte remplacée',
  lecture_impossible: 'lecture impossible',
};

function Membre({ membre }: { membre: MembreRelie }) {
  const { state } = useAid();
  return (
    <tr>
      <td>
        <Link to={`/board/cartes/${membre.carte}?mesh=${encodeURIComponent(membre.mesh)}`}>
          {membre.mesh} #{membre.carte}
        </Link>
      </td>
      {membre.statut === 'ok' ? (
        <>
          <td>{membre.titre ?? '—'}</td>
          <td>{membre.etape ?? '—'}</td>
          <td>
            {membre.responsable && (
              <AvatarCell
                nom={membre.responsable}
                cellLocale={instantaneMesh(state, membre.mesh)?.state.cell}
              />
            )}
            {membre.responsable ?? 'sans responsable'}
          </td>
          <td>{membre.obligations ?? '—'}</td>
          <td>{membre.echeance ?? '—'}</td>
          <td>{membre.maj ?? '—'}</td>
        </>
      ) : (
        <td colSpan={6}>{statuts[membre.statut]}</td>
      )}
    </tr>
  );
}

function Membres({ membres }: { membres: MembreRelie[] }) {
  return (
    <table className="carte-board-table">
      <thead>
        <tr>
          <th>Carte</th>
          <th>Titre</th>
          <th>Étape</th>
          <th>Responsable</th>
          <th>Obligations</th>
          <th>Échéance</th>
          <th>Mise à jour</th>
        </tr>
      </thead>
      <tbody>
        {membres.map((membre) => (
          <Membre key={membre.id} membre={membre} />
        ))}
      </tbody>
    </table>
  );
}

function Apercu({ cible, carte }: { cible: CibleCarte; carte: BoardCard }) {
  const { state } = useAid();
  return (
    <p>
      {cible.mesh} #{cible.carte} · {carte.title} · {carte.stage ?? 'sans étape'} ·{' '}
      {carte.assignee && (
        <AvatarCell
          nom={carte.assignee}
          cellLocale={instantaneMesh(state, cible.mesh)?.state.cell}
        />
      )}
      {carte.assignee ?? 'sans responsable'}
    </p>
  );
}

function Relier({
  origine,
  groupe,
  onClose,
  onRelie,
}: {
  origine: CibleCarte;
  groupe: GroupeRelie | null;
  onClose: () => void;
  onRelie: () => Promise<void>;
}) {
  const client = useAidClient();
  const { meshes } = useMeshes();
  const actifs = meshes.filter((m) => m.actif && m.nom !== origine.mesh);
  const [mesh, setMesh] = useState(actifs[0]?.nom ?? '');
  const [numero, setNumero] = useState('');
  const [apercu, setApercu] = useState<BoardCard[] | null>(null);
  const [attente, setAttente] = useState(false);
  const [erreur, setErreur] = useState('');
  const revision = useRef(0);
  useEffect(
    () => () => {
      revision.current++;
    },
    [],
  );
  const carte = Number(numero);
  const valide =
    actifs.some((m) => m.nom === mesh) &&
    /^\d+$/.test(numero) &&
    Number.isSafeInteger(carte) &&
    carte > 0;
  const cible = { mesh, carte };
  function changer() {
    revision.current++;
    setApercu(null);
    setErreur('');
    setAttente(false);
  }
  async function lire() {
    const tour = ++revision.current;
    setAttente(true);
    setApercu(null);
    setErreur('');
    try {
      const fiches = await Promise.all([
        lireApercuRelie(client, origine),
        lireApercuRelie(client, cible),
      ]);
      if (tour !== revision.current) return;
      const cartes = fiches.map((fiche) => {
        if (!fiche.card.ok) throw new Error('Lecture impossible : vérifie les deux cartes.');
        return fiche.card.data;
      });
      setApercu(cartes);
    } catch (e) {
      if (tour === revision.current)
        setErreur(e instanceof Error ? e.message : 'Lecture impossible.');
    } finally {
      if (tour === revision.current) setAttente(false);
    }
  }
  async function confirmer() {
    if (!apercu || !valide || attente) return;
    setAttente(true);
    setErreur('');
    try {
      await relierCartes(client, origine, cible, groupe);
      await onRelie();
      onClose();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Impossible de relier les cartes.');
    } finally {
      setAttente(false);
    }
  }
  return (
    <Dialogue titre="Relier à une carte d’un autre mesh" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valide && !attente) void lire();
        }}
      >
        <label>
          Mesh de la carte
          <select
            value={mesh}
            disabled={attente}
            onChange={(e) => {
              changer();
              setMesh(e.target.value);
            }}
          >
            {actifs.map((m) => (
              <option key={m.nom} value={m.nom}>
                {m.nom}
              </option>
            ))}
          </select>
        </label>
        <label>
          Numéro de carte
          <input
            type="number"
            min="1"
            step="1"
            value={numero}
            disabled={attente}
            onChange={(e) => {
              changer();
              setNumero(e.target.value);
            }}
          />
        </label>
        <button className="bouton" disabled={!valide || attente}>
          Aperçu
        </button>
      </form>
      {apercu && (
        <div aria-label="Aperçu des deux cartes">
          <Apercu cible={origine} carte={apercu[0]!} />
          <Apercu cible={cible} carte={apercu[1]!} />
        </div>
      )}
      {erreur && <p role="alert">{erreur}</p>}
      <div className="dialogue-actions">
        <button
          className="bouton"
          disabled={!apercu || !valide || attente}
          onClick={() => void confirmer()}
        >
          Confirmer le lien
        </button>
        <button className="bouton" disabled={attente} onClick={onClose}>
          Annuler
        </button>
      </div>
    </Dialogue>
  );
}

function Retraits({ groupe, onRetire }: { groupe: GroupeRelie; onRetire: () => Promise<void> }) {
  const client = useAidClient();
  const [membre, setMembre] = useState<MembreRelie | null>(null);
  const [attente, setAttente] = useState(false);
  const [erreur, setErreur] = useState('');
  async function confirmer() {
    if (!membre || attente) return;
    setAttente(true);
    setErreur('');
    try {
      await retirerMembre(client, groupe.id, membre.id);
      await onRetire();
      setMembre(null);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Retrait impossible.');
    } finally {
      setAttente(false);
    }
  }
  function fermer() {
    if (attente) return;
    setMembre(null);
    setErreur('');
  }
  return (
    <>
      <ul className="carte-board-liens">
        {groupe.membres.map((m) => (
          <li key={m.id}>
            {m.mesh} #{m.carte}{' '}
            <button className="bouton" onClick={() => setMembre(m)}>
              Retirer du groupe
            </button>
          </li>
        ))}
      </ul>
      {membre && (
        <Dialogue titre="Retirer du groupe" onClose={fermer}>
          <p>
            Retirer {membre.mesh} #{membre.carte} du groupe ?
          </p>
          {erreur && <p role="alert">{erreur}</p>}
          <div className="dialogue-actions">
            <button className="bouton" disabled={attente} onClick={() => void confirmer()}>
              Confirmer le retrait
            </button>
            <button className="bouton" disabled={attente} onClick={fermer}>
              Annuler
            </button>
          </div>
        </Dialogue>
      )}
    </>
  );
}

function Section({ carte }: { carte: number }) {
  const mesh = useMeshLecture();
  const { multiple } = useMeshes();
  const { result: groupe, erreur, enLecture, relire } = useGroupeRelie({ mesh, carte });
  const [dialogue, setDialogue] = useState(false);
  return (
    <>
      {groupe && (
        <section className="carte-board-bloc" aria-label="Même carte ailleurs">
          <h2 className="carte-board-bloc-titre">Même carte ailleurs</h2>
          {groupe.note && <p>{groupe.note}</p>}
          <Membres membres={groupe.membres.filter((m) => m.mesh !== mesh || m.carte !== carte)} />
          <Retraits groupe={groupe} onRetire={relire} />
        </section>
      )}
      {erreur && <p role="alert">{erreur}</p>}
      {multiple && (
        <button
          className="bouton"
          disabled={enLecture || !!erreur}
          onClick={() => setDialogue(true)}
        >
          Relier à une carte d’un autre mesh
        </button>
      )}
      {dialogue && (
        <Relier
          origine={{ mesh, carte }}
          groupe={groupe}
          onClose={() => setDialogue(false)}
          onRelie={relire}
        />
      )}
    </>
  );
}

function Liste() {
  const client = useAidClient();
  const [page, setPage] = useState<PageCartesReliees | null>(null);
  const [attente, setAttente] = useState(false);
  const [erreur, setErreur] = useState('');
  const verrou = useRef(false);
  useEffect(() => {
    let actif = true;
    void lirePageReliee(client)
      .then((resultat) => {
        if (actif) setPage(resultat);
      })
      .catch(() => {
        if (actif) setErreur('Lecture des cartes reliées impossible.');
      });
    return () => {
      actif = false;
    };
  }, [client]);
  async function plus() {
    if (verrou.current || page?.suivant === null) return;
    verrou.current = true;
    setAttente(true);
    setErreur('');
    try {
      const suivante = await lirePageReliee(client, page?.suivant ?? 0);
      setPage((avant) => ({
        groupes: [...(avant?.groupes ?? []), ...suivante.groupes],
        suivant: suivante.suivant,
      }));
    } catch {
      setErreur('Lecture des cartes reliées impossible.');
    } finally {
      verrou.current = false;
      setAttente(false);
    }
  }
  return (
    <section className="carte-board-bloc" aria-label="Cartes reliées">
      <h2 className="carte-board-bloc-titre">Cartes reliées</h2>
      {page?.groupes.map((groupe) => (
        <div key={groupe.id}>
          <h3>
            Groupe #{groupe.id} {groupe.ecart && <span className="badge">écart</span>}
          </h3>
          {groupe.note && <p>{groupe.note}</p>}
          <Membres membres={groupe.membres} />
        </div>
      ))}
      {page?.groupes.length === 0 && <p className="texte-discret">Aucune carte reliée.</p>}
      {erreur && <p role="alert">{erreur}</p>}
      {(page?.suivant != null || (!page && erreur)) && (
        <button className="bouton" disabled={attente} onClick={() => void plus()}>
          {page ? 'Plus' : 'Réessayer'}
        </button>
      )}
    </section>
  );
}

/** Aucun ajout dans les vues téléphone et appareil ; une fiche garde ses liens avec un seul mesh. */
export function CartesReliees({ carte }: { carte?: number }) {
  const { state, appareil } = useAid();
  const viewport = useViewport();
  if (!state || appareil || viewport === 'phone') return null;
  return carte === undefined ? <ListeSiMultiple /> : <Section key={`${carte}`} carte={carte} />;
}

function ListeSiMultiple() {
  const { multiple } = useMeshes();
  return multiple ? <Liste /> : null;
}
