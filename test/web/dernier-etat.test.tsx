// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EtatPourAppareil } from '../../src/shared/host.js';
import { AppAppareil } from '../../web/src/AppAppareil.js';
import { detecterMode } from '../../web/src/data/appareil.js';
import { AidClient } from '../../web/src/data/client.js';
import { effacer, garder, relire } from '../../web/src/data/dernierEtat.js';
import { HorsAcces } from '../../web/src/ui/HorsAcces.js';
import { FakeSocket } from './helpers.js';
import { indexedDBMemoire } from './indexedDBMemoire.js';

const etat: EtatPourAppareil = {
  lastEventId: null,
  workspaces: [{ id: 'ws_test', name: 'Projet conservé' }],
  topics: [],
  runs: [],
  actions: [],
  agents: [],
};
const moi = { id: 'ap_test', nom: 'Téléphone', expireA: '2026-11-07T18:00:00Z' };
let stockage: ReturnType<typeof indexedDBMemoire>;
let client: AidClient | undefined;
beforeEach(() => {
  stockage = indexedDBMemoire();
  vi.stubGlobal('indexedDB', stockage.fabrique);
  FakeSocket.all = [];
});
afterEach(async () => {
  cleanup();
  client?.stop();
  client = undefined;
  vi.useRealTimers();
  await effacer();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

test('32.8 : garder, relire, remplacer et effacer une seule entrée masquée et datée', async () => {
  expect(await relire()).toBeNull();
  await garder(etat);
  expect(await relire()).toEqual({ etat, lu: expect.any(String) });
  expect(Number.isNaN(Date.parse((await relire())!.lu))).toBe(false);
  await garder({ ...etat, lastEventId: 'ev_suivant' });
  expect(stockage.donnees.size).toBe(1);
  localStorage.setItem('aid.mode', 'appareil');
  await effacer();
  expect(await relire()).toBeNull();
  expect(localStorage.getItem('aid.mode')).toBeNull();
});

test.each(['ouverture', 'transaction', 'ecriture', 'asynchrone'] as const)(
  '32.8 : IndexedDB en échec (%s) reste facultatif',
  async (defaut) => {
    stockage.defauts[defaut] = true;
    await expect(garder(etat)).resolves.toBeUndefined();
    await expect(relire()).resolves.toBeNull();
    await expect(effacer()).resolves.toBeUndefined();
  },
);

test.each([12, 125])(
  '32.8 : à froid sans Mac, dernier état de %s minutes en lecture seule',
  async (minutes) => {
    await garder(etat);
    const lu = (await relire())!.lu;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(lu) + minutes * 60_000);
    localStorage.setItem('aid.mode', 'appareil');
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Réseau indisponible');
    });
    const mode = await detecterMode(fetchImpl);
    if (mode.kind !== 'appareil') throw new Error('Mode appareil attendu');
    client = new AidClient({ flux: 'signal', fetchImpl, backoffMs: [20] });
    render(
      <MemoryRouter initialEntries={['/appareils']}>
        <AppAppareil mode={mode} client={client} />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(`Dernier état connu il y a ${minutes < 60 ? '12 min' : '2 h'}`),
    ).toBeTruthy();
    expect(
      screen.getByText("A-I-D n'a pas pu te prévenir de ce qui s'est passé depuis."),
    ).toBeTruthy();
    expect(screen.getByText('Mac injoignable')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(client.getSnapshot()).toMatchObject({ appareil: etat, horsLigne: true });
  },
);

test.each(['demarrage', 'requete', 'socket', 'hors-acces'])(
  '32.8 : la fin d’accès (%s) efface l’état et la marque',
  async (origine) => {
    await garder(etat);
    localStorage.setItem('aid.mode', 'appareil');
    const refuse = vi.fn(
      async () => new Response(JSON.stringify({ raison: 'revoque' }), { status: 401 }),
    );
    if (origine === 'demarrage') await detecterMode(refuse);
    if (origine === 'hors-acces') render(<HorsAcces fin="revoque" />);
    if (origine === 'requete') {
      client = new AidClient({ flux: 'signal', fetchImpl: refuse });
      await expect(client.request('GET', '/api/appareils')).rejects.toThrow('session expirée');
    }
    if (origine === 'socket') {
      client = new AidClient({
        flux: 'signal',
        fetchImpl: vi.fn(async () => new Response(JSON.stringify(etat))),
        socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
      });
      client.start();
      await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
      (FakeSocket.all[0]!.onclose as unknown as (e: { code: number }) => void)({ code: 4401 });
    }
    expect(await relire()).toBeNull();
    expect(localStorage.getItem('aid.mode')).toBeNull();
  },
);

test('32.8 : seul le flux masqué conserve un état ; une réponse tardive après 401 est ignorée', async () => {
  let repondre: (r: Response) => void = () => undefined;
  const fetchImpl = vi.fn((url: string | URL | Request) =>
    url === '/api/state'
      ? new Promise<Response>((resolve) => {
          repondre = resolve;
        })
      : Promise.resolve(new Response('{}', { status: 401 })),
  );
  client = new AidClient({ flux: 'signal', fetchImpl });
  const lecture = client.refresh();
  await expect(client.request('GET', '/api/appareils')).rejects.toThrow();
  repondre(new Response(JSON.stringify(etat)));
  await lecture;
  expect(await relire()).toBeNull();
  expect(client.getSnapshot().appareil).toBeUndefined();
  const mac = new AidClient({ fetchImpl: vi.fn(async () => new Response(JSON.stringify(etat))) });
  await mac.refresh();
  expect(await relire()).toBeNull();
});

