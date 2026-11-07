import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';

function coque(status: number, presente = true, mode = 'navigate', chemin = '/') {
  const ancienne = new Response('coque ancienne');
  const fraiche = new Response('réseau', { status });
  const put = vi.fn();
  const match = vi.fn(async () => (presente ? ancienne : undefined));
  let recevoir!: (event: unknown) => void;
  runInNewContext(readFileSync('web/public/sw.js', 'utf8'), {
    self: {
      location: { origin: 'https://exemple.invalid' },
      addEventListener: (nom: string, rappel: typeof recevoir) => {
        if (nom === 'fetch') recevoir = rappel;
      },
    },
    URL,
    fetch: async () => fraiche,
    caches: { match, open: async () => ({ put }) },
  });
  const respondWith = vi.fn();
  recevoir({
    request: { method: 'GET', url: `https://exemple.invalid${chemin}`, mode },
    respondWith,
  });
  return { ancienne, fraiche, put, respondWith };
}

test('32.2 : une navigation non 200 garde et sert la coque', async () => {
  for (const statut of [401, 404, 502]) {
    const h = coque(statut);
    expect(await h.respondWith.mock.calls[0]![0]).toBe(h.ancienne);
    expect(h.put).not.toHaveBeenCalled();
  }
});

test('32.2 : une navigation 200 met à jour la coque', async () => {
  const h = coque(200);
  expect(await h.respondWith.mock.calls[0]![0]).toBe(h.fraiche);
  expect(h.put).toHaveBeenCalledWith('/', expect.any(Response));
  expect(await h.put.mock.calls[0]![1].text()).toBe('réseau');
});

test('32.2 : sans coque, garder la réponse non 200', async () => {
  const h = coque(502, false);
  expect(await h.respondWith.mock.calls[0]![0]).toBe(h.fraiche);
  expect(h.put).not.toHaveBeenCalled();
});

test('32.2 : les chemins sensibles échappent au service worker', () => {
  for (const chemin of ['/api/state', '/ws/signal', '/auth', '/appairage/demande']) {
    expect(coque(200, true, 'navigate', chemin).respondWith).not.toHaveBeenCalled();
  }
});

test('32.8 : le manifeste et les icônes suivent le cache statique, en 200 seulement', async () => {
  for (const chemin of ['/manifest.webmanifest', '/icons/icon-256.png', '/icons/icon-512.png']) {
    for (const statut of [200, 404, 502]) {
      const h = coque(statut, true, 'cors', chemin);
      expect(await h.respondWith.mock.calls[0]![0]).toBe(h.fraiche);
      if (statut === 200) expect(h.put).toHaveBeenCalled();
      else expect(h.put).not.toHaveBeenCalled();
    }
  }
});

function notifications() {
  const rappels: Record<string, (event: unknown) => void> = {};
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const matchAll = vi.fn(async (): Promise<unknown[]> => []);
  runInNewContext(readFileSync('web/public/sw.js', 'utf8'), {
    self: {
      location: { origin: 'https://example.com' },
      addEventListener: (nom: string, rappel: (event: unknown) => void) => {
        rappels[nom] = rappel;
      },
      registration: { showNotification },
      clients: { openWindow, matchAll },
    },
    URL,
  });
  return { rappels, showNotification, openWindow, matchAll };
}

test.each([
  [{ n: 3 }, "3 décisions t'attendent"],
  [{ n: 1 }, "Une décision t'attend"],
  [{ n: 'abc' }, "Une décision t'attend"],
  [undefined, "Une décision t'attend"],
  ['invalide', "Une décision t'attend"],
])('32b.6 : chaque push affiche une notification (%j)', async (charge, body) => {
  const h = notifications();
  const waitUntil = vi.fn();
  h.rappels.push!({
    data:
      charge === undefined
        ? undefined
        : {
            json: () => {
              if (charge === 'invalide') throw new Error();
              return charge;
            },
          },
    waitUntil,
  });
  await waitUntil.mock.calls[0]![0];
  expect(h.showNotification).toHaveBeenCalledExactlyOnceWith('A-I-D', {
    body,
    tag: 'aid',
    renotify: true,
    icon: '/icons/icon-256.png',
  });
});

test.each([true, false])(
  '32b.6 : toucher ouvre la racine, client existant %s',
  async (existant) => {
    const h = notifications();
    const focus = vi.fn();
    const navigate = vi.fn();
    h.matchAll.mockResolvedValue(
      existant ? [{ url: 'https://example.com/sujets', focus, navigate }] : [],
    );
    const close = vi.fn();
    const waitUntil = vi.fn();
    h.rappels.notificationclick!({ notification: { close }, waitUntil });
    await waitUntil.mock.calls[0]![0];
    expect(close).toHaveBeenCalledOnce();
    if (existant) {
      expect(navigate).toHaveBeenCalledWith('/');
      expect(focus).toHaveBeenCalledOnce();
      expect(h.openWindow).not.toHaveBeenCalled();
    } else expect(h.openWindow).toHaveBeenCalledWith('/');
  },
);
