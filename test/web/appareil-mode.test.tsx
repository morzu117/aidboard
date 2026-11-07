// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AppAppareil } from '../../web/src/AppAppareil.js';
import { AidClient } from '../../web/src/data/client.js';
import { afterEach, expect, test, vi } from 'vitest';
import { FakeSocket } from './helpers.js';
import { detecterMode } from '../../web/src/data/appareil.js';

const moi = { id: 'ap_test', nom: 'Téléphone', expireA: '2026-11-07T18:00:00Z' };
const reseau = vi.fn(async () => {
  throw new TypeError('Réseau indisponible');
});
const reponse = (status: number, corps: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(corps), { status }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

test('32.2 : à froid sans réseau, seule la marque retient le mode appareil', async () => {
  expect(await detecterMode(reseau)).toEqual({ kind: 'mac' });
  localStorage.setItem('aid.mode', 'appareil');
  expect(await detecterMode(reseau)).toEqual({ kind: 'appareil', moi: null });
  expect(await detecterMode(reponse(404))).toEqual({ kind: 'mac' });
});

test('32.2 : 200 pose la marque, 401 l’efface quelle que soit sa raison', async () => {
  for (const raison of [null, 'inconnu', 'expire', 'revoque']) {
    expect(await detecterMode(reponse(200, moi))).toEqual({ kind: 'appareil', moi });
    expect(localStorage.getItem('aid.mode')).toBe('appareil');
    await detecterMode(reponse(401, { raison }));
    expect(localStorage.getItem('aid.mode')).toBeNull();
  }
});

test('32.2 : un stockage inaccessible ne casse aucune réponse', async () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('Interdit');
  });
  expect(await detecterMode(reseau)).toEqual({ kind: 'mac' });
  expect(await detecterMode(reponse(200, moi))).toEqual({ kind: 'appareil', moi });
  expect(await detecterMode(reponse(401, { raison: 'expire' }))).toEqual({
    kind: 'hors-acces',
    raison: 'expire',
  });
});

test('32.2 : le démarrage appareil sans identité montre Mac injoignable', async () => {
  localStorage.setItem('aid.mode', 'appareil');
  const mode = await detecterMode(reseau);
  if (mode.kind !== 'appareil') throw new Error('Mode appareil attendu');
  const client = new AidClient({ fetchImpl: reseau, backoffMs: [1] });
  render(
    <MemoryRouter>
      <AppAppareil mode={mode} client={client} />
    </MemoryRouter>,
  );
  expect(await screen.findByText('Mac injoignable. Nouvel essai…')).toBeTruthy();
  expect(client.getSnapshot().appareil).toBeUndefined();
});

test.each([200, 401])(
  '32.2 : au retour du Mac, relire l’identité une fois (%s)',
  async (statut) => {
    FakeSocket.all = [];
    localStorage.setItem('aid.mode', 'appareil');
    let joignable = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (!joignable) throw new TypeError('Réseau indisponible');
      if (url === '/api/appareils/moi')
        return new Response(JSON.stringify(statut === 200 ? moi : { raison: 'revoque' }), {
          status: statut,
        });
      return new Response(
        JSON.stringify({ workspaces: [], topics: [], agents: [], runs: [], actions: [] }),
      );
    });
    const mode = await detecterMode(fetchImpl);
    if (mode.kind !== 'appareil') throw new Error('Mode appareil attendu');
    const client = new AidClient({
      fetchImpl,
      flux: 'signal',
      backoffMs: [10],
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    render(
      <MemoryRouter>
        <AppAppareil mode={mode} client={client} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Mac injoignable. Nouvel essai…')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    joignable = true;
    await waitFor(() => expect(FakeSocket.all.length).toBe(1));
    await act(async () => FakeSocket.all[0]!.open());
    if (statut === 200) {
      expect(await screen.findByRole('navigation', { name: 'Navigation' })).toBeTruthy();
      expect(screen.getByText(/Ton Mac · tailnet/)).toBeTruthy();
      await act(async () => {
        await client.refresh();
        await client.refresh();
      });
    } else {
      expect(await screen.findByRole('heading', { name: 'Accès coupé' })).toBeTruthy();
      expect(localStorage.getItem('aid.mode')).toBeNull();
    }
    expect(fetchImpl.mock.calls.filter(([url]) => url === '/api/appareils/moi')).toHaveLength(2);
  },
);
