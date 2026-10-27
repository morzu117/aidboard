// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { NavGroup, NavPlacement, NavState } from '../../src/shared/model.js';
import { LayoutCtx } from '../../web/src/ui/Layout.js';
import { Nav, resetNavCacheForTests } from '../../web/src/ui/Nav.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

const openNewTopic = vi.fn();
afterEach(() => {
  cleanup();
  openNewTopic.mockClear();
  resetNavCacheForTests();
});

const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;

const groupe = (over: Partial<NavGroup> = {}): NavGroup => ({
  id: 'ng_1',
  name: 'aid',
  color: '#00D994',
  ord: 0,
  collapsed: false,
  hidden: false,
  workspaceId: 'ws_1',
  ...over,
});

const placement = (over: Partial<NavPlacement> = {}): NavPlacement => ({
  topicId: 'tp_1',
  groupId: 'ng_1',
  ord: 0,
  pinned: false,
  archived: false,
  hidden: false,
  displayName: null,
  ...over,
});

const navState = (over: Partial<NavState> = {}): NavState => ({
  groups: [groupe()],
  placements: [placement()],
  prefs: { reduit: false },
  ...over,
});

const open = (
  snap: ReturnType<typeof snapshot>,
  nav: NavState,
  route = '/',
  extra: Record<string, (body: unknown) => Response> = {},
) =>
  setup(
    <LayoutCtx.Provider
      value={{ openNewTopic, openNewWorkspace: () => {}, overlay: 'aucun', setOverlay: () => {} }}
    >
      <Nav screen="1-1" />
    </LayoutCtx.Provider>,
    snap,
    route,
    { 'GET /api/nav': json(200, nav), ...extra },
  );

test('les vues comptent chacune leurs sujets ; « Archivés » n’a pas de compteur', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [
        topic({ id: 'tp_1' }),
        topic({ id: 'tp_2', branch: 'feat/libre' }),
        topic({ id: 'tp_3', branch: 'feat/sans-agent' }),
      ],
      runs: [
        { id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' },
        { id: 'run_2', topicId: 'tp_2', mode: 'standard', state: 'open', createdAt: 't' },
      ],
      agents: [
        agent({ id: 'ag_1', runId: 'run_1', status: 'needs_input', role: 'dev' }),
        agent({ id: 'ag_2', runId: 'run_2', role: 'free', status: 'working' }),
      ],
    }),
    navState({
      placements: [
        placement({ topicId: 'tp_1', ord: 0, pinned: true }),
        placement({ topicId: 'tp_2', ord: 1 }),
        placement({ topicId: 'tp_3', ord: 2 }),
      ],
    }),
  );
  await screen.findByText('aid');
  expect(node('1-1.barre-gauche.vue-tous.compte')?.textContent).toBe('3');
  expect(node('1-1.barre-gauche.vue-a-decider.compte')?.textContent).toBe('1');
  expect(node('1-1.barre-gauche.vue-agent-libre.compte')?.textContent).toBe('1');
  expect(node('1-1.barre-gauche.vue-sans-agent.compte')?.textContent).toBe('1');
  expect(node('1-1.barre-gauche.vue-epingles.compte')?.textContent).toBe('1');
  expect(node('1-1.barre-gauche.vue-archives.compte')).toBeNull();
});

test('compteur de vue : neutre, sauf « À décider » > 0 qui garde la pastille ambre', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ id: 'tp_1' })],
      runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' }],
      agents: [agent({ id: 'ag_1', runId: 'run_1', status: 'needs_input', role: 'dev' })],
    }),
    navState(),
  );
  await screen.findByText('feat/s');
  const vueTous = node('1-1.barre-gauche.vue-tous.compte')!;
  expect(vueTous.className).not.toContain('compteur');
  expect(vueTous.className).toContain('barre-gauche-compte');
  const vueADecider = node('1-1.barre-gauche.vue-a-decider.compte')!;
  expect(vueADecider.className).toContain('compteur');
});

test('badge de décisions sur la ligne de sujet : présent avec le bon nombre, absent sinon', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ id: 'tp_1' }), topic({ id: 'tp_2', branch: 'feat/autre' })],
      runs: [
        { id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' },
        { id: 'run_2', topicId: 'tp_2', mode: 'standard', state: 'open', createdAt: 't' },
      ],
      agents: [
        agent({
          id: 'ag_1',
          runId: 'run_1',
          status: 'needs_input',
          pending: { id: 'pr_1', kind: 'question', question: 'Q ?', options: [] },
        }),
        // needs_input sans pending (ex. permission déjà résolue) : ne compte pas comme décision.
        agent({ id: 'ag_2', runId: 'run_2', status: 'needs_input', pending: null }),
      ],
    }),
    navState({
      placements: [placement({ topicId: 'tp_1', ord: 0 }), placement({ topicId: 'tp_2', ord: 1 })],
    }),
  );
  await screen.findByText('feat/s');
  const ligne1 = node('1-1.barre-gauche.sujet-tp_1')!;
  const badge1 = ligne1.querySelector('.barre-gauche-sujet-decisions');
  expect(badge1?.textContent).toBe('1');
  expect(badge1?.getAttribute('aria-label')).toBe('1 décision en attente');
  const ligne2 = node('1-1.barre-gauche.sujet-tp_2')!;
  expect(ligne2.querySelector('.barre-gauche-sujet-decisions')).toBeNull();
});

