import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

function lire(corps: unknown, invalide = false) {
  const handlers = new Map<string, (evenement: unknown) => void>();
  const afficher = vi.fn(() => Promise.resolve());
  runInNewContext(readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8'), {
    self: {
      addEventListener: (nom: string, fn: (e: unknown) => void) => handlers.set(nom, fn),
      registration: { showNotification: afficher },
    },
  });
  handlers.get('push')!({
    data: {
      json: () => {
        if (invalide) throw new Error('JSON invalide');
        return corps;
      },
    },
    waitUntil: () => {},
  });
  return afficher.mock.calls as unknown as Array<[string, { body: string }]>;
}
it('le service worker construit le texte exact depuis le seul id', () => {
  expect(lire({ c: 1234 })[0]).toMatchObject(['A-I-D', { body: 'Demande au commandant #1234' }]);
});
it('le compteur n conserve son comportement actuel', () => {
  expect(lire({ n: 1 })[0]![1].body).toBe("Une décision t'attend");
  expect(lire({ n: 3 })[0]![1].body).toBe("3 décisions t'attendent");
});
it.each([
  null,
  {},
  { c: '1234' },
  { c: -1 },
  { c: 1.5 },
  { c: Number.MAX_SAFE_INTEGER + 1 },
  { c: 1, summary: 'interdit' },
  { c: 1, n: 3 },
  { c: null },
])('une charge mal formée conserve le texte générique %#', (charge) => {
  expect(lire(charge)[0]![1].body).toBe("Une décision t'attend");
});
it('une charge JSON illisible conserve le texte générique', () =>
  expect(lire(null, true)[0]![1].body).toBe("Une décision t'attend"));
