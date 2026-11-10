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
  ecritures: false,
  proxyConfigure: false,
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

test('refus sur la liste des projets : le texte dit ce qui est refusé, sans lien vers la page où l’on est (D95 bis)', async () => {
  await ouvrir({ ok: false, kind: 'forbidden', readAt: READ_AT });
  const m = await waitFor(() => {
    const e = node('board.message');
    expect(e).not.toBeNull();
    return e!;
  });
  expect(m.textContent).toBe('Tu ne peux pas lire les projets du board');
  expect(node('board.message.retour')).toBeNull();
});

test('refus sur les cartes d’un projet : « Tu ne peux pas lire ce projet », sans lien de retour', async () => {
  await ouvrir(ok([projet]), { ok: false, kind: 'forbidden', readAt: READ_AT });
  await waitFor(() => expect(node('board.cartes.message')).not.toBeNull());
  expect(node('board.cartes.message')!.textContent).toBe('Tu ne peux pas lire ce projet');
  expect(node('board.cartes.message.retour')).toBeNull();
});

test('trop volumineux : message dédié, sans action (D95 bis)', async () => {
  await ouvrir({ ok: false, kind: 'too-large', readAt: READ_AT });
  const m = await waitFor(() => {
    const e = node('board.message');
    expect(e).not.toBeNull();
    return e!;
  });
  expect(m.textContent).toContain('Trop volumineux pour être affiché (plus de 4 Mo)');
  for (const action of ['retour', 'relire', 'doctor'])
    expect(node(`board.message.${action}`)).toBeNull();
});

test('erreur sur les cartes : les projets restent, le message prend la place des colonnes', async () => {
  await ouvrir(ok([projet]), { ok: false, kind: 'unreachable', readAt: READ_AT });
  await waitFor(() => expect(node('board.cartes.message')).not.toBeNull());
  expect(node('board.projet')!.textContent).toContain('projet-test');
});

test('les cartes retirées pendant leur lecture ne laissent pas « Lecture du board… » affiché', async () => {
  const h = setup(app, avecMesh, '/board', {
    ...NAV,
    'GET /api/board/projects': json(200, ok([projet])),
    // la lecture des cartes ne répond jamais
    'GET /api/board/projects/42/cards': () => new Promise(() => {}) as unknown as Response,
    'GET /api/board/projects/42/cards?fresh=1': () => new Promise(() => {}) as unknown as Response,
    'GET /api/board/projects?fresh=1': json(200, {
      ok: false,
      kind: 'unreachable',
      readAt: READ_AT,
    }),
  });
  await joindre();
  await waitFor(() => expect(node('board.projet')).not.toBeNull());
  await waitFor(() => expect(node('board.pastille')!.textContent).toBe('Lecture du board…'));
  // les projets relus en erreur : plus de projet, les cartes disparaissent en pleine lecture
  fireEvent.click(node('board.relire')!);
  await waitFor(() => expect(node('board.message')).not.toBeNull());
  expect(node('board.pastille')!.textContent).not.toBe('Lecture du board…');
  // Relire depuis le message relit encore les cartes en fresh : sans quoi elles retombent sur l'erreur en cache
  const fraiches = () =>
    h.calls.filter((c) => c.url === '/api/board/projects/42/cards?fresh=1').length;
  const avant = fraiches();
  fireEvent.click(node('board.message.relire')!);
  await waitFor(() => expect(fraiches()).toBe(avant + 1));
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

test('D101 : la barre dit l’âge du board sur son écran, et plus ailleurs', async () => {
  const h = setup(
    <Routes>
      <Route path="/board" element={<Board />} />
      <Route path="/consignes" element={<Consignes />} />
    </Routes>,
    avecMesh,
    '/board',
    {
      ...NAV,
      'GET /api/board/projects': json(200, ok([projet])),
      'GET /api/board/projects/42/cards': json(200, ok([])),
    },
  );
  await joindre();
  await waitFor(() =>
    expect(node('board.barre.board-lu')?.textContent).toMatch(/^board lu il y a \d+ s$/),
  );
  const lectures = h.calls.filter((c) => c.url.startsWith('/api/board')).length;
  fireEvent.click(node('board.barre.nav-consignes')!);
  await waitFor(() => expect(node('consignes.barre')).not.toBeNull());
  expect(node('consignes.barre.board-lu')).toBeNull();
  // la barre ne lit rien elle-même
  expect(h.calls.filter((c) => c.url.startsWith('/api/board'))).toHaveLength(lectures);
});

test('D110 : le board ne répond pas, « Board indisponible » au-dessus du message ; Réessayer relit en frais', async () => {
  const h = await ouvrir({ ok: false, kind: 'unreachable', readAt: READ_AT });
  await waitFor(() => expect(node('board.bandeau')).not.toBeNull());
  expect(node('board.bandeau.constat')!.textContent).toBe('Board indisponible');
  expect(node('board.bandeau.ton')!.textContent).toBe('À surveiller');
  expect(node('board.bandeau.detail')!.textContent).toBe(
    'Aucune lecture réussie depuis l’ouverture de l’écran.',
  );
  // le message classé du chantier 24 reste dessous, tel quel
  expect(node('board.message')!.textContent).toContain('Le gateway ne répond pas');
  h.respond.set('GET /api/board/projects?fresh=1', json(200, ok([projet])));
  fireEvent.click(node('board.bandeau.action')!);
  await waitFor(() => expect(node('board.bandeau')).toBeNull());
  expect(h.calls.some((c) => c.url === '/api/board/projects?fresh=1')).toBe(true);
});

test('D110 : après une lecture réussie, le bandeau en donne l’heure ; un refus n’est pas une panne', async () => {
  const h = await ouvrir(ok([projet]), ok([carte({})]));
  await waitFor(() => expect(node('board.carte-101')).not.toBeNull());
  expect(node('board.bandeau')).toBeNull();
  h.respond.set(
    'GET /api/board/projects/42/cards?fresh=1',
    json(200, { ok: false, kind: 'timeout', readAt: new Date().toISOString() }),
  );
  fireEvent.click(node('board.relire')!);
  await waitFor(() => expect(node('board.cartes.bandeau')).not.toBeNull());
  const heure = new Date(READ_AT).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  expect(node('board.cartes.bandeau.detail')!.textContent).toContain(
    `Dernière lecture réussie à ${heure}`,
  );
  cleanup();
  await ouvrir({ ok: false, kind: 'forbidden', readAt: READ_AT });
  await waitFor(() => expect(node('board.message')).not.toBeNull());
  expect(node('board.bandeau')).toBeNull();
});