test('aucun texte d’état dans la ligne de sujet (reste accessible via le point de statut)', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ id: 'tp_1' }), topic({ id: 'tp_2', branch: 'feat/sans-agent' })],
      runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' }],
      agents: [agent({ id: 'ag_1', runId: 'run_1', status: 'stopped' })],
    }),
    navState({
      placements: [placement({ topicId: 'tp_1', ord: 0 }), placement({ topicId: 'tp_2', ord: 1 })],
    }),
  );
  await screen.findByText('feat/s');
  expect(node('1-1.barre-gauche.sujet-tp_1')?.textContent).not.toMatch(/Arrêté/);
  expect(node('1-1.barre-gauche.sujet-tp_2')?.textContent).not.toMatch(/Aucun agent/);
  expect(screen.queryByText('Arrêté')).toBeNull();
  expect(screen.queryByText('Aucun agent')).toBeNull();
});

test('les vues sont des liens vers /?vue=<id>, aria-current sur la vue de la route courante', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), navState(), '/?vue=a-decider');
  await screen.findByText('feat/s');
  expect(node('1-1.barre-gauche.vue-tous')?.getAttribute('href')).toBe('/?vue=tous');
  expect(node('1-1.barre-gauche.vue-a-decider')?.getAttribute('aria-current')).toBe('page');
  expect(node('1-1.barre-gauche.vue-tous')?.getAttribute('aria-current')).toBeNull();
});

test('sur / sans paramètre, « Tous » porte aria-current', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), navState(), '/');
  await screen.findByText('feat/s');
  expect(node('1-1.barre-gauche.vue-tous')?.getAttribute('aria-current')).toBe('page');
});

test('le bouton « Nouveau sujet » appelle openNewTopic de useLayout', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), navState());
  await screen.findByText('feat/s');
  await userEvent.click(node('nav.nouveau-sujet')!);
  expect(openNewTopic).toHaveBeenCalledTimes(1);
});

test('cache de module : le contenu réapparaît au remontage avant la réponse du fetch', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), navState());
  await screen.findByText('feat/s');
  cleanup();
  // remontage (changement d'écran) : le cache de module affiche tout de suite le dernier groupe
  // connu, sans attendre la résolution du nouveau fetch (§2.2, pas de clignotement). Le sujet,
  // lui, dépend aussi de /api/state (non caché ici) : seul le groupe est une preuve propre au cache nav.
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), navState());
  expect(screen.getByText('aid')).toBeTruthy();
});

test('le bouton de réduction de la navigation a été retiré (B.4 le refera avec le rail)', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), navState());
  await screen.findByText('feat/s');
  expect(
    screen.queryByRole('button', { name: /Réduire la navigation|Déplier la navigation/ }),
  ).toBeNull();
});

test('replier un groupe masque ses sujets et persiste via PATCH', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()] }), navState(), '/', {
    'PATCH /api/nav/groups/ng_1': json(200, {}),
  });
  await screen.findByText('feat/s');
  const bascule = node('1-1.barre-gauche.groupe-ng_1.bascule')!;
  expect(bascule.getAttribute('aria-expanded')).toBe('true');
  await userEvent.click(bascule);
  expect(bascule.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('feat/s')).toBeNull();
  expect(h.calls.some((c) => c.method === 'PATCH' && c.url === '/api/nav/groups/ng_1')).toBe(true);
});

test('un PATCH de repli en échec annule l’état optimiste', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), navState(), '/', {
    'PATCH /api/nav/groups/ng_1': json(500, { error: 'boom' }),
  });
  await screen.findByText('feat/s');
  const bascule = node('1-1.barre-gauche.groupe-ng_1.bascule')!;
  await userEvent.click(bascule);
  // l'appel a échoué (500) : l'état optimiste revient en arrière.
  await waitFor(() => expect(bascule.getAttribute('aria-expanded')).toBe('true'));
  expect(screen.getByText('feat/s')).toBeTruthy();
});

test('le nom affiché est displayName s’il existe, sinon la branche', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ id: 'tp_1' }), topic({ id: 'tp_2', branch: 'feat/brut' })],
    }),
    navState({
      placements: [
        placement({ topicId: 'tp_1', ord: 0, displayName: 'Nom personnalisé' }),
        placement({ topicId: 'tp_2', ord: 1 }),
      ],
    }),
  );
  await screen.findByText('Nom personnalisé');
  expect(screen.getByText('feat/brut')).toBeTruthy();
  expect(screen.queryByText('feat/s')).toBeNull();
});

