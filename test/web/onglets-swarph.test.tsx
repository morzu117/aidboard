// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { AidProvider } from '../../web/src/data/useAidState.js';

// setup fournit déjà le client isolé : App réutilise ce contexte dans ces tests.
vi.mock('../../web/src/data/useAidState.js', async (original) => {
  const module = await original<typeof import('../../web/src/data/useAidState.js')>();
  return {
    ...module,
    AidProvider: (props: ComponentProps<typeof AidProvider>) =>
      props.client ? <module.AidProvider {...props} /> : <>{props.children}</>,
  };
});
import { App } from '../../web/src/App.js';
import {
  useCells,
  useFederation,
  useMemoire,
  usePageMemoire,
  useReglages,
} from '../../web/src/data/swarph.js';
import { OngletsSwarph, ONGLETS_SWARPH } from '../../web/src/ui/OngletsSwarph.js';
import { Chemin, FakeSocket, json, setup, snapshot } from './helpers.js';

afterEach(cleanup);
const avecMesh = snapshot({
  mesh: {
    state: {
      ecritures: false,
      proxyConfigure: false,
      connected: true,
      tailscale: 'running',
      monitor: 'running',
      pending: 0,
      since: null,
      cell: 'peer-a',
    },
    inbox: [],
    tailscaleManage: false,
  },
});
const NAV = { 'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }) };
async function joindre() {
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => {
    for (const socket of FakeSocket.all) socket.open();
  });
}

test.each(ONGLETS_SWARPH)('barre : %s actif et cinq liens accessibles', async (id, chemin) => {
  setup(<OngletsSwarph />, avecMesh, chemin, NAV);
  const barre = screen.getByRole('navigation', { name: 'Onglets swarph' });
  expect(within(barre).getAllByRole('link')).toHaveLength(5);
  for (const [autreId, autreChemin, titre] of ONGLETS_SWARPH) {
    const lien = within(barre).getByRole('link', { name: titre });
    expect(lien.getAttribute('href')).toBe(autreChemin);
    expect(lien.getAttribute('aria-current')).toBe(autreId === id ? 'page' : null);
  }
});

test.each(ONGLETS_SWARPH.slice(1))(
  'route %s : écran provisoire et lien principal Board actif',
  async (_id, chemin, titre) => {
    const h = setup(<App />, avecMesh, chemin, NAV);
    await screen.findByRole('heading', { name: titre });
    const lien = document.querySelector('[data-node="board.barre.nav-board"]')!;
    expect(lien.className).toContain('est-actif');
    expect(lien.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('navigation', { name: 'Onglets swarph' })).toBeTruthy();
    expect(h.calls.some((c) => c.url.startsWith('/api/swarph/'))).toBe(false);
  },
);

test.each(ONGLETS_SWARPH.slice(1))('route %s sans mesh : connexion swarph', async (_id, chemin) => {
  setup(
    <>
      <App />
      <Chemin />
    </>,
    snapshot(),
    chemin,
    NAV,
  );
  await waitFor(() => expect(screen.getByTestId('chemin-courant').textContent).toBe('/swarph'));
});

function Lectures({ valeur }: { valeur: string }) {
  const federation = useFederation(valeur);
  const memoire = useMemoire(valeur || null);
  const page = usePageMemoire(valeur);
  return (
    <button
      onClick={() => {
        void federation.relire();
        void memoire.relire();
        void page.relire();
      }}
    >
      Relire
    </button>
  );
}

test.each(['', '-x', 'invalide\n', 'x'.repeat(201)])(
  'entrée invalide %j : aucune lecture, même en fresh ou au focus',
  async (valeur) => {
    const h = setup(<Lectures valeur={valeur} />, avecMesh, '/', NAV);
    await joindre();
    fireEvent.click(screen.getByRole('button', { name: 'Relire' }));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(h.calls.filter((c) => c.url.startsWith('/api/swarph/'))).toEqual([]);
  },
);

function ToutesLectures() {
  const cells = useCells();
  const reglages = useReglages();
  return (
    <>
      <Lectures valeur="lesson/test" />
      <button
        onClick={() => {
          void cells.relire();
          void reglages.relire();
        }}
      >
        Relire état
      </button>
    </>
  );
}

test('cinq hooks : chemins, encodage, résultats et relecture fraîche', async () => {
  const resultat = { ok: true, data: [], readAt: '2026-11-09T10:00:00.000Z', schemaVersion: null };
  const chemins = [
    '/api/swarph/cells',
    '/api/swarph/reglages',
    '/api/swarph/federation?q=lesson%2Ftest',
    '/api/swarph/memory?tag=lesson%2Ftest',
    '/api/swarph/memory/page?slug=lesson%2Ftest',
  ];
  const reponses = [
    { peers: resultat, monitor: avecMesh.mesh!.state },
    { rights: resultat, monitor: avecMesh.mesh!.state },
    resultat,
    resultat,
    { page: resultat, links: resultat },
  ];
  const routes = { ...NAV };
  for (const [i, chemin] of chemins.entries()) {
    Object.assign(routes, {
      [`GET ${chemin}`]: json(200, reponses[i]!),
      [`GET ${chemin}${chemin.includes('?') ? '&' : '?'}fresh=1`]: json(200, reponses[i]!),
    });
  }
  const h = setup(
    <Routes>
      <Route path="/" element={<ToutesLectures />} />
    </Routes>,
    avecMesh,
    '/',
    routes,
  );
  await joindre();
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url.startsWith('/api/swarph/'))).toHaveLength(5),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Relire' }));
  fireEvent.click(screen.getByRole('button', { name: 'Relire état' }));
  await waitFor(() => expect(h.calls.filter((c) => c.url.endsWith('fresh=1'))).toHaveLength(5));
});
