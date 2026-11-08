import { useCallback, useEffect, useRef, useState } from 'react';
import { useAidClient } from '../data/useAidState.js';

export interface Confirmation {
  id: string;
  classe: string;
  resume: string;
  echeance: number;
  etat: string;
  resultat: string | null;
}
export interface FileConfirmations {
  ouvertes: Confirmation[];
  recentes: Confirmation[];
}
export function resultatConfirmation(d: Confirmation): string | null {
  const resultat = {
    executee: 'Exécutée',
    annulee: 'Annulée',
    echouee: 'Échouée',
    perimee: "Périmée : l'état a changé depuis la demande",
  }[d.resultat ?? ''];
  return resultat ?? { refusee: 'Refusée sur le téléphone', expiree: 'Expirée' }[d.etat] ?? null;
}

export function AttenteConfirmation({
  id,
  toujours = false,
  onExecutee,
  onTerminee,
  onFermer,
}: {
  id: string;
  toujours?: boolean;
  onExecutee?: () => void | Promise<void>;
  onTerminee?: () => void;
  onFermer?: () => void;
}) {
  const client = useAidClient();
  const [numero, setNumero] = useState<string | null>(null);
  const [resultat, setResultat] = useState<string | null>(null);
  const [erreur, setErreur] = useState('');
  const annulee = useRef(false);
  const suite = useRef(onExecutee);
  const finie = useRef(onTerminee);
  useEffect(() => {
    suite.current = onExecutee;
    finie.current = onTerminee;
  }, [onExecutee, onTerminee]);
  useEffect(() => {
    let monte = true;
    let termine = false;
    let lecture = false;
    async function lire() {
      if (lecture || termine || annulee.current) return;
      lecture = true;
      try {
        const file = await client.request<FileConfirmations>('GET', '/api/confirmations');
        if (!monte || annulee.current) return;
        const d = [...file.ouvertes, ...file.recentes].find((d) => d.id === id);
        const fin = d && resultatConfirmation(d);
        if (fin) {
          termine = true;
          setNumero(null);
          setResultat(fin);
          finie.current?.();
          setErreur('');
          if (d.resultat === 'executee') await suite.current?.();
        } else if (d?.classe === 'toujours' || toujours) {
          const r = await client.request<{ numero: string }>(
            'GET',
            `/api/confirmations/${id}/numero`,
          );
          if (monte && !termine && !annulee.current) setNumero(r.numero);
        }
      } catch (e) {
        if (monte) setErreur(e instanceof Error ? e.message : String(e));
      } finally {
        lecture = false;
      }
    }
    void lire();
    const timer = setInterval(() => void lire(), 3000);
    return () => {
      monte = false;
      clearInterval(timer);
    };
  }, [client, id, toujours]);
  return (
    <div>
      <p role="status">{resultat ?? 'En attente de confirmation sur le téléphone'}</p>
      {!resultat && numero !== null && (
        <div>
          <strong style={{ fontSize: '3rem', letterSpacing: '0.2em' }}>{numero}</strong>
          <p>Retape ce numéro sur le téléphone</p>
        </div>
      )}
      {!resultat && (
        <button
          className="bouton"
          onClick={() => {
            void client.request('DELETE', `/api/confirmations/${id}`).then(
              () => {
                annulee.current = true;
                finie.current?.();
                setNumero(null);
                setResultat('Annulée');
              },
              (e: unknown) => setErreur(e instanceof Error ? e.message : String(e)),
            );
          }}
        >
          Annuler
        </button>
      )}
      {resultat && onFermer && (
        <button className="bouton" onClick={onFermer}>
          Fermer
        </button>
      )}
      {erreur && <p role="alert">{erreur}</p>}
    </div>
  );
}

/** L'identifiant reste local à l'écran ; le numéro appartient uniquement à l'attente. */
export function useConfirmation(onExecutee?: () => void | Promise<void>, toujours = false) {
  const [id, setId] = useState<string | null>(null);
  const [terminee, setTerminee] = useState(false);
  const [executee, setExecutee] = useState<string | null>(null);
  const recevoir = useCallback((r: unknown): boolean => {
    if (
      typeof r !== 'object' ||
      r === null ||
      !('confirmation' in r) ||
      typeof r.confirmation !== 'string'
    ) {
      setId(null);
      setExecutee(null);
      return false;
    }
    setTerminee(false);
    setExecutee(null);
    setId(r.confirmation);
    return true;
  }, []);
  return {
    id,
    executee,
    terminee,
    recevoir,
    attente: id ? (
      <AttenteConfirmation
        key={id}
        id={id}
        toujours={toujours}
        onTerminee={() => setTerminee(true)}
        onFermer={() => setId(null)}
        onExecutee={async () => {
          setExecutee(id);
          await onExecutee?.();
        }}
      />
    ) : null,
  };
}
