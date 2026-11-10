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
import { ReglagesSwarph } from '../../web/src/ecrans/ReglagesSwarph.js';
const app = (
  <Routes>
    <Route path="/swarph/reglages" element={<ReglagesSwarph />} />
    <Route path="/swarph" element={<p>Connexion swarph</p>} />
  </Routes>
);
async function ouvrir(resultat: BoardResult<unknown>, etatMonitor = monitor) {
  const reponse = { rights: resultat, monitor: etatMonitor };
  const h = setup(app, avecMesh, '/swarph/reglages', {
    ...NAV,
    'GET /api/swarph/reglages': json(200, reponse),
    'GET /api/swarph/reglages?fresh=1': json(200, reponse),
  });
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  await waitFor(() =>
    expect(document.querySelector('[data-node="reglages-swarph.lu-a"]')?.textContent).not.toContain(
      '—',
    ),
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
  const h = setup(app, snapshot(), '/swarph/reglages', NAV);
  await screen.findByText('Connexion swarph');
  expect(h.calls.some((c) => c.url.startsWith('/api/swarph/'))).toBe(false);
});

const droits = {
  peer: 'peer-local',
  groups: ['lecture', '<b>groupe</b>'],
  grants: [
    { grant_type: 'memory', target: '*', level: 'read', direct: true },
    { grant_type: 'board', target: 'projet-test', level: 'read', direct: false },
    { grant_type: 'codegraph', target: 'https://example.com', level: 'read', direct: null },
  ],
};
test('groupes et droits directs, hérités ou inconnus, en texte React', async () => {
  await ouvrir(ok(droits));
  expect(screen.getByText('lecture')).toBeTruthy();
  const lignes = screen.getAllByRole('row').slice(1);
  expect(
    lignes.map((ligne) =>
      within(ligne)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ),
  ).toEqual([
    ['memory', '*', 'read', 'direct'],
    ['board', 'projet-test', 'read', 'hérité'],
    ['codegraph', 'https://example.com', 'read', 'inconnu'],
  ]);
  expect(screen.getByText('<b>groupe</b>').querySelector('b')).toBeNull();
  expect(screen.getByRole('table').querySelector('a')).toBeNull();
  expect(screen.getByText('Vérification de la cellule : à venir.')).toBeTruthy();
  expect(screen.getByText('Sonde des outils : à venir.')).toBeTruthy();
});
test('monitor : état et libellé seulement, aucun chemin ni URL dans le DOM', async () => {
  const sensible = {
    ...monitor,
    state_dir: '/tmp/monitor-confidentiel',
    gateway: 'https://example.com/monitor-prive',
    cell: 'https://example.com/monitor-prive',
  };
  await ouvrir(ok(droits), sensible);
  const contenu = document.querySelector('[data-node="reglages-swarph"]')!;
  expect(contenu.textContent).toContain('running · En marche');
  expect(document.body.innerHTML).not.toContain(sensible.state_dir);
  expect(document.body.innerHTML).not.toContain(sensible.gateway);
});
test.each([
  ['stopped', 'Arrêté'],
  ['stale', 'Périmé'],
  ['absent', 'Absent'],
] as const)('monitor %s : libellé', async (etat, libelle) => {
  await ouvrir(ok(droits), { ...monitor, monitor: etat });
  expect(document.querySelector('[data-node="reglages-swarph.monitor"]')!.textContent).toContain(
    `${etat} · ${libelle}`,
  );
});
test('Recharger relit en fresh et affiche Lu à', async () => {
  const h = await ouvrir(ok(droits));
  expect(document.querySelector('[data-node="reglages-swarph.lu-a"]')!.textContent).toContain(
    'Lu à',
  );
  const bouton = screen.getByRole('button', { name: 'Recharger' }) as HTMLButtonElement;
  fireEvent.click(bouton);
  expect(bouton.disabled).toBe(true);
  fireEvent.click(bouton);
  expect(h.calls.filter((c) => c.url.endsWith('?fresh=1'))).toHaveLength(1);
  await waitFor(() =>
    expect(h.calls.some((c) => c.url === '/api/swarph/reglages?fresh=1')).toBe(true),
  );
});

test.each(['proxy', 'absent', 'stopped'] as const)(
  'monitor %s : aucun contrôle ni chemin du proxy',
  async (etat) => {
    const sensible = { ...monitor, monitor: etat, state_dir: '/tmp/monitor-prive/inbox.log' };
    await ouvrir(ok(droits), sensible);
    if (etat === 'proxy') {
      expect(screen.getByText('Géré par le proxy de ta cellule.')).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: /Démarrer|Arrêter|Relancer/ })).toBeNull();
    expect(document.body.innerHTML).not.toContain(sensible.state_dir);
  },
);

test('D284 : les Réglages swarph affichent le superviseur', async () => {
  await ouvrir(ok(droits), { ...monitor, superviseur: 'launchd:dev.swarph.monitor.peer-a' });
  expect(
    screen.getByText(
      "Supervisé par launchd:dev.swarph.monitor.peer-a : A-I-D ne le démarre ni ne l'arrête.",
    ),
  ).toBeTruthy();
});
