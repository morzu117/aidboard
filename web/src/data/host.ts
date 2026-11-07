import { useCallback, useEffect, useRef, useState } from 'react';
import type { Appareil, EtatModeHostDaemon, VueDemande } from '../../../src/shared/host.js';
import { useAidClient } from './useAidState.js';

// Chantier 31 (D172, D176, D177) : le mode host vu du Mac, dans Machines › Ton cockpit. Lu à
// l'ouverture et après chaque action. Seule une demande d'appairage en cours est relue chaque
// seconde, pour voir la réclamation arriver ; rien ne tourne quand aucun QR n'est affiché.

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface NouveauCode {
  demandeId: string;
  code: string;
  expireA: string;
  /** le lien du QR, https://<nom>/appairer#<code> */
  url: string;
}

export interface ModeHostEtat {
  etat: EtatModeHostDaemon | null;
  appareils: Appareil[];
  demande: VueDemande | null;
  identiteVerifiable: boolean;
  /** le QR affiché : il n'existe que dans cet écran, jamais relu du daemon */
  qr: NouveauCode | null;
  erreur: string | null;
  occupe: boolean;
  basculer: (actif: boolean) => Promise<void>;
  nouveauCode: () => Promise<void>;
  fermerQr: () => void;
  approuver: (id: string, sansIdentite: boolean) => Promise<void>;
  refuser: (id: string) => Promise<void>;
  revoquer: (id: string) => Promise<void>;
  couper: () => Promise<void>;
}

export const RELECTURE_DEMANDE_MS = 1000;

export function useModeHost(): ModeHostEtat {
  const client = useAidClient();
  const [etat, setEtat] = useState<EtatModeHostDaemon | null>(null);
  const [appareils, setAppareils] = useState<Appareil[]>([]);
  const [demande, setDemande] = useState<VueDemande | null>(null);
  const [identiteVerifiable, setIdentiteVerifiable] = useState(false);
  const [qr, setQr] = useState<NouveauCode | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const monte = useRef(true);

  const lireDemande = useCallback(async () => {
    const r = await client.request<{ demande: VueDemande | null; identiteVerifiable: boolean }>(
      'GET',
      '/api/host/appairage',
    );
    if (!monte.current) return r.demande;
    setDemande(r.demande);
    setIdentiteVerifiable(r.identiteVerifiable);
    return r.demande;
  }, [client]);

  const lireAppareils = useCallback(async () => {
    const l = await client.request<Appareil[]>('GET', '/api/host/appareils');
    if (monte.current) setAppareils(l);
  }, [client]);

  const lireTout = useCallback(
    () =>
      client.request<EtatModeHostDaemon>('GET', '/api/host').then(async (e) => {
        if (!monte.current) return;
        setEtat(e);
        if (e.actif) await Promise.all([lireAppareils(), lireDemande()]);
      }),
    [client, lireAppareils, lireDemande],
  );

  useEffect(() => {
    monte.current = true;
    lireTout().catch((err: unknown) => monte.current && setErreur(message(err)));
    return () => {
      monte.current = false;
    };
  }, [lireTout]);

  // la demande en cours, relue tant qu'un QR est affiché et qu'elle peut encore bouger
  const vivante =
    qr !== null &&
    (demande === null ||
      demande.etat === 'attente' ||
      demande.etat === 'reclamee' ||
      demande.etat === 'approuvee');
  useEffect(() => {
    if (!vivante) return;
    const t = setInterval(() => {
      void lireDemande()
        .then((d) => (d?.etat === 'consommee' ? lireAppareils() : undefined))
        .catch(() => undefined);
    }, RELECTURE_DEMANDE_MS);
    return () => clearInterval(t);
  }, [vivante, lireDemande, lireAppareils]);

  const agir = useCallback(async (f: () => Promise<unknown>) => {
    setOccupe(true);
    setErreur(null);
    try {
      await f();
    } catch (err) {
      if (monte.current) setErreur(message(err));
    } finally {
      if (monte.current) setOccupe(false);
    }
  }, []);

  return {
    etat,
    appareils,
    demande,
    identiteVerifiable,
    qr,
    erreur,
    occupe,
    basculer: (actif) =>
      agir(async () => {
        const e = await client.request<EtatModeHostDaemon>('PUT', '/api/host', { actif });
        setEtat(e);
        if (!actif) setQr(null);
        await Promise.all([lireAppareils(), lireDemande()]);
      }),
    nouveauCode: () =>
      agir(async () => {
        const c = await client.request<NouveauCode>('POST', '/api/host/appairages');
        setQr(c);
        await lireDemande();
      }),
    fermerQr: () => setQr(null),
    approuver: (id, sansIdentite) =>
      agir(async () => {
        await client.request(
          'POST',
          `/api/host/appairages/${id}/approuver`,
          sansIdentite ? { sansIdentite: true } : {},
        );
        await lireDemande();
      }),
    refuser: (id) =>
      agir(async () => {
        await client.request('POST', `/api/host/appairages/${id}/refuser`, {});
        await lireDemande();
      }),
    revoquer: (id) =>
      agir(async () => {
        await client.request('DELETE', `/api/host/appareils/${id}`);
        await lireAppareils();
      }),
    couper: () =>
      agir(async () => {
        await client.request('POST', '/api/host/couper', {});
        setQr(null);
        await Promise.all([lireAppareils(), lireDemande()]);
      }),
  };
}
