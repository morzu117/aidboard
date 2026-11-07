import { useAppareilsConnectes } from '../data/appareil.js';
import { depuis } from '../ui/depuis.js';
import { HorsAcces } from '../ui/HorsAcces.js';

// Chantier 31 (D177, D180) : les appareils connectés, vus d'un appareil. Les seules écritures de
// l'interface d'un appareil : révoquer un appareil, sans confirmation (règles globales), et se
// déconnecter.

const heure = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export function AppareilsConnectes() {
  const a = useAppareilsConnectes();
  if (a.deconnecte) return <HorsAcces fin="deconnecte" />;
  const actifs = (a.liste ?? []).filter((x) => x.etat === 'actif');
  return (
    <main className="page" data-node="appareils">
      <div className="entete">
        <div className="entete-texte">
          <h1 className="titre-ecran">Appareils connectés</h1>
          <p className="resume">
            Chaque accès dure 8 heures. Révoquer coupe tout de suite ; on ne revient que par un
            nouveau QR, sur le Mac.
          </p>
        </div>
      </div>
      {a.erreur && (
        <p className="message-erreur" role="alert" data-node="appareils.erreur">
          {a.erreur}
        </p>
      )}
      <ul className="machines-appareils" data-node="appareils.liste">
        {actifs.map((x) => (
          <li key={x.id} data-node={`appareils.${x.id}`}>
            <span className="machine-carte-nom">
              {x.nom}
              {x.moi ? ' · cet appareil' : ''}
            </span>
            <span className="texte-discret">
              {x.dernierContact ? `vu ${depuis(x.dernierContact)}` : 'jamais vu'}
            </span>
            <span className="texte-discret">jusqu’à {heure(x.expireA)}</span>
            {x.moi ? (
              <button
                className="bouton bouton--danger"
                type="button"
                data-node="appareils.deconnecter"
                disabled={a.occupe}
                onClick={() => void a.deconnecter()}
              >
                Me déconnecter
              </button>
            ) : (
              <button
                className="bouton bouton--danger"
                type="button"
                data-node={`appareils.${x.id}.revoquer`}
                disabled={a.occupe}
                onClick={() => void a.revoquer(x.id)}
              >
                Révoquer
              </button>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
