// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Route, Routes } from 'react-router';
import type { BoardResult } from '../../src/shared/board.js';
import type { MeshState } from '../../src/shared/model.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

afterEach(cleanup);
const monitor: MeshState = {
  ecritures: false,
  proxyConfigure: false,
  superviseur: null,
  connected: true,
  tailscale: 'running',
  monitor: 'running',
  pending: 0,
  since: null,
  cell: 'peer-local',
};
const avecMesh = snapshot({ mesh: { state: monitor, inbox: [], tailscaleManage: false } });
const readAt = '2026-11-09T10:00:00.000Z';
const ok = <T,>(data: T): BoardResult<T> => ({ ok: true, data, readAt, schemaVersion: null });
const NAV = { 'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }) };
import { Cells } from '../../web/src/ecrans/Cells.js';
const app = (
  <Routes>
    <Route path="/swarph/cells" element={<Cells />} />
    <Route path="/swarph" element={<p>Connexion swarph</p>} />
  </Routes>
);
async function ouvrir(resultat: BoardResult<unknown>, etatMonitor = monitor) {
  const reponse = { peers: resultat, monitor: etatMonitor };
  const h = setup(app, avecMesh, '/swarph/cells', {
    ...NAV,
    'GET /api/swarph/cells': json(200, reponse),
    'GET /api/swarph/cells?fresh=1': json(200, reponse),
  });
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  await waitFor(() =>
    expect(document.querySelector('[data-node="cells.lu-a"]')?.textContent).not.toContain('—'),
  );
  return h;
}

test.each([
  ['no-index', 'Aucun index local'],
  ['not-configured', 'Non configuré'],
  ['unreachable', 'Le gateway ne répond pas'],
  ['format', 'Réponse du board illisible'],
  ['forbidden', 'Tu ne peux pas lire cette carte'],
] as const)('état %s : libellé du Board', async (kind, texte) => {
  await ouvrir({ ok: false, kind, readAt });
  expect(screen.getByRole('alert').textContent).toContain(texte);
});

test('sans mesh : retour à la connexion et aucune lecture', async () => {
  const h = setup(app, snapshot(), '/swarph/cells', NAV);
  await screen.findByText('Connexion swarph');
  expect(h.calls.some((c) => c.url.startsWith('/api/swarph/'))).toBe(false);
});

const pairs = [
  { nom: 'peer-z', version: '0.72.42' },
  { nom: 'peer-a', version: '0.72.40' },
  { nom: 'peer-local', version: '0.72.41' },
];
test('cellule locale en tête, toi et monitor, puis noms triés et note exacte', async () => {
  await ouvrir(ok(pairs));
  const tableau = screen.getByRole('table');
  const lignes = within(tableau).getAllByRole('row').slice(1);
  expect(lignes.map((ligne) => within(ligne).getAllByRole('cell')[0]!.textContent)).toEqual([
    'peer-local · toi',
    'peer-a',
    'peer-z',
  ]);
  expect(lignes[0]!.textContent).toContain('running · En marche');
  expect(lignes[0]!.textContent).toContain('0.72.41');
  expect(screen.getByRole('columnheader', { name: 'Version déclarée' })).toBeTruthy();
  expect(document.querySelector('[data-node="cells.note"]')!.textContent).toBe(
    'Version annoncée à la dernière inscription du pair, pas forcément celle qui tourne. La présence arrivera avec une lecture swarph dédiée.',
  );
});
test('cellule locale absente des pairs : version non déclarée', async () => {
  await ouvrir(ok([]));
  expect(screen.getAllByRole('row')[1]!.textContent).toContain('peer-local · toiNon déclarée');
});
test('Recharger relit en fresh et affiche Lu à', async () => {
  const h = await ouvrir(ok(pairs));
  expect(document.querySelector('[data-node="cells.lu-a"]')!.textContent).toContain('Lu à');
  const bouton = screen.getByRole('button', { name: 'Recharger' }) as HTMLButtonElement;
  fireEvent.click(bouton);
  expect(bouton.disabled).toBe(true);
  fireEvent.click(bouton);
  expect(h.calls.filter((c) => c.url.endsWith('?fresh=1'))).toHaveLength(1);
  await waitFor(() =>
    expect(h.calls.some((c) => c.url === '/api/swarph/cells?fresh=1')).toBe(true),
  );
});
test('contenu des pairs en texte React', async () => {
  await ouvrir(ok([{ nom: '<b>peer-a</b>', version: 'https://example.com' }]));
  const tableau = screen.getByRole('table');
  expect(tableau.textContent).toContain('<b>peer-a</b>');
  expect(tableau.querySelector('b, a')).toBeNull();
});

test('avatars décoratifs devant les noms, anneau réservé à la cell locale', async () => {
  await ouvrir(
    ok([
      { nom: 'peer-a', version: '1' },
      { nom: 'peer-b', version: '1' },
    ]),
    { ...monitor, cell: 'peer-a' },
  );
  const lignes = within(screen.getByRole('table')).getAllByRole('row').slice(1);
  expect(lignes[0]!.textContent).toContain('peer-a · toi');
  expect(lignes[0]!.querySelector('.avatar-cell')?.getAttribute('title')).toBe('cette cell');
  expect(lignes[1]!.querySelector('.avatar-cell')?.getAttribute('title')).toBeNull();
  expect(
    lignes.every(
      (ligne) => ligne.querySelector('.avatar-cell')?.getAttribute('aria-hidden') === 'true',
    ),
  ).toBe(true);
});
