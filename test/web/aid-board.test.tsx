// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Route, Routes } from 'react-router';
import { NouveauSujetCarte } from '../../web/src/ui/AidBoard.js';
import { Board } from '../../web/src/ecrans/Board.js';
import { CarteBoard } from '../../web/src/ecrans/CarteBoard.js';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { BOARD_RELECTURE_MS } from '../../web/src/data/board.js';
import { LIBELLES_AID, type BoardAid, type SujetBoardAid } from '../../web/src/data/aid-board.js';
import { AidClient } from '../../web/src/data/client.js';
import { AidProvider } from '../../web/src/data/useAidState.js';
import { FakeSocket, json, setup, snapshot, ws, topic } from './helpers.js';
const date = '2026-11-10T10:00:00Z';
const ok = <T,>(data: T) => ({ ok: true as const, data, readAt: date, schemaVersion: null });
const sujet = (over: Partial<SujetBoardAid> = {}): SujetBoardAid => ({
  agents: { enMarche: 2, enAttente: 1, termine: 0 },
  sujetId: 'tp_1',
  workspace: 'ws_1',
  slug: 's',
  titre: 'Un sujet',
  state: 'active',
  phase: 'dev',
  branch: 'feat/s',
  prNumber: 42,
  prUrl: null,
  lien: 'exemple/depot#s',
  carte: 101,
  conflit: [],
  ...over,
});
const reponse = (sujets: SujetBoardAid[]): BoardAid => ({
  sujets,
  cartes: [],
  board: ok({ cards: [], due: [], searched: 0 }),
  erreurs: [],
});
const etat = snapshot({
  workspaces: [ws()],
  topics: [topic()],
  mesh: {
    state: {
      ecritures: false,
      proxyConfigure: false,
      superviseur: null,
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
async function ouvrir(r: BoardAid, fiche: boolean | 'accueil' = false) {
  const h = setup(
    <Routes>
      <Route path="/" element={<Accueil />} />
      <Route path="/sujets/:id" element={<p>Sujet ouvert</p>} />
      <Route path="/board" element={<Board />} />
      <Route path="/board/cartes/:cardId" element={<CarteBoard />} />
    </Routes>,
    etat,
    fiche === 'accueil' ? '/' : fiche ? '/board/cartes/101' : '/board',
    {
      'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
      'GET /api/aid/board': json(200, r),
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
  await waitFor(() => expect(h.calls.some((c) => c.url === '/api/aid/board')).toBe(true));
  return h;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test.each([
  ...Object.entries(LIBELLES_AID),
  ['<b>inconnu</b>', '<b>inconnu</b>'],
  ['toString', 'toString'],
])('état %s en texte brut', async (state, libelle) => {
  await ouvrir(reponse([sujet({ state: state as SujetBoardAid['state'] })]));
  const pastille = await screen.findByText(`A-I-D · ${libelle}`);
  expect(pastille.closest('a')?.getAttribute('href')).toBe('/board/cartes/101');
  expect(pastille.querySelector('b')).toBeNull();
});
test('conflit sur chaque carte et sujet absent', async () => {
  const r = reponse([sujet({ carte: null, conflit: [101, 102] })]);
  r.cartes = [
    {
      id: 101,
      sujets: [{ lien: 'exemple/depot#absent', sujet: 'absent' }],
    } as BoardAid['cartes'][number],
  ];
  await ouvrir(r);
  expect(await screen.findAllByText('Lien A-I-D en double : cartes #101, #102.')).toHaveLength(2);
  expect(screen.queryByText('A-I-D · actif')).toBeNull();
  expect(screen.getByText("Sujet d'A-I-D absent de cette machine")).toBeTruthy();
});
test.each([null, 'https://github.com/exemple/depot/pull/42'])(
  'fiche, PR %s et navigation',
  async (prUrl) => {
    await ouvrir(reponse([sujet({ prUrl })]), true);
    await screen.findByRole('heading', { name: 'A-I-D' });
    for (const texte of ['aid', 'feat/s', 'Développement', 'actif', '#42'])
      expect(screen.getByText(texte)).toBeTruthy();
    expect(screen.queryByRole('link', { name: '#42' })?.getAttribute('href') ?? null).toBe(prUrl);
    expect(screen.getByText('2 en marche, 1 en attente, 0 terminé')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Ouvrir le sujet' }));
    await screen.findByText('Sujet ouvert');
  },
);
test.each([1, 2])(
  'Accueil : repli, états, copie exacte, sans remote et accord %i',
  async (nombre) => {
    const copier = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copier },
    });
    await ouvrir(
      reponse([
        ...(['draft', 'active', 'review'] as const).map((state, i) =>
          sujet({
            sujetId: `v${i}`,
            carte: null,
            state,
            titre: `Vivant ${state}`,
            lien: i === 0 ? 'exemple/depot#s' : null,
          }),
        ),
        ...Array.from({ length: nombre }, (_, i) =>
          sujet({
            sujetId: `t${i}`,
            carte: null,
            state: i === 0 ? 'merged' : 'archived',
            titre: `Terminé ${i}`,
          }),
        ),
        sujet({ sujetId: 'conflit', carte: null, conflit: [101, 102], titre: 'Conflit exclu' }),
      ]),
      'accueil',
    );
    const titre = await screen.findByText('Sujets sans carte (3)');
    const details = titre.closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(titre);
    expect(
      screen.getByText(
        `${nombre} sujet${nombre > 1 ? 's' : ''} merged ou archived sans carte non listé${nombre > 1 ? 's' : ''}.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Terminé/)).toBeNull();
    expect(screen.queryByText(/Conflit exclu/)).toBeNull();
    expect(screen.getAllByText('Pas de remote GitHub : pas de lien possible')).toHaveLength(2);
    fireEvent.click(within(details).getByRole('button', { name: 'Copier la ligne' }));
    await waitFor(() => expect(copier).toHaveBeenCalledWith('AID: exemple/depot#s'));
    copier.mockRejectedValueOnce(new Error('refus'));
    fireEvent.click(within(details).getByRole('button', { name: 'Copier la ligne' }));
    await screen.findByText('Copie impossible : accès au presse-papiers refusé.');
    expect(screen.getByText('feat/s')).toBeTruthy();
  },
);
test.each([false, 'accueil'] as const)(
  'erreurs partielles sans effacer écran %s',
  async (ecran) => {
    const r = reponse([sujet()]);
    r.board = { ok: false, kind: 'timeout', readAt: date };
    r.erreurs = ['lecture locale'];
    await ouvrir(r, ecran);
    await screen.findByText("Les liens A-I-D n'ont pas pu être lus.");
    expect(screen.getByText(ecran ? 'feat/s' : 'Carte 101')).toBeTruthy();
  },
);
test('relecture au rythme des cartes, arrêt écran démonté et onglet masqué, erreur réseau conserve la lecture', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const h = await ouvrir(reponse([sujet()]));
  await screen.findByText('A-I-D · actif');
  const compter = () => h.calls.filter((c) => c.url === '/api/aid/board').length;
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
  h.respond.set('GET /api/aid/board', () => {
    throw new Error('lecture interrompue');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BOARD_RELECTURE_MS);
  });
  expect(screen.getByText('A-I-D · actif')).toBeTruthy();
  expect(screen.getByText("Les liens A-I-D n'ont pas pu être lus.")).toBeTruthy();
  cleanup();
  const fin = compter();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BOARD_RELECTURE_MS);
  });
  expect(compter()).toBe(fin);
});

// Le port host n'a pas de state admin : même un contenu monté ne doit pas lire Aid.
test('host : aucun appel Aid', async () => {
  const { SansCarteAid, AidCarte, ErreursAid } = await import('../../web/src/ui/AidBoard.js');
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
      <SansCarteAid />
      <NouveauSujetCarte carte={101} titre="Titre" corps="" />
      <AidCarte carte={101} fiche />
      <ErreursAid />
    </AidProvider>,
  );
  await waitFor(() => expect(client.getSnapshot().appareil).toBeTruthy());
  act(() => FakeSocket.all.at(-1)!.open());
  expect(appels).not.toContain('/api/aid/board');
  expect(screen.queryByRole('link', { name: 'Nouveau sujet' })).toBeNull();
});

test('fiche sans phase ni PR : aucune valeur inventée', async () => {
  await ouvrir(reponse([sujet({ phase: null, prNumber: null, prUrl: null })]), true);
  await screen.findByRole('heading', { name: 'A-I-D' });
  expect(screen.getByText('—')).toBeTruthy();
  expect(screen.queryByText('PR')).toBeNull();
  expect(screen.getByText('2 en marche, 1 en attente, 0 terminé')).toBeTruthy();
});

test.each(['libre', 'reliee', 'conflit', 'absent', 'corps'])(
  'D292 : bouton admin pour carte %s',
  async (cas) => {
    const r = reponse(
      cas === 'reliee'
        ? [sujet()]
        : cas === 'conflit'
          ? [sujet({ carte: null, conflit: [101, 102] })]
          : [],
    );
    if (cas === 'absent')
      r.cartes = [
        { id: 101, sujets: [{ lien: 'o/d#absent', sujet: 'absent' }] },
      ] as BoardAid['cartes'];
    const h = setup(
      <NouveauSujetCarte
        carte={101}
        titre="<b>Titre</b>"
        corps={cas === 'corps' ? 'AID: o/d#s' : ''}
      />,
      etat,
      '/',
      { 'GET /api/aid/board': json(200, r) },
    );
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    act(() => FakeSocket.all[0]!.open());
    await waitFor(() => expect(h.calls.some((c) => c.url === '/api/aid/board')).toBe(true));
    if (cas === 'libre')
      expect(await screen.findByRole('link', { name: 'Nouveau sujet' })).toBeTruthy();
    else expect(screen.queryByRole('link', { name: 'Nouveau sujet' })).toBeNull();
  },
);

test.each([1, 2])('D291 : accord de %s agent terminé', async (termine) => {
  await ouvrir(reponse([sujet({ agents: { enMarche: 0, enAttente: 0, termine } })]), true);
  expect(
    await screen.findByText(
      `0 en marche, 0 en attente, ${termine} terminé${termine > 1 ? 's' : ''}`,
    ),
  ).toBeTruthy();
});

test('42.5 : agents en erreur affichés en premier', async () => {
  await ouvrir(
    reponse([sujet({ agents: { enMarche: 2, enAttente: 1, termine: 3, enErreur: 1 } })]),
    true,
  );
  expect(
    await screen.findByText('1 en erreur, 2 en marche, 1 en attente, 3 terminés'),
  ).toBeTruthy();
});

test.each([
  ['peer-b', 'build', 'carte non assignée à cellule-test'],
  ['cellule-test', 'spec', 'étape spec hors de build, review, ready'],
])('42.5 : fiche explique le refus %s %s', async (assignee, stage, raison) => {
  const { parseCard } = await import('../../src/shared/board.js');
  const r = reponse([sujet()]);
  r.cartes = [{ ...parseCard({ id: 101, assignee, stage, stage_version: 1 })!.value, sujets: [] }];
  await ouvrir(r, true);
  expect(await screen.findByText(`Déplacement non proposé : ${raison}`)).toBeTruthy();
});
