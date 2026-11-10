// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Route, Routes } from 'react-router';
import { Board } from '../../web/src/ecrans/Board.js';
import { CarteBoard } from '../../web/src/ecrans/CarteBoard.js';
import { BOARD_RELECTURE_MS } from '../../web/src/data/board.js';
import {
  LIBELLES_SWAIRM,
  type BoardSwairm,
  type SujetBoardSwairm,
} from '../../web/src/data/swairm-board.js';
import { AidClient } from '../../web/src/data/client.js';
import { AidProvider } from '../../web/src/data/useAidState.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

const date = '2026-11-10T10:00:00Z';
const ok = <T,>(data: T) => ({ ok: true as const, data, readAt: date, schemaVersion: null });
const sujet = (over: Partial<SujetBoardSwairm> = {}): SujetBoardSwairm => ({
  projet: 'exemple/depot',
  id: '41',
  titre: 'Un sujet',
  etat: 'planned',
  colonne: 'travail',
  en_pause: false,
  pas: { total: 3, par_etat: { done: 2, todo: 1 } },
  maj: date,
  vol: null,
  carte: 101,
  conflit: [],
  ...over,
});
const reponse = (sujets: SujetBoardSwairm[]): BoardSwairm => ({
  sujets,
  cartes: [],
  board: ok({ cards: [], due: [], searched: 0 }),
  swairm: { etat: 'ok', data: { projets: [], erreurs: [] } },
});
const etat = snapshot({
  mesh: {
    state: {
      ecritures: false,
      proxyConfigure: false,
      connected: true,
      tailscale: 'running',
      monitor: 'running',
      pending: 0,
      since: null,
      cell: 'cellule-test',
    },
    inbox: [],
    tailscaleManage: false,
  },
});
async function ouvrir(r: BoardSwairm, fiche = false) {
  const h = setup(
    <Routes>
      <Route path="/board" element={<Board />} />
      <Route path="/board/cartes/:cardId" element={<CarteBoard />} />
    </Routes>,
    etat,
    fiche ? '/board/cartes/101' : '/board',
    {
      'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
      'GET /api/swairm/board': json(200, r),
      'GET /api/board/cards/101': json(
        200,
        Object.fromEntries(
          ['card', 'graph', 'thread', 'obligations'].map((cle) => [
            cle,
            { ok: false, kind: 'not-found', readAt: date },
          ]),
        ),
      ),
      'GET /api/board/projects': json(
        200,
        ok([
          { id: 42, slug: 'exemple', title: 'Exemple', status: 'active', author: 'cellule-test' },
        ]),
      ),
      'GET /api/board/projects/42/cards': json(
        200,
        ok(
          [101, 102].map((id) => ({
            id,
            projectId: 42,
            title: `Carte ${id}`,
            stage: 'build',
            assignee: null,
            dueAt: null,
            openObligations: 0,
          })),
        ),
      ),
    },
  );
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  await waitFor(() => expect(h.calls.some((c) => c.url === '/api/swairm/board')).toBe(true));
  return h;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test.each([
  ...Object.entries(LIBELLES_SWAIRM),
  ['<b>inconnu</b>', '<b>inconnu</b>'],
  ['toString', 'toString'],
])('état %s en texte brut sur la carte', async (etat, libelle) => {
  await ouvrir(reponse([sujet({ etat })]));
  const pastille = await screen.findByText(`Swairm · ${libelle}`);
  expect(pastille.closest('a')?.getAttribute('href')).toBe('/board/cartes/101');
  expect(pastille.querySelector('b')).toBeNull();
});

test('plusieurs sujets par carte et conflit sur chacune des cartes', async () => {
  await ouvrir(
    reponse([
      sujet(),
      sujet({ id: '42', etat: 'queued' }),
      sujet({ id: '43', carte: null, conflit: [101, 102] }),
    ]),
  );
  await screen.findByText('Swairm · en file');
  expect(screen.getAllByText('Lien en double : cartes #101, #102.')).toHaveLength(2);
  expect(screen.getByText('Sujets Swairm sans carte (0)')).toBeTruthy();
});

test('fiche : projet, id, colonne, pas, pause, vol et dates en texte brut', async () => {
  await ouvrir(
    reponse([
      sujet({
        projet: '<b>exemple/depot</b>',
        en_pause: true,
        vol: { cible: '41', machine: 'example.com', depuis: date, pid: 12, tenant: 'test' },
      }),
    ]),
    true,
  );
  await screen.findByRole('heading', { name: 'Swairm' });
  expect(screen.getByText('Swairm · planifié')).toBeTruthy();
  expect(screen.getByText('<b>exemple/depot</b>').querySelector('b')).toBeNull();
  for (const texte of [
    '41',
    'travail',
    'Pas : total',
    '3',
    'done',
    '2',
    'todo',
    '1',
    'en pause',
    'maj',
    date,
  ])
    expect(screen.getByText(texte)).toBeTruthy();
  expect(screen.getByText(`Vol en cours : example.com · depuis ${date}`)).toBeTruthy();
});

test('fiche : pas de pause ni vol inventés ; conflit à la place de l’état', async () => {
  await ouvrir(reponse([sujet({ carte: null, conflit: [101, 102] })]), true);
  await screen.findByText('Lien en double : cartes #101, #102.');
  expect(screen.queryByText('Swairm · planifié')).toBeNull();
  expect(screen.queryByText('en pause')).toBeNull();
  expect(screen.queryByText(/Vol en cours/)).toBeNull();
});

test('sans carte : replié, nombre vivant, terminés masqués, deux copies exactes et erreur du presse-papiers', async () => {
  const copier = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: copier },
  });
  await ouvrir(
    reponse([
      sujet({ carte: null, titre: 'Titre "double" et \'simple\' $(id) `id`\n<b>brut</b>' }),
      sujet({ carte: null, id: '42', etat: 'merged', titre: 'terminé mergé' }),
      sujet({ carte: null, id: '43', etat: 'abandoned', titre: 'terminé abandonné' }),
    ]),
  );
  const titre = await screen.findByText('Sujets Swairm sans carte (1)');
  const details = titre.closest('details')!;
  expect(details.open).toBe(false);
  fireEvent.click(titre);
  expect(screen.queryByText('terminé mergé')).toBeNull();
  expect(screen.queryByText('terminé abandonné')).toBeNull();
  expect(screen.getByText('2 sujets merged ou abandoned sans carte non listés.')).toBeTruthy();
  expect(details.querySelector('b')).toBeNull();
  fireEvent.click(within(details).getByRole('button', { name: 'Copier la ligne' }));
  await waitFor(() => expect(copier).toHaveBeenNthCalledWith(1, 'Swairm: exemple/depot#41'));
  fireEvent.click(within(details).getByRole('button', { name: 'Copier la commande' }));
  await waitFor(() =>
    expect(copier).toHaveBeenNthCalledWith(
      2,
      "swarph board cards create --project <PROJET> --title 'Titre \"double\" et '\"'\"'simple'\"'\"' $(id) `id`\n<b>brut</b>' --body 'Swairm: exemple/depot#41'",
    ),
  );
  copier.mockRejectedValueOnce(new Error('refus'));
  fireEvent.click(within(details).getByRole('button', { name: 'Copier la ligne' }));
  await screen.findByText('Copie impossible : accès au presse-papiers refusé.');
});

