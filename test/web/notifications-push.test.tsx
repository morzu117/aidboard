// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { NotificationsAppareil } from '../../web/src/ui/NotificationsAppareil.js';
import { json, setup, snapshot } from './helpers.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function ouvrir({
  actif = true,
  abonne = false,
  permission = 'granted',
  iphone = false,
  api = true,
  raison = '',
} = {}) {
  const ordre: string[] = [];
  const requestPermission = vi.fn(async () => {
    ordre.push('permission');
    return permission;
  });
  if (api) {
    vi.stubGlobal('Notification', { requestPermission });
    vi.stubGlobal('PushManager', class {});
  } else {
    Reflect.deleteProperty(window, 'Notification');
    Reflect.deleteProperty(window, 'PushManager');
  }
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(iphone ? 'iPhone Safari' : 'Android');
  const unsubscribe = vi.fn(async () => {
    ordre.push('unsubscribe');
    return true;
  });
  const subscribe = vi.fn(async () => {
    ordre.push('subscribe');
    return {
      toJSON: () => ({
        endpoint: 'https://fcm.googleapis.com/example',
        expirationTime: null,
        keys: { p256dh: 'publique', auth: 'auth' },
      }),
    };
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: { subscribe, getSubscription: async () => ({ unsubscribe }) },
      }),
    },
  });
  const post = vi.fn(() => {
    ordre.push('POST');
    if (raison) return new Response(JSON.stringify({ raison }), { status: 403 });
    return new Response(null, { status: 204 });
  });
  const supprimer = vi.fn(() => {
    ordre.push('DELETE');
    return new Response(null, { status: 204 });
  });
  setup(<NotificationsAppareil />, snapshot({}), '/notifications', {
    'GET /api/appareils/moi': json(200, { push: { actifSurLeMac: actif, abonne } }),
    'GET /api/appareils/push/cle': () => {
      ordre.push('cle');
      return new Response(JSON.stringify({ cle: 'AQID-_8' }));
    },
    'POST /api/appareils/moi/push': post,
    'DELETE /api/appareils/moi/push': supprimer,
  });
  return { ordre, requestPermission, subscribe, unsubscribe, post, supprimer };
}

test('32b.6 : activation uniquement au clic, clé décodée et corps strict', async () => {
  const h = ouvrir();
  const bouton = await screen.findByText('Activer les notifications');
  expect(h.requestPermission).not.toHaveBeenCalled();
  fireEvent.click(bouton);
  await screen.findByText('Les notifications sont actives sur ce téléphone');
  expect(h.ordre).toEqual(['permission', 'cle', 'subscribe', 'POST']);
  expect(h.subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: new Uint8Array([1, 2, 3, 251, 255]),
  });
  expect(h.post).toHaveBeenCalledWith({
    endpoint: 'https://fcm.googleapis.com/example',
    keys: { p256dh: 'publique', auth: 'auth' },
  });
});

test('32b.6 : permission refusée sans abonnement', async () => {
  const h = ouvrir({ permission: 'denied' });
  fireEvent.click(await screen.findByText('Activer les notifications'));
  await screen.findByRole('alert');
  expect(h.subscribe).not.toHaveBeenCalled();
  expect(h.post).not.toHaveBeenCalled();
});

test('32b.6 : couper désabonne avant DELETE', async () => {
  const h = ouvrir({ abonne: true });
  fireEvent.click(await screen.findByText('Couper les notifications'));
  await waitFor(() => expect(h.supprimer).toHaveBeenCalledOnce());
  expect(h.ordre).toEqual(['unsubscribe', 'DELETE']);
});

test.each([
  [{ actif: false }, 'Les notifications sont coupées sur le Mac.'],
  [{ iphone: true }, "Installe A-I-D sur l'écran d'accueil pour recevoir les notifications."],
  [{ api: false }, 'Ce navigateur ne reçoit pas les notifications.'],
])('32b.6 : indisponibilité %j', async (options, texte) => {
  const h = ouvrir(options);
  await screen.findByText(texte);
  expect(screen.queryByRole('button')).toBeNull();
  expect(h.requestPermission).not.toHaveBeenCalled();
});

test.each([
  ['push_coupe', 'Les notifications sont coupées sur le Mac.'],
  ['endpoint', 'Ce service de notifications est refusé par le Mac.'],
  ['cles', 'Les clés de cet abonnement sont invalides.'],
])('32b.6 : refus du serveur %s', async (raison, texte) => {
  ouvrir({ raison });
  fireEvent.click(await screen.findByText('Activer les notifications'));
  expect((await screen.findByRole('alert')).textContent).toBe(texte);
});
