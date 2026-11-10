import { useCallback, useEffect, useState } from 'react';
import { useAidClient } from '../data/useAidState.js';
import {
  type FileConfirmations,
  resultatConfirmation,
  useConfirmation,
} from './AttenteConfirmation.js';

interface Reglage {
  actions: { action: string; actif: boolean }[];
  arme: boolean;
  armeA: number | null;
  desarmeA: number | null;
  bandeau: 'amorcage' | 'desarme' | null;
}
const noms: Record<string, string> = {
  'mesh.ecrire': 'Écrire sur le mesh',
  'mesh.etat': 'Changer un état',
  merge: 'Merge',
  push: 'Push',
  nettoyage: 'Nettoyage',
  'projet.retirer': 'Retrait d’un projet',
};
const date = (t: number) => new Date(t).toLocaleString('fr-FR');

export function PanneauConfirmations() {
  const client = useAidClient();
  const [reglage, setReglage] = useState<Reglage | null>(null);
  const [file, setFile] = useState<FileConfirmations>({ ouvertes: [], recentes: [] });
  const [phrase, setPhrase] = useState<string | null>(null);
  const [erreur, setErreur] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [cible, setCible] = useState('');
  const lire = useCallback(async () => {
    const [r, f] = await Promise.all([
      client.request<Reglage>('GET', '/api/confirmations/reglage'),
      client.request<FileConfirmations>('GET', '/api/confirmations'),
    ]);
    if (!Array.isArray(r.actions) || !Array.isArray(f.ouvertes) || !Array.isArray(f.recentes))
      return;
    setReglage(r);
    setFile(f);
  }, [client]);
  const confirmation = useConfirmation(lire, true);
  useEffect(() => {
    let monte = true;
    const relire = () => {
      if (monte) void lire().catch(() => undefined);
    };
    relire();
    const timer = setInterval(relire, 3000);
    return () => {
      monte = false;
      clearInterval(timer);
    };
  }, [lire]);
  async function agir(action: () => Promise<unknown>, cible: string) {
    setOccupe(true);
    setErreur('');
    setCible(cible);
    try {
      const r = await action();
      if (cible === 'desarmer') setPhrase(null);
      if (!confirmation.recevoir(r)) await lire();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe(false);
    }
  }
  async function annuler(id: string) {
    setErreur('');
    try {
      await client.request('DELETE', `/api/confirmations/${id}`);
      await lire();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    }
  }
  if (!reglage) return null;
  const enAttente = !!confirmation.id && !confirmation.terminee;
  return (
    <section aria-label="Confirmations">
      <h3>Confirmations</h3>
      <p>
        {reglage.arme
          ? `Confirmations armées depuis le ${date(reglage.armeA!)}`
          : 'Confirmations non armées'}
      </p>
      {!reglage.arme && <p>Elles s’arment à l’activation du premier téléphone PDA</p>}
      {reglage.bandeau === 'amorcage' && (
        <p>
          Premier appareil activé sans confirmation. Active un second téléphone pour le secours.
        </p>
      )}
      {reglage.bandeau === 'desarme' && (
        <div>
          <p>Confirmations désarmées le {date(reglage.desarmeA!)}</p>
          <button
            className="bouton"
            disabled={occupe}
            onClick={() =>
              void agir(() => client.request('POST', '/api/confirmations/armer', {}), 'armer')
            }
          >
            Réarmer
          </button>
        </div>
      )}
      <h4>La file</h4>
      <ul>
        {file.ouvertes.map((d) => (
          <li key={d.id}>
            <span>
              {d.resume} — Échéance : {date(d.echeance)}
            </span>
            <button className="bouton" disabled={occupe} onClick={() => void annuler(d.id)}>
              Annuler
            </button>
          </li>
        ))}
      </ul>
      <ul>
        {file.recentes.slice(0, 20).map((d) => (
          <li key={d.id}>
            {d.resume} — {resultatConfirmation(d)}
          </li>
        ))}
      </ul>
      <h4>Le réglage</h4>
      <p>Couper demande une confirmation ; rallumer est immédiat.</p>
      {reglage.actions.map((a) => (
        <div key={a.action}>
          {cible === a.action && confirmation.attente}
          {(!confirmation.id || confirmation.terminee || cible !== a.action) && (
            <label>
              <input
                type="checkbox"
                role="switch"
                checked={a.actif}
                disabled={occupe || enAttente}
                onChange={() =>
                  void agir(
                    () =>
                      client.request('PUT', '/api/confirmations/reglage', {
                        action: a.action,
                        actif: !a.actif,
                      }),
                    a.action,
                  )
                }
              />
              {noms[a.action] ?? a.action}
            </label>
          )}
        </div>
      ))}
      {reglage.arme && (
        <div>
          {confirmation.id && cible === 'desarmer' ? (
            confirmation.attente
          ) : phrase === null ? (
            <button className="bouton" disabled={enAttente} onClick={() => setPhrase('')}>
              Désarmer
            </button>
          ) : (
            <div>
              <label>
                Tape DÉSARMER pour confirmer
                <input value={phrase} onChange={(e) => setPhrase(e.target.value)} />
              </label>
              <button
                className="bouton"
                disabled={occupe || enAttente || phrase !== 'DÉSARMER'}
                onClick={() =>
                  void agir(
                    () => client.request('POST', '/api/confirmations/desarmer', { phrase }),
                    'desarmer',
                  )
                }
              >
                Désarmer
              </button>
            </div>
          )}
        </div>
      )}
      {!reglage.arme && cible === 'desarmer' && confirmation.attente}
      {erreur && <p role="alert">{erreur}</p>}
    </section>
  );
}
