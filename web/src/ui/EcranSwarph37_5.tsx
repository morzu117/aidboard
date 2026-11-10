import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import type { BoardResult } from '../../../src/shared/board.js';
import type { MeshMonitor } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { MessageBoard } from '../ecrans/Board.js';
import { Layout } from './Layout.js';
import { OngletsSwarph } from './OngletsSwarph.js';

/** Liste fermée : ne jamais afficher les champs libres du monitor. */
export function EtatMonitor37_5({ etat }: { etat: MeshMonitor }) {
  const libelles: Record<MeshMonitor, string> = {
    running: 'En marche',
    stopped: 'Arrêté',
    stale: 'Périmé',
    proxy: 'géré par le proxy',
    absent: 'Absent',
  };
  return <>{Object.hasOwn(libelles, etat) ? `${etat} · ${libelles[etat]}` : 'inconnu'}</>;
}

export function CadreSwarph37_5({ children }: { children: ReactNode }) {
  const { state } = useAid();
  if (state && !state.mesh) return <Navigate to="/swarph" replace />;
  return <Layout screen="board">{state?.mesh ? children : null}</Layout>;
}

export function LectureSwarph37_5({
  titre,
  node,
  lecture,
  resultat,
  children,
}: {
  titre: string;
  node: string;
  lecture: {
    enLecture: boolean;
    luA: string | null;
    erreur: string | null;
    relire: () => Promise<void>;
  };
  resultat: BoardResult<unknown> | null;
  children: ReactNode;
}) {
  const relire = () => {
    if (!lecture.enLecture) void lecture.relire();
  };
  return (
    <main className="page" data-node={node}>
      <OngletsSwarph />
      <div className="entete">
        <h1 className="titre-ecran">{titre}</h1>
        <div className="board-lecture">
          <span data-node={`${node}.lu-a`} aria-live="polite">
            Lu à {lecture.luA ? new Date(lecture.luA).toLocaleTimeString('fr-FR') : '—'}
          </span>
          <button
            className="bouton"
            type="button"
            data-node={`${node}.recharger`}
            disabled={lecture.enLecture}
            onClick={relire}
          >
            Recharger
          </button>
        </div>
      </div>
      {lecture.erreur && <MessageBoard kind="unknown" node={`${node}.erreur`} onRelire={relire} />}
      {resultat && !resultat.ok && (
        <MessageBoard kind={resultat.kind} node={`${node}.message`} onRelire={relire} />
      )}
      {children}
    </main>
  );
}
