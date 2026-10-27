// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import type { NavGroup, NavPlacement, NavState } from '../../src/shared/model.js';
import { Nav } from '../../web/src/ui/Nav.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

afterEach(cleanup);

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
) => setup(<Nav screen="1-1" />, snap, route, { 'GET /api/nav': json(200, nav), ...extra });

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
  expect(node('1-1.barre-gauche.vue-decider.compte')?.textContent).toBe('1');
  expect(node('1-1.barre-gauche.vue-libre.compte')?.textContent).toBe('1');
  expect(node('1-1.barre-gauche.vue-sans-agent.compte')?.textContent).toBe('1');
  expect(node('1-1.barre-gauche.vue-epingles.compte')?.textContent).toBe('1');
  expect(node('1-1.barre-gauche.vue-archives.compte')).toBeNull();
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
});
