// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { NavPlacement, NavPrefs, NavState } from '../../src/shared/model.js';
import { Reglages } from '../../web/src/ecrans/Reglages.js';
import { LayoutCtx } from '../../web/src/ui/Layout.js';
import { Nav, resetNavCacheForTests } from '../../web/src/ui/Nav.js';
import { resetNavEtatForTests } from '../../web/src/ui/NavEtat.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

// Chantier 25 (D103-D105) : la barre gauche par état, et la bascule vers les groupes du 15 (D104).

const openNewTopic = vi.fn();
afterEach(() => {
  cleanup();
  openNewTopic.mockClear();
  resetNavCacheForTests();
  resetNavEtatForTests();
});
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const n = (rest: string) => node(`1-1.barre-gauche.${rest}`);

const claude: typeof agent = (over = {}) => agent({ kind: 'claude', transport: 'stream', ...over });
const placement = (topicId: string, over: Partial<NavPlacement> = {}): NavPlacement => ({
  topicId,
  groupId: 'ng_1',
  ord: 0,
  pinned: false,
  archived: false,
  hidden: false,
  displayName: null,
  ...over,
});
const nav = (prefs: Partial<NavPrefs> = { rangement: 'etat' }): NavState => ({
  groups: [],
  placements: [
    placement('tp_1'),
    placement('tp_2'),
    placement('tp_3'),
    placement('tp_4'),
    placement('tp_5', { archived: true }),
  ],
  prefs: { reduit: false, ...prefs },
});
const run = (i: number) => ({
  id: `run_${i}`,
  topicId: `tp_${i}`,
  mode: 'standard' as const,
  state: 'open' as const,
  createdAt: 't',
});
const etat = (over = {}) =>
  snapshot({
    workspaces: [ws({ id: 'ws_1', name: 'aid' }), ws({ id: 'ws_2', name: 'skifer', root: '/s' })],
    topics: [
      topic({ id: 'tp_1', branch: 'feat/decider' }),
      topic({ id: 'tp_2', branch: 'feat/relire' }),
      topic({ id: 'tp_3', branch: 'feat/cours', workspaceId: 'ws_2' }),
      topic({ id: 'tp_4', branch: 'feat/pause', workspaceId: 'ws_2' }),
      topic({ id: 'tp_5', branch: 'feat/archive' }),
    ],
    runs: [run(1), run(2), run(3)],
    agents: [
      claude({ id: 'ag_1', runId: 'run_1', status: 'needs_input' }),
      claude({ id: 'ag_2', runId: 'run_2', status: 'idle' }),
      claude({ id: 'ag_3', runId: 'run_3', status: 'working' }),
    ],
    ...over,
  });
const open = (
  snap = etat(),
  navState = nav(),
  extra: Record<string, (b: unknown) => Response> = {},
) =>
  setup(
    <LayoutCtx.Provider
      value={{ openNewTopic, openNewWorkspace: () => {}, overlay: 'aucun', setOverlay: () => {} }}
    >
      <Nav screen="1-1" />
    </LayoutCtx.Provider>,
    snap,
    '/',
    { 'GET /api/nav': json(200, navState), ...extra },
  );
const sectionDuSujet = (id: string) => n(`etat.sujet-${id}`)?.getAttribute('data-section');

test('D103 : les sections dans l’ordre, vides masquées ; gras si À décider, En pause repliée et grisée', async () => {
  open();
  await waitFor(() => expect(n('etat.sections')).not.toBeNull());
  expect(n('racine')!.getAttribute('data-rangement')).toBe('etat');
  // la barre du 15 n'est pas rendue en plus
  expect(n('vues')).toBeNull();
  const titres = [...n('etat.sections')!.querySelectorAll('.barre-gauche-groupe-nom')].map(
    (e) => e.textContent,
  );
  expect(titres).toEqual(['À décider', 'À relire', 'En cours', 'En pause']);
  expect(sectionDuSujet('tp_1')).toBe('a-decider');
  expect(sectionDuSujet('tp_2')).toBe('a-relire');
  expect(sectionDuSujet('tp_3')).toBe('en-cours');
  expect(n('etat.sujet-tp_1')!.className).toContain('nav-etat-sujet--a-decider');
  expect(n('etat.sujet-tp_1')!.textContent).toContain('feat/decider');
  expect(n('etat.sujet-tp_3')!.textContent).toContain('skifer');
  // archivé : nulle part
  expect(n('etat.sujet-tp_5')).toBeNull();
  // En pause est repliée par défaut
  expect(n('etat.section-en-pause.bascule')!.getAttribute('aria-expanded')).toBe('false');
  expect(n('etat.sujet-tp_4')).toBeNull();
  await userEvent.click(n('etat.section-en-pause.bascule')!);
  expect(n('etat.sujet-tp_4')!.className).toContain('nav-etat-sujet--en-pause');
  // une section sans sujet disparaît
  cleanup();
  resetNavCacheForTests();
  resetNavEtatForTests();
  open(etat({ agents: [], runs: [] }));
  await waitFor(() => expect(n('etat.section-en-pause')).not.toBeNull());
  expect(n('etat.section-a-decider')).toBeNull();
});

