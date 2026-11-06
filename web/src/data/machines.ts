import { useCallback, useEffect, useState } from 'react';
import type { Fournisseurs, MachineLocale, MachineServeur } from '../../../src/shared/model.js';
import { useAidClient } from './useAidState.js';

// Chantier 29 (D160) : l'écran Machines lit ses trois sources à l'ouverture ; Diagnostiquer relit la carte de sa
// machine. Rien ne tourne en fond : l'état et la latence des serveurs suivent `useServeurs`.

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface MachinesEtat {
  local: MachineLocale | null;
  /** le dernier diagnostic de chaque serveur, par id */
  serveurs: Record<string, MachineServeur>;
  fournisseurs: Fournisseurs | null;
  erreur: string | null;
  /** `local` ou l'id d'un serveur : son diagnostic tourne */
  enCours: ReadonlySet<string>;
  /** l'erreur du dernier diagnostic d'une machine, par id */
  erreurs: Record<string, string>;
  /** résolu à la fin du diagnostic, réussi ou non */
  diagnostiquer: (machineId: string) => Promise<void>;
}

export function useMachines(): MachinesEtat {
  const client = useAidClient();
  const [local, setLocal] = useState<MachineLocale | null>(null);
  const [serveurs, setServeurs] = useState<Record<string, MachineServeur>>({});
  const [fournisseurs, setFournisseurs] = useState<Fournisseurs | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState<ReadonlySet<string>>(new Set(['local']));
  const [erreurs, setErreurs] = useState<Record<string, string>>({});

  const marquer = (id: string, actif: boolean) =>
    setEnCours((s) => {
      const n = new Set(s);
      if (actif) n.add(id);
      else n.delete(id);
      return n;
    });

  useEffect(() => {
    let actif = true;
    const echec = (err: unknown) => actif && setErreur(message(err));
    client
      .request<MachineLocale>('GET', '/api/machines/local')
      .then((m) => actif && setLocal(m), echec)
      .finally(() => actif && marquer('local', false));
    client
      .request<MachineServeur[]>('GET', '/api/machines/serveurs')
      .then((l) => actif && setServeurs(Object.fromEntries(l.map((d) => [d.serverId, d]))), echec);
    client
      .request<Fournisseurs>('GET', '/api/machines/fournisseurs')
      .then((f) => actif && setFournisseurs(f), echec);
    return () => {
      actif = false;
    };
  }, [client]);

  const diagnostiquer = useCallback(
    (id: string) => {
      marquer(id, true);
      setErreurs((e) => {
        const reste = { ...e };
        delete reste[id];
        return reste;
      });
      const fini = () => marquer(id, false);
      const echec = (err: unknown) => setErreurs((e) => ({ ...e, [id]: message(err) }));
      if (id === 'local')
        return client
          .request<MachineLocale>('GET', '/api/machines/local')
          .then(setLocal, echec)
          .finally(fini);
      return client
        .request<MachineServeur>('POST', `/api/machines/serveurs/${id}/diagnostic`)
        .then((d) => setServeurs((s) => ({ ...s, [id]: d })), echec)
        .finally(fini);
    },
    [client],
  );

  return { local, serveurs, fournisseurs, erreur, enCours, erreurs, diagnostiquer };
}
