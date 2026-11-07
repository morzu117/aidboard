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
