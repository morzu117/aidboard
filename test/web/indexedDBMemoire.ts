// Le sous-ensemble d'IndexedDB utilisé par dernierEtat : ouvertures et transactions asynchrones.
export function indexedDBMemoire() {
  const donnees = new Map<string, unknown>();
  let cree = false;
  const defauts = { ouverture: false, transaction: false, ecriture: false, asynchrone: false };
  const fabrique = {
    open() {
      if (defauts.ouverture) throw new Error('Stockage refusé');
      const ouverture = {
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        result: {
          close() {},
          createObjectStore() {
            cree = true;
          },
          transaction() {
            if (defauts.transaction) throw new Error('Transaction refusée');
            const transaction = {
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
              onabort: null as (() => void) | null,
              objectStore() {
                const requete = (agir: () => unknown) => {
                  if (defauts.ecriture) throw new Error('Requête refusée');
                  const resultat = { result: undefined as unknown };
                  queueMicrotask(() => {
                    if (defauts.asynchrone) return transaction.onabort?.();
                    resultat.result = agir();
                    transaction.oncomplete?.();
                  });
                  return resultat;
                };
                return {
                  get: (cle: string) => requete(() => donnees.get(cle)),
                  put: (valeur: unknown, cle: string) =>
                    requete(() => donnees.set(cle, structuredClone(valeur))),
                  clear: () => requete(() => donnees.clear()),
                };
              },
            };
            return transaction;
          },
        },
      };
      queueMicrotask(() => {
        if (!cree) ouverture.onupgradeneeded?.();
        ouverture.onsuccess?.();
      });
      return ouverture;
    },
  };
  return { fabrique, defauts, donnees };
}
