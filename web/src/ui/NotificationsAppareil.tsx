import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAid, useAidClient } from '../data/useAidState.js';
import { AidApiError } from '../data/api.js';
import { installationRequise } from './RappelInstallation.js';

type Push = { actifSurLeMac: boolean; abonne: boolean };
const refus: Record<string, string> = {
  push_coupe: 'Les notifications sont coupées sur le Mac.',
  endpoint: 'Ce service de notifications est refusé par le Mac.',
  cles: 'Les clés de cet abonnement sont invalides.',
};

export function NotificationsAppareil() {
  const client = useAidClient();
  const { horsLigne } = useAid();
  const [push, setPush] = useState<Push | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  useEffect(() => {
    if (horsLigne) return;
    let actif = true;
    void client.request<{ push: Push }>('GET', '/api/appareils/moi').then(
      (moi) => {
        if (actif) setPush(moi.push);
      },
      () => {
        if (actif) setErreur('Notifications indisponibles.');
      },
    );
    return () => {
      actif = false;
    };
  }, [client, horsLigne]);
  const agir = async () => {
    setOccupe(true);
    setErreur(null);
    try {
      if (push?.abonne) {
        const registration = await navigator.serviceWorker.ready;
        const abonnement = await registration.pushManager.getSubscription();
        if (abonnement && !(await abonnement.unsubscribe())) throw new Error();
        await client.request('DELETE', '/api/appareils/moi/push');
        setPush({ actifSurLeMac: true, abonne: false });
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setErreur(
            'La permission de recevoir des notifications a été refusée. Autorise-la dans les réglages du navigateur.',
          );
          return;
        }
        const { cle } = await client.request<{ cle: string }>('GET', '/api/appareils/push/cle');
        const base64 = cle.replace(/-/g, '+').replace(/_/g, '/');
        const applicationServerKey = Uint8Array.from(
          atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')),
          (c) => c.charCodeAt(0),
        );
        const registration = await navigator.serviceWorker.ready;
        const abonnement = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        const { endpoint, keys } = abonnement.toJSON();
        await client.request('POST', '/api/appareils/moi/push', {
          endpoint,
          keys: { p256dh: keys?.p256dh, auth: keys?.auth },
        });
        setPush({ actifSurLeMac: true, abonne: true });
      }
    } catch (err) {
      setErreur(
        err instanceof AidApiError
          ? (refus[String(err.body.raison)] ?? 'Notifications indisponibles.')
          : 'Notifications indisponibles.',
      );
    } finally {
      setOccupe(false);
    }
  };
  const indisponible =
    push && !push.actifSurLeMac
      ? refus.push_coupe
      : installationRequise()
        ? "Installe A-I-D sur l'écran d'accueil pour recevoir les notifications."
        : !('PushManager' in window) ||
            !('Notification' in window) ||
            !('serviceWorker' in navigator)
          ? 'Ce navigateur ne reçoit pas les notifications.'
          : null;
  return (
    <main className="page">
      <h1 className="titre-ecran">Notifications</h1>
      {indisponible ? (
        <p>{indisponible}</p>
      ) : (
        push && (
          <>
            {push.abonne && <p>Les notifications sont actives sur ce téléphone</p>}
            <button disabled={!!horsLigne || occupe} onClick={() => void agir()}>
              {push.abonne ? 'Couper les notifications' : 'Activer les notifications'}
            </button>
          </>
        )
      )}
      {erreur && <p role="alert">{erreur}</p>}
      <Link to="/appareils">Appareils connectés</Link>
    </main>
  );
}
