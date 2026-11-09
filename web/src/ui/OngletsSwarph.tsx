import { NavLink } from 'react-router';

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