test('le sujet courant porte aria-current, les autres non', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ id: 'tp_1' }), topic({ id: 'tp_2', branch: 'feat/autre' })],
    }),
    navState({
      placements: [placement({ topicId: 'tp_1', ord: 0 }), placement({ topicId: 'tp_2', ord: 1 })],
    }),
    '/sujets/tp_1',
  );
  await screen.findByText('feat/s');
  expect(node('1-1.barre-gauche.sujet-tp_1')?.getAttribute('aria-current')).toBe('page');
  expect(node('1-1.barre-gauche.sujet-tp_2')?.getAttribute('aria-current')).toBeNull();
  expect(node('1-1.barre-gauche.sujet-tp_1')?.getAttribute('title')).toBe('feat/s');
});

// B.4 (chantier 15, D58) : mode réduit (rail) — vue statique, preuve de rendu seulement (Q5 non tranchée).
afterEach(() => {
  vi.unstubAllGlobals();
});

test('mode réduit (rail) : bouton +, trois vues, un carré non interactif par groupe', async () => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q }) as MediaQueryList);
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ id: 'tp_1' })],
      runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' }],
      agents: [agent({ id: 'ag_1', runId: 'run_1', status: 'needs_input', role: 'dev' })],
    }),
    navState({ prefs: { reduit: true } }),
  );
  await screen.findByRole('button', { name: 'Nouveau sujet' });
  expect(node('1-1.barre-gauche.rail')).toBeTruthy();
  expect(node('1-1.barre-gauche.vues')).toBeNull();
  expect(node('1-1.barre-gauche.rail.vue-tous')).toBeTruthy();
  expect(node('1-1.barre-gauche.rail.vue-agent-libre')).toBeTruthy();
  expect(node('1-1.barre-gauche.rail.vue-sans-agent')).toBeNull();
  const vueADecider = node('1-1.barre-gauche.rail.vue-a-decider')!;
  expect(vueADecider.getAttribute('aria-label')).toBe('À décider, 1');
  expect(vueADecider.querySelector('.barre-gauche-rail-compte--ambre')).toBeTruthy();
  const vueTous = node('1-1.barre-gauche.rail.vue-tous')!;
  expect(vueTous.getAttribute('aria-label')).toBe('Tous, 1');
  const carre = node('1-1.barre-gauche.rail.groupe-ng_1')!;
  expect(carre.getAttribute('role')).toBe('img');
  expect(carre.getAttribute('aria-label')).toBe('aid, 1 sujet');
  expect(carre.getAttribute('title')).toBe('aid, 1 sujet');
  expect(carre.tagName).not.toBe('BUTTON');
  expect(carre.tagName).not.toBe('A');
  expect(screen.getByRole('button', { name: 'Déplier la barre' })).toBeTruthy();
});

test('réduire puis redéployer la barre persiste via PATCH /api/nav/prefs', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()] }), navState(), '/', {
    'PATCH /api/nav/prefs': json(200, {}),
  });
  await screen.findByText('feat/s');
  await userEvent.click(screen.getByRole('button', { name: 'Réduire la barre' }));
  expect(node('1-1.barre-gauche.rail')).toBeTruthy();
  expect(
    h.calls.some(
      (c) =>
        c.method === 'PATCH' &&
        c.url === '/api/nav/prefs' &&
        (c.body as { reduit?: boolean }).reduit === true,
    ),
  ).toBe(true);
  // review B.4 (finding 6) : la bascule change d'arbre DOM, le focus doit suivre sur l'autre bouton.
  const boutonDeplier = screen.getByRole('button', { name: 'Déplier la barre' });
  await waitFor(() => expect(document.activeElement).toBe(boutonDeplier));
  await userEvent.click(boutonDeplier);
  expect(node('1-1.barre-gauche.rail')).toBeNull();
  expect(
    h.calls.some(
      (c) =>
        c.method === 'PATCH' &&
        c.url === '/api/nav/prefs' &&
        (c.body as { reduit?: boolean }).reduit === false,
    ),
  ).toBe(true);
  const boutonReduire = screen.getByRole('button', { name: 'Réduire la barre' });
  await waitFor(() => expect(document.activeElement).toBe(boutonReduire));
});

test('sous 1280 px, la barre reste complète même si « reduit » est enregistré à vrai', async () => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }) as MediaQueryList);
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), navState({ prefs: { reduit: true } }));
  await screen.findByText('feat/s');
  expect(node('1-1.barre-gauche.rail')).toBeNull();
  expect(node('1-1.barre-gauche.vues')).toBeTruthy();
});