test('D105 : une tuile par projet filtre la liste ; « Nouveau sujet » part du projet filtré', async () => {
  open();
  await waitFor(() => expect(n('etat.projet-ws_2')).not.toBeNull());
  const tuile = n('etat.projet-ws_2')!;
  expect(tuile.textContent).toBe('S');
  expect(tuile.getAttribute('title')).toBe('skifer');
  expect(n('etat.projet-ws_1')!.textContent).toBe('A');
  await userEvent.click(tuile);
  expect(tuile.getAttribute('aria-pressed')).toBe('true');
  expect(n('etat.sujet-tp_1')).toBeNull();
  expect(n('etat.sujet-tp_3')).not.toBeNull();
  await userEvent.click(node('nav.nouveau-sujet')!);
  expect(openNewTopic).toHaveBeenCalledWith('ws_2');
  await userEvent.click(tuile);
  expect(n('etat.sujet-tp_1')).not.toBeNull();
});

test('liens discrets, serveurs, et « Connecter à swarph » sans mesh ; l’état du monitor avec', async () => {
  open();
  await waitFor(() => expect(n('etat.vues')).not.toBeNull());
  expect(n('etat.vue-tous')!.getAttribute('href')).toBe('/?vue=tous');
  expect(n('etat.vue-epingles')!.getAttribute('href')).toBe('/?vue=epingles');
  expect(n('etat.vue-archives')!.getAttribute('href')).toBe('/?vue=archives');
  expect(n('etat.meshes.swarph')!.getAttribute('href')).toBe('/swarph');
  cleanup();
  resetNavCacheForTests();
  open(
    etat({
      mesh: {
        state: {
          ecritures: false,
          proxyConfigure: false,
          connected: true,
          tailscale: 'running',
          monitor: 'running',
          pending: 0,
          since: null,
          cell: 'morzu-mac',
        },
        inbox: [],
        tailscaleManage: false,
      },
    }),
  );
  await waitFor(() => expect(n('etat.meshes.mesh')).not.toBeNull());
  expect(n('etat.meshes.mesh')!.textContent).toContain('Mesh · cell morzu-mac');
  expect(n('etat.meshes.mesh')!.querySelector('[data-bind="mesh.etat"]')!.textContent).toBe(
    'monitor actif · 0 à traiter',
  );
  expect(n('etat.meshes.mesh')!.getAttribute('href')).toBe('/reglages#mesh');
  expect(n('etat.meshes.swarph')).toBeNull();
});

test('D104 : « groupes », mode réduit et préférence absente gardent la barre du chantier 15', async () => {
  open(etat(), nav({ rangement: 'groupes' }));
  await waitFor(() => expect(n('vues')).not.toBeNull());
  expect(n('etat.sections')).toBeNull();
  cleanup();
  resetNavCacheForTests();
  open(etat(), nav({ rangement: 'etat', reduit: true }));
  await waitFor(() => expect(n('rail')).not.toBeNull());
  expect(n('etat.sections')).toBeNull();
  cleanup();
  resetNavCacheForTests();
  open(etat(), { ...nav(), prefs: { reduit: false } });
  await waitFor(() => expect(n('vues')).not.toBeNull());
  expect(n('etat.sections')).toBeNull();
});

test('D104 : Réglages, « Ranger par mes groupes » enregistre et la barre affichée change aussitôt', async () => {
  const h = setup(
    <Routes>
      <Route path="/reglages" element={<Reglages />} />
    </Routes>,
    etat(),
    '/reglages',
    {
      'GET /api/nav': json(200, nav()),
      'PATCH /api/nav/prefs': json(200, { reduit: false, rangement: 'groupes' }),
    },
  );
  await waitFor(() => expect(node('reglages.barre-gauche.etat.sections')).not.toBeNull());
  const caseGroupes = (await waitFor(() => {
    const e = node('reglages.rangement.groupes');
    expect(e).not.toBeNull();
    return e!;
  })) as HTMLInputElement;
  expect(caseGroupes.checked).toBe(false);
  await userEvent.click(caseGroupes);
  await waitFor(() => expect(caseGroupes.checked).toBe(true));
  expect(h.calls.filter((c) => c.method === 'PATCH')).toEqual([
    { method: 'PATCH', url: '/api/nav/prefs', body: { rangement: 'groupes' } },
  ]);
  await waitFor(() => expect(node('reglages.barre-gauche.vues')).not.toBeNull());
  expect(node('reglages.barre-gauche.etat.sections')).toBeNull();
  // la case n'a pas le data-node des groupes de la barre, qui sont maintenant sur l'écran
  expect(node('reglages.barre-gauche.groupes')).not.toBe(caseGroupes);
  expect(node('reglages.rangement.groupes')).toBe(caseGroupes);
  expect(screen.getByText('Ranger par mes groupes')).not.toBeNull();
});
