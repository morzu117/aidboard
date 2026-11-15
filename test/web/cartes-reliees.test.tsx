// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Route, Routes } from 'react-router';
import { parseCard, type BoardCardSheet } from '../../src/shared/board.js';
import type { MeshState } from '../../src/shared/model.js';
import type { GroupeRelie, MembreRelie } from '../../web/src/data/cartes-reliees.js';
import type { MeshWeb } from '../../web/src/data/meshes.js';
import { MeshLecture } from '../../web/src/data/meshLecture.js';
import { CartesReliees } from '../../web/src/ui/CartesReliees.js';
import { CarteBoard } from '../../web/src/ecrans/CarteBoard.js';
import { Board } from '../../web/src/ecrans/Board.js';
import { AidClient } from '../../web/src/data/client.js';
import { AidProvider } from '../../web/src/data/useAidState.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

const etatMesh: MeshState = {
  cell: 'peer-a',
  connected: true,
  ecritures: true,
  proxyConfigure: true,
  superviseur: null,
  monitor: 'running',
  tailscale: 'running',
  pending: 0,
  since: null,
};
const meshWeb = (nom: string, actif = true): MeshWeb => ({
  nom,
  cell: 'peer-a',
  actif,
  erreur: null,
  etat: etatMesh,
  ecriture: true,
});
const boite = { state: etatMesh, inbox: [], tailscaleManage: false };
const etat = snapshot({ mesh: boite, meshes: { principal: boite, perso: boite } });
const date = '2026-11-13T12:00:00Z';
const fiche = (title: string): BoardCardSheet => ({
  card: {
    ok: true,
    data: parseCard({
      id: 12,
      title,
      author: 'peer-a',
      assignee: 'peer-b',
      stage: 'dev',
      thread_uuid: 'identite-interdite-au-web',
      created_at: date,
    })!.value,
    readAt: date,
    schemaVersion: null,
  },
  graph: {
    ok: true,
    data: { steps: [], missing: [], unconfirmed: [], stageImplied: null },
    readAt: date,
    schemaVersion: null,
  },
  obligations: {
    ok: true,
    data: { obligations: [], truncated: false, asOf: null },
    readAt: date,
    schemaVersion: null,
  },
  thread: { ok: false, kind: 'unknown', readAt: date },
});
const membre = (champs: Partial<MembreRelie> = {}): MembreRelie => ({
  id: 2,
  mesh: 'perso',
  carte: 34,
  statut: 'ok',
  titre: '<b>Carte perso</b>',
  etape: 'review',
  responsable: 'peer-b',
  obligations: 3,
  echeance: date,
  maj: date,
  ...champs,
});
const groupe = (
  membres = [
    membre({ id: 1, mesh: 'principal', carte: 12, titre: 'Origine', etape: 'dev' }),
    membre(),
  ],
): GroupeRelie => ({ id: 7, note: '<i>Note locale</i>', membres, ecart: true });
const routes = {
  'GET /api/meshes': json(200, [
    meshWeb('principal'),
    meshWeb('perso'),
    meshWeb('peer-a', false),
    meshWeb('peer-b'),
  ]),
  'GET /api/cartes-reliees?mesh=principal&carte=12': () => new Response('null'),
  'GET /api/board/cards/12?mesh=principal': json(200, fiche('Origine aperçu')),
  'GET /api/board/cards/34?mesh=perso': json(200, fiche('<img src=x onerror=alert(1)>')),
  'POST /api/cartes-reliees': json(201, { id: 7 }),
  'POST /api/cartes-reliees/7/membres': json(204, {}),
  'GET /api/avatars': json(200, { avatars: {} }),
  'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
};
async function joindre() {
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
}
async function ouvrir(extra: typeof routes | Record<string, () => Response> = {}) {
  const h = setup(<CartesReliees carte={12} />, etat, '/', { ...routes, ...extra });
  await joindre();
  return h;
}
async function dialogue() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Relier à une carte d’un autre mesh' }),
  );
  return screen.getByRole('dialog');
}
async function apercu() {
  fireEvent.change(screen.getByLabelText('Numéro de carte'), { target: { value: '34' } });
  fireEvent.click(screen.getByRole('button', { name: 'Aperçu' }));
  await screen.findByLabelText('Aperçu des deux cartes');
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

test.each([
  ['ok', '<b>Carte perso</b>'],
  ['mesh_change', 'mesh changé'],
  ['carte_remplacee', 'carte remplacée'],
  ['lecture_impossible', 'lecture impossible'],
] as const)(
  'section : statut %s, champs strictement réservés à ok et lien sur le bon mesh',
  async (statut, texte) => {
    await ouvrir({
      'GET /api/cartes-reliees?mesh=principal&carte=12': json(200, groupe([membre({ statut })])),
    });
    const section = await screen.findByRole('region', { name: 'Même carte ailleurs' });
    expect(section.textContent).toContain(texte);
    expect(section.querySelector('b, i')).toBeNull();
    expect(within(section).getByRole('link').getAttribute('href')).toBe(
      '/board/cartes/34?mesh=perso',
    );
    if (statut === 'ok') {
      expect(section.textContent).toContain('review');
      expect(section.textContent).toContain('peer-b');
      expect(section.textContent).toContain('3');
      expect(section.textContent).toContain(date);
      expect(section.querySelector('.avatar-cell')).not.toBeNull();
    } else {
      expect(section.textContent).not.toContain('Carte perso');
      expect(section.textContent).not.toContain('peer-b');
      expect(section.textContent).not.toContain(date);
    }
  },
);

test('dialogue : meshes actifs autres que l’origine, deux aperçus en texte et création sans identité', async () => {
  const h = await ouvrir();
  const d = await dialogue();
  expect(
    within(d)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['perso', 'peer-b']);
  expect(
    (screen.getByRole('button', { name: 'Confirmer le lien' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await apercu();
  expect(d.textContent).toContain('Origine aperçu');
  expect(d.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(d.querySelector('img')).toBeNull();
  expect(h.calls.filter((c) => c.url.startsWith('/api/board/cards/')).map((c) => c.url)).toEqual([
    '/api/board/cards/12?mesh=principal',
    '/api/board/cards/34?mesh=perso',
  ]);
  h.respond.set('GET /api/cartes-reliees?mesh=principal&carte=12', json(200, groupe()));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer le lien' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(h.calls.filter((c) => c.method === 'POST')).toEqual([
    {
      method: 'POST',
      url: '/api/cartes-reliees',
      body: {
        membres: [
          { mesh: 'principal', carte: 12 },
          { mesh: 'perso', carte: 34 },
        ],
      },
    },
  ]);
  await screen.findByRole('region', { name: 'Même carte ailleurs' });
});

test('dialogue : ajout à un groupe existant et erreur de conflit affichée', async () => {
  const h = await ouvrir({
    'GET /api/cartes-reliees?mesh=principal&carte=12': json(200, groupe()),
    'POST /api/cartes-reliees/7/membres': json(409, { error: 'mesh déjà présent dans le groupe' }),
  });
  await screen.findByRole('region', { name: 'Même carte ailleurs' });
  await dialogue();
  await apercu();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer le lien' }));
  expect((await screen.findByRole('alert')).textContent).toContain('mesh déjà présent');
  expect(h.calls.filter((c) => c.method === 'POST')).toEqual([
    { method: 'POST', url: '/api/cartes-reliees/7/membres', body: { mesh: 'perso', carte: 34 } },
  ]);
  expect(screen.getByRole('dialog')).not.toBeNull();
});

test('dialogue : changer de numéro ou de mesh invalide l’aperçu, les numéros invalides sont refusés', async () => {
  const h = await ouvrir();
  await dialogue();
  for (const value of ['0', '-1', '1.5', '9007199254740992']) {
    fireEvent.change(screen.getByLabelText('Numéro de carte'), { target: { value } });
    expect((screen.getByRole('button', { name: 'Aperçu' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  }
  await apercu();
  fireEvent.change(screen.getByLabelText('Numéro de carte'), { target: { value: '35' } });
  expect(screen.queryByLabelText('Aperçu des deux cartes')).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Confirmer le lien' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await apercu();
  fireEvent.change(screen.getByLabelText('Mesh de la carte'), { target: { value: 'peer-b' } });
  expect(screen.queryByLabelText('Aperçu des deux cartes')).toBeNull();
  expect(h.calls.filter((c) => c.method === 'POST')).toEqual([]);
});

test('dialogue : aperçu en échec, aucune confirmation possible', async () => {
  const h = await ouvrir({
    'GET /api/board/cards/34?mesh=perso': json(200, { card: { ok: false, kind: 'not-found' } }),
  });
  await dialogue();
  fireEvent.change(screen.getByLabelText('Numéro de carte'), { target: { value: '34' } });
  fireEvent.click(screen.getByRole('button', { name: 'Aperçu' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Lecture impossible');
  expect(
    (screen.getByRole('button', { name: 'Confirmer le lien' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(h.calls.filter((c) => c.method === 'POST')).toEqual([]);
});

test('liste : écarts, étapes et pagination uniquement sur Plus', async () => {
  const h = setup(<CartesReliees />, etat, '/', {
    ...routes,
    'GET /api/cartes-reliees?limite=20&apres=0': json(200, { groupes: [groupe()], suivant: 7 }),
    'GET /api/cartes-reliees?limite=20&apres=7': json(200, {
      groupes: [{ ...groupe(), id: 9, ecart: false }],
      suivant: null,
    }),
  });
  await joindre();
  const liste = await screen.findByRole('region', { name: 'Cartes reliées' });
  await within(liste).findByText('écart');
  expect(liste.textContent).toContain('dev');
  expect(liste.textContent).toContain('review');
  expect(liste.querySelector('b, i')).toBeNull();
  expect(h.calls.filter((c) => c.url.startsWith('/api/cartes-reliees')).map((c) => c.url)).toEqual([
    '/api/cartes-reliees?limite=20&apres=0',
  ]);
  expect(h.calls.some((c) => c.url.startsWith('/api/board/cards'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Plus' }));
  await within(liste).findByText('Groupe #9');
  expect(within(liste).getAllByText('écart')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Plus' })).toBeNull();
  expect(h.calls.filter((c) => c.url.startsWith('/api/cartes-reliees')).map((c) => c.url)).toEqual([
    '/api/cartes-reliees?limite=20&apres=0',
    '/api/cartes-reliees?limite=20&apres=7',
  ]);
});

test('un seul mesh actif : groupe visible, ni bouton ni liste, aucune lecture paginée', async () => {
  const h = setup(
    <>
      <CartesReliees carte={12} />
      <CartesReliees />
    </>,
    etat,
    '/',
    {
      ...routes,
      'GET /api/meshes': json(200, [meshWeb('principal'), meshWeb('perso', false)]),
      'GET /api/cartes-reliees?mesh=principal&carte=12': json(
        200,
        groupe([membre({ statut: 'mesh_change' })]),
      ),
    },
  );
  await joindre();
  await screen.findByText('mesh changé');
  expect(screen.queryByRole('button', { name: 'Relier à une carte d’un autre mesh' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Cartes reliées' })).toBeNull();
  expect(h.calls.some((c) => c.url.includes('limite='))).toBe(false);
});

test('lien de retour au principal explicite depuis un autre mesh', async () => {
  setup(
    <MeshLecture.Provider value="perso">
      <CartesReliees carte={34} />
    </MeshLecture.Provider>,
    etat,
    '/',
    { ...routes, 'GET /api/cartes-reliees?mesh=perso&carte=34': json(200, groupe()) },
  );
  await joindre();
  const section = await screen.findByRole('region', { name: 'Même carte ailleurs' });
  expect(within(section).getByRole('link').getAttribute('href')).toBe(
    '/board/cartes/12?mesh=principal',
  );
  expect(section.textContent).not.toContain('Carte perso');
});

test('téléphone : aucun ajout ni lecture des cartes reliées', async () => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
  const h = setup(
    <>
      <CartesReliees carte={12} />
      <CartesReliees />
    </>,
    etat,
    '/',
    routes,
  );
  await joindre();
  await waitFor(() => expect(h.client.getSnapshot().state).not.toBeNull());
  expect(h.calls.some((c) => c.url.startsWith('/api/cartes-reliees'))).toBe(false);
  expect(screen.queryByRole('button')).toBeNull();
});

test('intégration : la section est montée dans CarteBoard', async () => {
  setup(
    <Routes>
      <Route path="/board/cartes/:cardId" element={<CarteBoard />} />
    </Routes>,
    etat,
    '/board/cartes/12',
    {
      ...routes,
      'GET /api/board/cards/12': json(200, fiche('Carte source')),
      'GET /api/cartes-reliees?mesh=principal&carte=12': json(200, groupe()),
    },
  );
  await joindre();
  await screen.findByRole('region', { name: 'Même carte ailleurs' });
});

test('intégration : la liste est montée dans Board', async () => {
  setup(<Board />, etat, '/board', {
    ...routes,
    'GET /api/board/projects': json(200, { ok: true, data: [], readAt: date }),
    'GET /api/cartes-reliees?limite=20&apres=0': json(200, { groupes: [groupe()], suivant: null }),
  });
  await joindre();
  await screen.findByText('écart');
});

test('appareil : aucun ajout ni appel aux routes locales', async () => {
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
      <CartesReliees carte={12} />
      <CartesReliees />
    </AidProvider>,
  );
  await waitFor(() => expect(client.getSnapshot().appareil).toBeTruthy());
  act(() => FakeSocket.all.at(-1)!.open());
  expect(appels.some((url) => url.startsWith('/api/cartes-reliees') || url === '/api/meshes')).toBe(
    false,
  );
  expect(screen.queryByRole('button')).toBeNull();
});

test.each(['ok', 'mesh_change', 'carte_remplacee', 'lecture_impossible'] as const)(
  'retrait %s : tous les membres, annulation sans requête puis confirmation et relecture',
  async (statut) => {
    const h = await ouvrir({
      'GET /api/cartes-reliees?mesh=principal&carte=12': json(
        200,
        groupe([membre({ id: 1, mesh: 'principal', carte: 12 }), membre({ statut })]),
      ),
      'DELETE /api/cartes-reliees/7/membres/2': json(204, {}),
    });
    const section = await screen.findByRole('region', { name: 'Même carte ailleurs' });
    const boutons = within(section).getAllByRole('button', { name: 'Retirer du groupe' });
    expect(boutons).toHaveLength(2);
    fireEvent.click(boutons[0]!);
    expect(screen.getByRole('dialog').textContent).toContain('Retirer principal #12');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    fireEvent.click(boutons[1]!);
    expect(screen.getByRole('dialog').textContent).toContain('Retirer perso #34');
    expect(h.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    h.respond.set('GET /api/cartes-reliees?mesh=principal&carte=12', () => new Response('null'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer le retrait' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Même carte ailleurs' })).toBeNull(),
    );
    expect(h.calls.filter((c) => c.method === 'DELETE')).toEqual([
      { method: 'DELETE', url: '/api/cartes-reliees/7/membres/2', body: undefined },
    ]);
    expect(
      h.calls.filter((c) => c.url === '/api/cartes-reliees?mesh=principal&carte=12'),
    ).toHaveLength(2);
  },
);

test('retrait de la carte affichée : DELETE vise son identifiant de membre', async () => {
  const h = await ouvrir({
    'GET /api/cartes-reliees?mesh=principal&carte=12': json(200, groupe()),
    'DELETE /api/cartes-reliees/7/membres/1': json(204, {}),
  });
  const section = await screen.findByRole('region', { name: 'Même carte ailleurs' });
  fireEvent.click(within(section).getAllByRole('button', { name: 'Retirer du groupe' })[0]!);
  h.respond.set('GET /api/cartes-reliees?mesh=principal&carte=12', () => new Response('null'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer le retrait' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(h.calls.filter((c) => c.method === 'DELETE')).toEqual([
    { method: 'DELETE', url: '/api/cartes-reliees/7/membres/1', body: undefined },
  ]);
});
