import { useCallback, useEffect, useRef, useState } from 'react';
import { AidApiError, api, SessionExpired } from './api.js';
import type { AccesFini } from './client.js';
import { useAidClient } from './useAidState.js';

// Chantier 31 (D180) : qui ouvre l'interface. `GET /api/appareils/moi` n'existe que sur le port
// des appareils : le Mac y répond 404 (ou 401 en texte, sans raison), un appareil 200 ou 401 avec
// sa raison. Le mode appareil ne retire que des boutons : c'est la liste du daemon qui refuse.

export interface Moi {
  id: string;
  nom: string;
  expireA: string;
}

export type ModeInterface =
  | { kind: 'mac' }
  | { kind: 'appareil'; moi: Moi | null }
  | { kind: 'hors-acces'; raison: AccesFini };

const RAISONS: readonly string[] = ['inconnu', 'expire', 'revoque'];

export async function detecterMode(fetchImpl: typeof fetch = fetch): Promise<ModeInterface> {
  try {
    const moi = await api<Moi>('GET', '/api/appareils/moi', undefined, fetchImpl);
    try {
      localStorage.setItem('aid.mode', 'appareil');
    } catch {
      // Le stockage peut être interdit.
    }
    return { kind: 'appareil', moi };
  } catch (err) {
    try {
      if (err instanceof SessionExpired) localStorage.removeItem('aid.mode');
      else if (!(err instanceof AidApiError) && localStorage.getItem('aid.mode') === 'appareil')
        return { kind: 'appareil', moi: null };
    } catch {
      // Le stockage peut être interdit.
    }
    if (err instanceof SessionExpired && err.raison !== null && RAISONS.includes(err.raison)) {
      return { kind: 'hors-acces', raison: err.raison as AccesFini };
    }
    // 404, 401 du Mac, daemon injoignable (la coquille hors-ligne) : l'interface du Mac
    return { kind: 'mac' };
  }
}

/** D177 : un appareil vu d'un appareil, sans identité ni empreinte. */
export interface AppareilVu {
  id: string;
  nom: string;
  creeA: string;
  dernierContact: string | null;
  expireA: string;
  etat: 'actif' | 'expire' | 'revoque';
  moi: boolean;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function useAppareilsConnectes() {
  const client = useAidClient();
  const [liste, setListe] = useState<AppareilVu[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [deconnecte, setDeconnecte] = useState(false);
  const monte = useRef(true);

  const lire = useCallback(
    () =>
      client.request<AppareilVu[]>('GET', '/api/appareils').then((l) => {
        if (monte.current) setListe(l);
      }),
    [client],
  );

  useEffect(() => {
    monte.current = true;
    lire().catch((err: unknown) => monte.current && setErreur(message(err)));
    return () => {
      monte.current = false;
    };
  }, [lire]);

  const agir = async (f: () => Promise<unknown>) => {
    setOccupe(true);
    setErreur(null);
    try {
      await f();
    } catch (err) {
      // un 404 : déjà révoqué ailleurs ; la liste relue le montre
      if (!(err instanceof AidApiError && err.status === 404) && monte.current)
        setErreur(message(err));
      await lire().catch(() => undefined);
    } finally {
      if (monte.current) setOccupe(false);
    }
  };

  return {
    liste,
    erreur,
    occupe,
    deconnecte,
    revoquer: (id: string) =>
      agir(async () => {
        await client.request('DELETE', `/api/appareils/${id}`);
        await lire();
      }),
    deconnecter: () =>
      agir(async () => {
        await client.request('POST', '/api/appareils/moi/deconnexion', {});
        client.stop();
        setDeconnecte(true);
      }),
  };
}
