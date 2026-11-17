import { useEffect, useState } from 'react';
import type { EtatFileCommandant } from '../../../src/daemon/commandant/service.js';
import { useAidClient } from '../data/useAidState.js';
import { useMeshes } from '../data/meshes.js';
import { EtatCockpit } from './CockpitCommandant.js';

function ReglageMesh({ mesh }: { mesh: string }) {
  const client = useAidClient();
  const [etat, setEtat] = useState<EtatFileCommandant['identifiant'] | null>(null);
  const [valeur, setValeur] = useState('');
  const [erreur, setErreur] = useState('');
  const [occupe, setOccupe] = useState(false);
  const url = `/api/commandant/${encodeURIComponent(mesh)}/identifiant`;
  useEffect(() => {
    let monte = true;
    void client.request<EtatFileCommandant['identifiant']>('GET', url).then(
      (r) => {
        if (monte) setEtat(r);
      },
      () => {
        if (monte) setErreur('Lecture de l’état impossible. Réessaie.');
      },
    );
    return () => {
      monte = false;
    };
  }, [client, url]);
  async function agir(method: 'PUT' | 'DELETE') {
    setOccupe(true);
    setErreur('');
    try {
      const r = await client.request<EtatFileCommandant['identifiant']>(
        method,
        url,
        method === 'PUT' ? { identifiant: valeur } : undefined,
      );
      setEtat(method === 'DELETE' ? { etat: 'absent', saisie: null } : r);
    } catch {
      setErreur(
        method === 'PUT'
          ? 'Identifiant refusé : vérifie son format et recommence.'
          : 'Retrait impossible. Réessaie.',
      );
    } finally {
      setValeur('');
      setOccupe(false);
    }
  }
  return (
    <section className="carte-panneau" aria-label={`Cockpit ${mesh}`}>
      <h2 className="titre-panneau">Cockpit — {mesh}</h2>
      {etat && <EtatCockpit identifiant={etat} reglages />}
      <div className="formulaire">
        <label className="serveur-champ-titre" htmlFor={`cockpit-identifiant-${mesh}`}>
          Identifiant cockpit — {mesh}
        </label>
        <div className="element-actions">
          <input
            id={`cockpit-identifiant-${mesh}`}
            className="champ"
            data-node="cockpit.identifiant"
            type="password"
            autoComplete="off"
            value={valeur}
            onChange={(e) => setValeur(e.target.value)}
          />
          <button
            data-node="cockpit.enregistrer"
            className="bouton"
            disabled={occupe || !valeur}
            onClick={() => void agir('PUT')}
          >
            Enregistrer
          </button>
          {etat && etat.etat !== 'absent' && (
            <button
              data-node="cockpit.retirer"
              className="bouton"
              disabled={occupe}
              onClick={() => void agir('DELETE')}
            >
              Retirer
            </button>
          )}
        </div>
      </div>
      {erreur && (
        <p className="message-erreur" role="alert">
          {erreur}
        </p>
      )}
    </section>
  );
}
export function ReglagesCockpit() {
  const { meshes } = useMeshes();
  return (
    <>
      {meshes
        .filter((m) => m.actif && m.cell)
        .map((m) => (
          <ReglageMesh key={m.nom} mesh={m.nom} />
        ))}
    </>
  );
}
