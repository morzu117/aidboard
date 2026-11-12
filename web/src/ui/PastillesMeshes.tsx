import { useMeshes } from '../data/meshes.js';

export function PastillesMeshes() {
  const { meshes, multiple } = useMeshes();
  if (!multiple) return null;
  const actifs = meshes.filter((m) => m.actif);
  return (
    <div aria-label="État des meshes">
      {actifs.slice(0, 3).map((m) => (
        <span className="badge" key={m.nom}>
          <span
            className={`point point--${m.etat?.connected ? 'ok' : 'inactif'}`}
            aria-hidden="true"
          />
          {m.nom} · {m.etat?.connected ? 'connecté' : 'hors mesh'}
        </span>
      ))}
      {actifs.length > 3 && <span>+{actifs.length - 3}</span>}
    </div>
  );
}
