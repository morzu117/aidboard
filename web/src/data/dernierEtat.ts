import type { EtatPourAppareil } from '../../../src/shared/host.js';

export interface DernierEtat {
  etat: EtatPourAppareil;
  lu: string;
}

// Une seule entrée, uniquement l'état masqué. La file ordonne aussi un effacement après
// une écriture encore en vol. Aucune connexion n'est gardée ouverte entre deux opérations.
let attente: Promise<unknown> = Promise.resolve();

function operation<T>(
  mode: IDBTransactionMode,
  agir: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const suivante = attente.then(
    () =>
      new Promise<T | null>((resolve) => {
        let base: IDBDatabase | undefined;
        let termine = false;
        const finir = (valeur: T | null = null) => {
          termine = true;
          base?.close();
          resolve(valeur);
        };
        try {
          const ouverture = indexedDB.open('aid-appareil', 1);
          ouverture.onblocked = () => finir();
          ouverture.onerror = () => finir();
          ouverture.onupgradeneeded = () => {
            try {
              ouverture.result.createObjectStore('etat');
            } catch {
              finir();
            }
          };
          ouverture.onsuccess = () => {
            base = ouverture.result;
            if (termine) return base.close();
            try {
              const transaction = base.transaction('etat', mode);
              const requete = agir(transaction.objectStore('etat'));
              transaction.oncomplete = () => finir(requete.result ?? null);
              transaction.onerror = transaction.onabort = () => finir();
            } catch {
              finir();
            }
          };
        } catch {
          finir();
        }
      }),
  );
  attente = suivante;
  return suivante;
}

export async function garder(etat: EtatPourAppareil): Promise<void> {
  const entree: DernierEtat = { etat, lu: new Date().toISOString() };
  await operation('readwrite', (store) => store.put(entree, 'dernier'));
}

export async function relire(): Promise<DernierEtat | null> {
  return operation<DernierEtat>('readonly', (store) => store.get('dernier'));
}

export async function effacer(): Promise<void> {
  try {
    localStorage.removeItem('aid.mode');
  } catch {
    // Le stockage peut être interdit.
  }
  await operation('readwrite', (store) => store.clear());
}
