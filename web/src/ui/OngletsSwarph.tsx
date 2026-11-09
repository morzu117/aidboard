import { NavLink, Navigate } from 'react-router';
import { useAid } from '../data/useAidState.js';
import { Layout } from './Layout.js';

export const ONGLETS_SWARPH = [
  ['board', '/board', 'Board'],
  ['cells', '/swarph/cells', 'Cells'],
  ['federation', '/swarph/federation', 'Federation'],
  ['memoire', '/swarph/memoire', 'Memory'],
  ['reglages', '/swarph/reglages', 'Réglages swarph'],
] as const;

export function OngletsSwarph() {
  return (
    <nav aria-label="Onglets swarph" data-node="onglets-swarph">
      {ONGLETS_SWARPH.map(([id, chemin, titre]) => (
        <NavLink key={id} to={chemin} className="nav-lien" data-node={`onglets-swarph.${id}`}>
          {titre}
        </NavLink>
      ))}
    </nav>
  );
}

/** Écran provisoire du 37.4, remplacé aux points 37.5 et 37.6. */
export function EcranSwarphProvisoire({ titre }: { titre: string }) {
  const { state } = useAid();
  if (state && !state.mesh) return <Navigate to="/swarph" replace />;
  return (
    <Layout screen="board">
      {state?.mesh && (
        <main className="page">
          <OngletsSwarph />
          <h1 className="titre-ecran">{titre}</h1>
        </main>
      )}
    </Layout>
  );
}
