import { afterEach, expect, test, vi } from 'vitest';
import { parseConfig, validerRelais } from '../src/daemon/config.js';
import { startTestDaemon } from './helpers/daemon.js';

const nettoyages: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const f of nettoyages.splice(0).reverse()) await f();
});
test('relais : null par défaut et une origine HTTPS stricte au chargement', () => {
  expect(parseConfig('').modeHost.relais).toBeNull();
  for (const relais of [
    null,
    'https://example.com',
    'https://example.com/',
    'https://example.com:443',
  ]) {
    expect(parseConfig(`modeHost:\n  relais: ${JSON.stringify(relais)}`).modeHost.relais).toBe(
      relais,
    );
  }
});
const invalides = [
  'http://example.com',
  'https://example.com:444',
  'https://example.com/a',
  'https://192.0.2.1',
  'https://[::1]',
  'https://user@example.com',
  'https://user:secret@example.com',
  'https://example.com.',
  'https://example.com?q=1',
  'https://example.com#x',
  'https://example.com?',
  'https://example.com#',
  'https://example.com/a/..',
  42,
];
for (const relais of invalides)
  test(`refus configuration ${relais}`, () => {
    expect(() => validerRelais(relais)).toThrow();
    expect(() => parseConfig(`modeHost:\n  relais: ${JSON.stringify(relais)}`)).toThrow();
  });
test('routes admin : 409 sans relais/host, refus au PUT, essais sans nom et arrêt', async () => {
  const transport = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status: 204 }));
  nettoyages.push(() => transport.mockRestore());
  const t = await startTestDaemon();
  nettoyages.push(() => t.d.stop());
  const put = (payload: unknown) =>
    t.d.app.inject({
      method: 'PUT',
      url: '/api/host/pda',
      headers: t.headers,
      payload: payload as never,
    });
  expect((await put({ actif: true })).statusCode).toBe(409);
  expect((await put({ actif: true, relais: 'https://example.com' })).statusCode).toBe(409);
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: true },
  });
  expect((await put({ actif: true })).statusCode).toBe(409);
  for (const relais of invalides) expect((await put({ actif: true, relais })).statusCode).toBe(400);
  expect((await put({ actif: true, relais: 'https://example.com' })).statusCode).toBe(200);
  const essai = () =>
    t.d.app.inject({
      method: 'POST',
      url: '/api/host/pda/essai',
      headers: t.headers,
      payload: { sujet: 'Exemple' },
    });
  expect((await essai()).statusCode).toBe(409);
  t.d.modeHost.noterNom('aid-e2e.ts.net');
  const r = await essai();
  expect(r.statusCode).toBe(200);
  const id = r.json().id;
  const lire = () =>
    t.d.app.inject({ method: 'GET', url: `/api/host/pda/demandes/${id}`, headers: t.headers });
  expect((await lire()).json()).toEqual({ etat: 'ouverte' });
  expect((await put({ actif: false })).statusCode).toBe(200);
  expect((await essai()).statusCode).toBe(409);
  expect((await put({ actif: true })).statusCode).toBe(200);
  expect((await lire()).json()).toEqual({ etat: 'expiree' });
});

test('un dépôt refusé par le relais donne 502 et expire la demande', async () => {
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_url, options) =>
      new Response(null, {
        status: options?.method === 'PUT' && String(_url).includes('/demandes/') ? 500 : 204,
      }),
  );
  nettoyages.push(() => transport.mockRestore());
  const t = await startTestDaemon();
  nettoyages.push(() => t.d.stop());
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: true },
  });
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host/pda',
    headers: t.headers,
    payload: { actif: true, relais: 'https://example.com' },
  });
  t.d.modeHost.noterNom('aid-e2e.ts.net');
  const reponse = await t.d.app.inject({
    method: 'POST',
    url: '/api/host/pda/essai',
    headers: t.headers,
    payload: { sujet: 'Exemple' },
  });
  expect(reponse.statusCode).toBe(502);
  expect(reponse.json()).toEqual({ error: 'relais injoignable' });
  expect(t.db.prepare('SELECT etat FROM pda_demandes').all()).toEqual([{ etat: 'expiree' }]);
});
