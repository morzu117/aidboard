// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Route, Routes } from 'react-router';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { Board } from '../../web/src/ecrans/Board.js';
import { Cells } from '../../web/src/ecrans/Cells.js';
import { useMeshes } from '../../web/src/data/meshes.js';
import { EcranMesh } from '../../web/src/ui/SelecteurMesh.js';
import { Swarph } from '../../web/src/ecrans/Swarph.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

afterEach(cleanup);

test('Swairm sans mesh : /swarph garde son contenu et la demande locale après la lecture des meshes', async () => {
  const h = setup(<Swarph />, snapshot({ swairm: { enabled: true } }), '/swarph', {
    'GET /api/meshes': json(200, [
      { nom: 'principal', cell: '', actif: false, erreur: null, etat: null, ecriture: false },
    ]),
    'GET /api/swairm/ask/etat': json(200, {
      enCours: false,
      depuis: null,
      budgetUsd: 0.5,
    }),
    'GET /api/swairm/asks': json(200, {
      ok: true,
      data: { demandes: [] },
      readAt: '2026-11-13T10:00:00Z',
    }),
  });
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  await act(async () => FakeSocket.all[0]!.open());
  await waitFor(() => expect(h.calls.some((c) => c.url === '/api/meshes')).toBe(true));
  expect(screen.getByRole('heading', { name: 'Connecter cet A-I-D à swarph' })).toBeTruthy();
  const bouton = screen.getByRole('button', { name: 'Demander N avis' }) as HTMLButtonElement;
  await waitFor(() => expect(bouton.disabled).toBe(false));
  expect(screen.queryByRole('region', { name: 'Demandes au mesh' })).toBeNull();
  expect(h.calls.some((c) => c.url.startsWith('/api/avis-mesh'))).toBe(false);
});

for (const noms of [['principal'], ['principal', 'secondaire']]) {
  test(`Swairm avec ${noms.length} mesh : /swarph garde les demandes locales et mesh`, async () => {
    const boite = {
      state: {
        ecritures: false,
        proxyConfigure: false,
        superviseur: null,
        connected: false,
        tailscale: 'running' as const,
        monitor: 'stopped' as const,
        pending: 0,
        since: null,
        cell: 'cell-exemple',
      },
      inbox: [],
      tailscaleManage: false,
    };
    setup(
      <Swarph />,
      snapshot({
        swairm: { enabled: true },
        mesh: boite,
        meshes: Object.fromEntries(noms.map((nom) => [nom, boite])),
      }),
      '/swarph',
      {
        'GET /api/meshes': json(
          200,
          noms.map((nom) => ({
            nom,
            cell: 'cell-exemple',
            actif: true,
            erreur: null,
            etat: boite.state,
            ecriture: false,
          })),
        ),
        'GET /api/swairm/ask/etat': json(200, {
          enCours: false,
          depuis: null,
          budgetUsd: 0.5,
        }),
        'GET /api/swairm/asks': json(200, {
          ok: true,
          data: { demandes: [] },
          readAt: '2026-11-13T10:00:00Z',
        }),
        'GET /api/avis-mesh': json(200, { demandes: [] }),
      },
    );
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    await act(async () => FakeSocket.all[0]!.open());
    expect(await screen.findByRole('region', { name: 'Demandes au mesh' })).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Demander N avis' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByRole('region', { name: 'Déjà configuré' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Mesh' }) !== null).toBe(noms.length > 1);
  });
}

function PagesSansMesh({ chemin }: { chemin: string }) {
  const { charge } = useMeshes();
  // Tester le garde une fois la liste lue, avant que les écrans ne puissent rediriger.
  if (!charge) return null;
  return (
    <EcranMesh ecran={chemin}>
      <Routes>
        <Route path="/board" element={<Board />} />
        <Route path="/swarph/cells" element={<Cells />} />
        <Route path="/" element={<Accueil />} />
        <Route path="/swarph" element={<Swarph />} />
      </Routes>
    </EcranMesh>
  );
}

for (const [chemin, message] of [
  ['/board', 'Sans swarph, A-I-D reste local : ni mesh, ni DM, ni board partagé.'],
  ['/swarph/cells', 'Connecter cet A-I-D à swarph'],
]) {
  test(`${chemin} sans mesh : le garde laisse afficher la page de repli historique`, async () => {
    const h = setup(<PagesSansMesh chemin={chemin!} />, snapshot(), chemin, {
      'GET /api/meshes': json(200, [
        { nom: 'principal', cell: '', actif: false, erreur: null, etat: null, ecriture: false },
      ]),
      'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
    });
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    await act(async () => FakeSocket.all[0]!.open());
    expect(await screen.findByText(message!)).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(h.calls.some((c) => c.url === '/api/meshes')).toBe(true);
    expect(
      h.calls.some((c) => c.url.startsWith('/api/board') || c.url.startsWith('/api/swarph/')),
    ).toBe(false);
  });
}
