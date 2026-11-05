// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import type { BoardCardSummary, BoardProject, BoardResult } from '../../src/shared/board.js';
import type { MeshState } from '../../src/shared/model.js';
import { Board, colonnes } from '../../web/src/ecrans/Board.js';
import { Consignes } from '../../web/src/ecrans/Consignes.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

// 24.7 : écran Board sur des réponses figées ; aucune écriture, contenu des pairs en texte brut.

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;

const meshEtat: MeshState = {
  connected: true,
  tailscale: 'running',
  monitor: 'running',
  pending: 0,
  since: null,
  cell: 'morzu-mac',
};
const avecMesh = snapshot({ mesh: { state: meshEtat, inbox: [], tailscaleManage: false } });
const READ_AT = new Date().toISOString();

const ok = <T,>(data: T): BoardResult<T> => ({
  ok: true,
  data,
  readAt: READ_AT,
  schemaVersion: null,
});
const projet: BoardProject = {
  id: 42,
  slug: 'projet-test',
  title: 'Projet de test',
  status: 'active',
  author: 'peer-a',
};
const carte = (over: Partial<BoardCardSummary>): BoardCardSummary => ({
  id: 101,
  projectId: 42,
  title: 'Carte',
  stage: 'idea',
  assignee: null,
  dueAt: null,
  openObligations: 0,
  ...over,
});

const app = (
  <Routes>
    <Route path="/" element={<p>accueil</p>} />
    <Route path="/board" element={<Board />} />
  </Routes>
);
const NAV = { 'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }) };

/** le magasin ne lit qu'avec le daemon joint (socket ouverte) */
async function joindre() {
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
}

const ouvrir = async (
  projects: BoardResult<BoardProject[]>,
  cards: BoardResult<BoardCardSummary[]> = ok([]),
  state = avecMesh,
) => {
  const h = setup(app, state, '/board', {
    ...NAV,
    'GET /api/board/projects': json(200, projects),
    'GET /api/board/projects/42/cards': json(200, cards),
    'GET /api/board/projects?fresh=1': json(200, projects),
    'GET /api/board/projects/42/cards?fresh=1': json(200, cards),
  });
  await joindre();
  return h;
};

test('mesh non configuré : pas d’écran, retour à l’accueil, pas de lien Board', async () => {
  const h = setup(app, snapshot(), '/board', NAV);
  await screen.findByText('accueil');
  expect(h.calls.some((c) => c.url.startsWith('/api/board'))).toBe(false);
});

test('colonnes dans l’ordre des stage reçus, cartes « slug · #id », sans responsable ni échéance', async () => {
  await ouvrir(
    ok([projet]),
    ok([
      carte({
        id: 102,
        stage: 'build',
        assignee: 'peer-b',
        dueAt: '2026-11-07T11:00:00+00:00',
        openObligations: 1,
      }),
      carte({ id: 101, stage: 'idea', title: '<b>pas du HTML</b>' }),
      carte({ id: 103, stage: 'build', openObligations: 2 }),
    ]),
  );
  await waitFor(() => expect(node('board.colonne-build')).not.toBeNull());
  const titres = [...document.querySelectorAll('.board-colonne-titre')].map((e) => e.textContent);
  expect(titres).toEqual(['build 2', 'idea 1']);
  const c102 = node('board.carte-102')!;
  expect(c102.textContent).toContain('projet-test · #102');
  expect(c102.textContent).toContain('peer-b');
  expect(c102.textContent).toContain('échéance 2026-11-07');
  expect(c102.textContent).toContain('1 obligation ouverte');
  expect(c102.getAttribute('href')).toBe('/board/cartes/102');
  const c101 = node('board.carte-101')!;
  expect(c101.textContent).toContain('sans responsable');
  expect(c101.textContent).toContain('sans échéance');
  // texte brut : la balise reste du texte
  expect(c101.querySelector('b')).toBeNull();
  expect(c101.textContent).toContain('<b>pas du HTML</b>');
  expect(node('board.carte-103')!.textContent).toContain('2 obligations ouvertes');
  expect(node('board.identite')!.textContent).toContain('morzu-mac');
  expect(node('board.pastille')!.textContent).toMatch(/Board lu il y a \d+ s/);
  // lecture seule : aucun champ ni bouton d'écriture
  expect(document.querySelector('.board textarea, .board input')).toBeNull();
  expect(screen.queryByText(/Prendre|Commenter/)).toBeNull();
});

test('Relire relit projets et cartes avec ?fresh=1', async () => {
  const h = await ouvrir(ok([projet]), ok([carte({})]));
  await waitFor(() => expect(node('board.carte-101')).not.toBeNull());
  fireEvent.click(node('board.relire')!);
  await waitFor(() =>
    expect(h.calls.map((c) => c.url)).toEqual(
      expect.arrayContaining([
        '/api/board/projects?fresh=1',
        '/api/board/projects/42/cards?fresh=1',
      ]),
    ),
  );
});

test.each([
  ['forbidden', 'Tu ne peux pas lire cette carte', 'retour'],
  ['unreachable', 'Le gateway ne répond pas', 'relire'],
  ['too-old', 'Mets à jour swarph', 'doctor'],
  ['absent', 'Swarph est introuvable', 'doctor'],
] as const)('erreur %s : « %s » et son action', async (kind, texte, action) => {
  await ouvrir({ ok: false, kind, readAt: READ_AT });
  const m = await waitFor(() => {
    const e = node('board.message');
    expect(e).not.toBeNull();
    return e!;
  });
  expect(m.textContent).toContain(texte);
  expect(node(`board.message.${action}`)).not.toBeNull();
  if (action === 'doctor') expect(m.textContent).toContain('aid doctor');
});

test('erreur sur les cartes : les projets restent, le message prend la place des colonnes', async () => {
  await ouvrir(ok([projet]), { ok: false, kind: 'unreachable', readAt: READ_AT });
  await waitFor(() => expect(node('board.cartes.message')).not.toBeNull());
  expect(node('board.projet')!.textContent).toContain('projet-test');
});

test('petite largeur : une colonne à la fois, choisie par onglet', async () => {
  const largeur = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
  try {
    await ouvrir(
      ok([projet]),
      ok([carte({ id: 101, stage: 'idea' }), carte({ id: 102, stage: 'build' })]),
    );
    const onglets = await waitFor(() => {
      const e = node('board.onglets');
      expect(e).not.toBeNull();
      return e!;
    });
    expect(document.querySelectorAll('.board-colonne')).toHaveLength(1);
    expect(node('board.colonne-idea')).not.toBeNull();
    fireEvent.click(within(onglets).getByRole('tab', { name: /build/ }));
    expect(node('board.colonne-build')).not.toBeNull();
    expect(node('board.colonne-idea')).toBeNull();
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: largeur });
  }
});