test.each(['format', 'timeout', 'lecture'] as const)(
  'erreur Swairm %s sans effacer les cartes',
  async (erreur) => {
    const r = reponse([]);
    r.swairm = { etat: 'erreur', erreur };
    await ouvrir(r);
    await screen.findByText(`Swairm : ${erreur}.`);
    expect(await screen.findByText('Carte 101')).toBeTruthy();
  },
);

test('non configuré et liens illisibles', async () => {
  const r = reponse([]);
  r.swairm = { etat: 'non-configure' };
  r.board = { ok: false, kind: 'timeout', readAt: date };
  await ouvrir(r);
  await screen.findByText("Swairm n'est pas configuré.");
  expect(screen.getByText("Les liens n'ont pas pu être lus.")).toBeTruthy();
});

test('erreurs partielles : les sujets restent affichés', async () => {
  const r = reponse([sujet({ carte: null })]);
  r.board = { ok: false, kind: 'timeout', readAt: date };
  r.swairm = {
    etat: 'ok',
    data: {
      projets: [],
      erreurs: [{ projet: 'exemple/autre', board: 'board', erreur: '<b>illisible</b>' }],
    },
  };
  await ouvrir(r);
  await screen.findByText('Swairm : <b>illisible</b>.');
  expect(screen.getByText("Les liens n'ont pas pu être lus.")).toBeTruthy();
  fireEvent.click(screen.getByText('Sujets Swairm sans carte (1)'));
  expect(screen.getByRole('button', { name: 'Copier la ligne' })).toBeTruthy();
  expect(screen.getByText('Swairm : <b>illisible</b>.').querySelector('b')).toBeNull();
});

test('relecture au rythme des cartes, arrêt écran démonté et onglet masqué, erreur réseau conserve la lecture', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const h = await ouvrir(reponse([sujet()]));
  await screen.findByText('Swairm · planifié');
  const compter = () => h.calls.filter((c) => c.url === '/api/swairm/board').length;
  const avant = compter();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BOARD_RELECTURE_MS);
  });
  expect(compter()).toBe(avant + 1);
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BOARD_RELECTURE_MS);
  });
  expect(compter()).toBe(avant + 1);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  h.respond.set('GET /api/swairm/board', () => {
    throw new Error('lecture interrompue');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BOARD_RELECTURE_MS);
  });
  expect(screen.getByText('Swairm · planifié')).toBeTruthy();
  expect(screen.getByText('Swairm : lecture interrompue.')).toBeTruthy();
  cleanup();
  const fin = compter();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BOARD_RELECTURE_MS);
  });
  expect(compter()).toBe(fin);
});

// Le port host n'a pas de state admin : même un contenu monté ne doit pas lire Swairm.
test('host : aucun appel Swairm', async () => {
  const { SansCarteSwairm } = await import('../../web/src/ui/SwairmBoard.js');
  const appels: string[] = [];
  const client = new AidClient({
    flux: 'signal',
    fetchImpl: (async (url: string) => {
      appels.push(url);
      return new Response(JSON.stringify({ mesh: null }), { status: 200 });
    }) as typeof fetch,
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  render(
    <AidProvider client={client}>
      <SansCarteSwairm />
    </AidProvider>,
  );
  await waitFor(() => expect(client.getSnapshot().appareil).toBeTruthy());
  act(() => FakeSocket.all.at(-1)!.open());
  expect(appels).not.toContain('/api/swairm/board');
});