test('32.8 : un état masqué reçu est conservé, puis horsLigne revient à faux au retour du Mac', async () => {
  client = new AidClient({
    flux: 'signal',
    fetchImpl: vi.fn(async () => new Response(JSON.stringify(etat))),
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  client.start();
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  await act(async () => FakeSocket.all[0]!.open());
  expect(client.getSnapshot().horsLigne).toBe(false);
  expect((await relire())?.etat).toEqual(etat);
});

test('32.8 : Me déconnecter efface l’état et la marque', async () => {
  localStorage.setItem('aid.mode', 'appareil');
  client = new AidClient({
    flux: 'signal',
    fetchImpl: vi.fn(
      async (url) =>
        new Response(
          JSON.stringify(
            url === '/api/state'
              ? etat
              : url === '/api/appareils'
                ? [
                    {
                      ...moi,
                      creeA: '2026-11-07T10:00:00Z',
                      dernierContact: null,
                      etat: 'actif',
                      moi: true,
                    },
                  ]
                : {},
          ),
        ),
    ),
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  render(
    <MemoryRouter initialEntries={['/appareils']}>
      <AppAppareil mode={{ kind: 'appareil', moi }} client={client} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  act(() => FakeSocket.all[0]!.open());
  expect((await relire())?.etat).toEqual(etat);
  fireEvent.click(await screen.findByRole('button', { name: 'Me déconnecter' }));
  expect(await screen.findByText('Appareil déconnecté')).toBeTruthy();
  expect(await relire()).toBeNull();
  expect(localStorage.getItem('aid.mode')).toBeNull();
});

async function connexionVivante() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const reseau = { joignable: true };
  client = new AidClient({
    flux: 'signal',
    backoffMs: [1000],
    fetchImpl: vi.fn(async () => {
      if (!reseau.joignable) throw new TypeError('Réseau indisponible');
      return new Response(JSON.stringify(etat));
    }),
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  expect(client.getSnapshot().horsLigne).toBe(false);
  await act(async () => {
    render(
      <MemoryRouter>
        <AppAppareil mode={{ kind: 'appareil', moi }} client={client} />
      </MemoryRouter>,
    );
  });
  expect(client.getSnapshot().horsLigne).toBe(false);
  expect(screen.getByRole('navigation', { name: 'Cockpit' })).toBeTruthy();
  act(() => FakeSocket.all[0]!.open());
  reseau.joignable = false;
  act(() => FakeSocket.all[0]!.onclose?.());
  return reseau;
}

test('32.8 : un seul échec garde la barre et la bannière Reconnexion', async () => {
  await connexionVivante();
  expect(client!.getSnapshot()).toMatchObject({ daemon: 'reconnexion', horsLigne: false });
  expect(screen.getByRole('navigation', { name: 'Cockpit' })).toBeTruthy();
  expect(screen.getByText('Reconnexion…')).toBeTruthy();
  expect(screen.queryByText('Mac injoignable')).toBeNull();
  expect(screen.queryByText(/Dernier état connu/)).toBeNull();
});

test('32.8 : trois échecs passent à l’écran hors ligne', async () => {
  await connexionVivante();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(client!.getSnapshot()).toMatchObject({ daemon: 'reconnexion', horsLigne: false });
  expect(screen.getByRole('navigation', { name: 'Cockpit' })).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(client!.getSnapshot()).toMatchObject({ daemon: 'injoignable', horsLigne: true });
  expect(screen.getByText('Mac injoignable')).toBeTruthy();
  expect(screen.queryByRole('navigation')).toBeNull();
});

test('32.8 : le retour du Mac retire horsLigne et rétablit la barre', async () => {
  const reseau = await connexionVivante();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(client!.getSnapshot().horsLigne).toBe(true);
  reseau.joignable = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  act(() => FakeSocket.all[1]!.open());
  expect(client!.getSnapshot()).toMatchObject({ daemon: 'connecte', horsLigne: false });
  expect(screen.getByRole('navigation', { name: 'Cockpit' })).toBeTruthy();
  expect(screen.queryByText('Mac injoignable')).toBeNull();
});

test('32.8 : une lecture vivante remplace la provenance IndexedDB pendant la reconnexion', async () => {
  await garder(etat);
  let joignable = false;
  client = new AidClient({
    flux: 'signal',
    backoffMs: [60_000],
    fetchImpl: vi.fn(async () => {
      if (!joignable) throw new TypeError('Réseau indisponible');
      return new Response(JSON.stringify(etat));
    }),
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  await act(async () => {
    render(
      <MemoryRouter>
        <AppAppareil mode={{ kind: 'appareil', moi }} client={client} />
      </MemoryRouter>,
    );
  });
  expect(client.getSnapshot()).toMatchObject({ daemon: 'reconnexion', horsLigne: true });
  expect(screen.getByText('Mac injoignable')).toBeTruthy();
  joignable = true;
  await act(async () => client!.retry());
  expect(client.getSnapshot()).toMatchObject({ daemon: 'reconnexion', horsLigne: false });
  expect(screen.getByRole('navigation', { name: 'Cockpit' })).toBeTruthy();
  expect(screen.getByText('Reconnexion…')).toBeTruthy();
  act(() => FakeSocket.all[0]!.open());
  expect(client.getSnapshot().horsLigne).toBe(false);
});
