import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';

// Coquille hors-ligne (web/public/sw.js) : seule une réponse réussie entre dans le cache.
function charger(response: { ok: boolean }) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const put = vi.fn();
  const clone = vi.fn(() => ({ copie: true }));
  const self = {
    location: { origin: 'http://127.0.0.1:4870' },
    addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn),
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  runInNewContext(readFileSync(join(import.meta.dirname, '../web/public/sw.js'), 'utf8'), {
    self,
    URL,
    fetch: async () => ({ ...response, clone }),
    caches: { open: async () => ({ put }), match: async () => undefined },
  });
  return { listeners, put, clone };
}

async function naviguer(response: { ok: boolean }) {
  const sw = charger(response);
  let reponse: Promise<unknown> | undefined;
  sw.listeners.fetch!({
    request: { method: 'GET', url: 'http://127.0.0.1:4870/', mode: 'navigate' },
    respondWith: (p: Promise<unknown>) => (reponse = p),
  });
  await reponse;
  await new Promise((r) => setTimeout(r, 0));
  return sw;
}

test('sw : une réponse 200 est mise en cache sous la clé /', async () => {
  const sw = await naviguer({ ok: true });
  expect(sw.put).toHaveBeenCalledWith('/', { copie: true });
});

test('sw : une réponse en erreur (401, 500) n’est pas mise en cache', async () => {
  const sw = await naviguer({ ok: false });
  expect(sw.put).not.toHaveBeenCalled();
});