test('barre : lien Board actif sur l’écran avec mesh, absent sans mesh', async () => {
  await ouvrir(ok([projet]));
  const lien = await waitFor(() => {
    const e = node('board.barre.nav-board');
    expect(e).not.toBeNull();
    return e!;
  });
  expect(lien.getAttribute('href')).toBe('/board');
  expect(lien.className).toContain('est-actif');
  cleanup();
  setup(
    <Routes>
      <Route path="/consignes" element={<Consignes />} />
    </Routes>,
    snapshot(),
    '/consignes',
    NAV,
  );
  await waitFor(() => expect(node('consignes.barre.nav-consignes')).not.toBeNull());
  expect(node('consignes.barre.nav-board')).toBeNull();
});

test('kind inconnu de cette version : lu comme unknown, sans planter', async () => {
  await ouvrir({ ok: false, kind: 'nouveau' as never, readAt: READ_AT });
  await waitFor(() => expect(node('board.message')).not.toBeNull());
  expect(node('board.message')!.textContent).toContain('Lecture du board impossible');
});

test('colonnes() : ordre d’apparition, stage absent regroupé', () => {
  expect(
    colonnes([
      carte({ id: 1, stage: 'b' }),
      carte({ id: 2, stage: null }),
      carte({ id: 3, stage: 'a' }),
      carte({ id: 4, stage: 'b' }),
    ]).map(([s, l]) => [s, l.map((c) => c.id)]),
  ).toEqual([
    ['b', [1, 4]],
    ['(sans étape)', [2]],
    ['a', [3]],
  ]);
});
