// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { NavPlacement, NavState } from '../../src/shared/model.js';
import { Sujet } from '../../web/src/ecrans/Sujet.js';
import { annoncerPlacementNav, resetNavCacheForTests } from '../../web/src/ui/Nav.js';
import { json, setup, snapshot, topic, ws } from './helpers.js';

// Chantier 26 : l'en-tête de l'écran Sujet (D111 à D114).

vi.mock('../../web/src/terminal/Terminal.js', () => ({ Terminal: () => null }));
vi.mock('../../web/src/conversation/Conversation.js', () => ({ Conversation: () => null }));

beforeEach(resetNavCacheForTests);
afterEach(cleanup);

const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;

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
const nav = (p: NavPlacement): NavState => ({
  groups: [
    {
      id: 'ng_1',
      name: 'aid',
      color: '#00D994',
      ord: 0,
      collapsed: false,
      hidden: false,
      workspaceId: 'ws_1',
    },
  ],
  placements: [p],
  prefs: { reduit: false, rangement: 'etat' },
});
const state = () =>
  snapshot({ workspaces: [ws()], topics: [topic({ id: 'tp_1', title: 'Mon sujet' })] });
const open = (p: NavPlacement, routes: Record<string, (body: unknown) => Response> = {}) =>
  setup(
    <Routes>
      <Route path="/sujets/:topicId" element={<Sujet />} />
    </Routes>,
    state(),
    '/sujets/tp_1',
    { 'GET /api/nav': json(200, nav(p)), ...routes },
  );

test('D111 : l’en-tête montre le nom affiché, comme la barre ; sans nom affiché, le titre', async () => {
  open(placement({ displayName: 'Nom de la barre' }));
  await waitFor(() => expect(node('1-3.entete.titre')?.textContent).toBe('Nom de la barre'));
  cleanup();
  resetNavCacheForTests();
  open(placement());
  await screen.findByText('Mon sujet', { selector: 'h1' });
});

test('D111 : un nom changé ailleurs atteint l’en-tête et la barre affichée', async () => {
  open(placement());
  // un sujet sans agent est en pause, section repliée par défaut (D103)
  const bascule = await waitFor(() => {
    const b = node('1-3.barre-gauche.etat.section-en-pause.bascule');
    expect(b).not.toBeNull();
    return b!;
  });
  fireEvent.click(bascule);
  const lien = await waitFor(() => {
    const l = node('1-3.barre-gauche.etat.sujet-tp_1');
    expect(l).not.toBeNull();
    return l!;
  });
  act(() => annoncerPlacementNav('tp_1', { displayName: 'Renommé' }));
  await waitFor(() => expect(node('1-3.entete.titre')?.textContent).toBe('Renommé'));
  await waitFor(() => expect(lien.textContent).toContain('Renommé'));
});

const ouvrirMenu = async () => {
  const plus = await waitFor(() => {
    const b = node('1-3.actions.plus');
    expect(b).not.toBeNull();
    return b!;
  });
  fireEvent.click(plus);
};

test('D112 : Renommer depuis le menu ⋯ change le nom affiché, Échap annule, vide revient au titre', async () => {
  const h = open(placement(), { 'PATCH /api/nav/placements/tp_1': json(200, {}) });
  await waitFor(() => expect(node('1-3.entete.titre')?.textContent).toBe('Mon sujet'));
  await ouvrirMenu();
  fireEvent.click(node('1-3.actions.renommer')!);
  const champ = node('1-3.entete.titre.champ') as HTMLInputElement;
  expect(champ.value).toBe('Mon sujet');
  fireEvent.change(champ, { target: { value: 'Abandonné' } });
  fireEvent.keyDown(champ, { key: 'Escape' });
  expect(node('1-3.entete.titre')?.textContent).toBe('Mon sujet');
  expect(h.calls.some((c) => c.method === 'PATCH')).toBe(false);

  await ouvrirMenu();
  fireEvent.click(node('1-3.actions.renommer')!);
  fireEvent.change(node('1-3.entete.titre.champ')!, { target: { value: '  Nouveau nom ' } });
  fireEvent.keyDown(node('1-3.entete.titre.champ')!, { key: 'Enter' });
  await waitFor(() => expect(node('1-3.entete.titre')?.textContent).toBe('Nouveau nom'));
  const patch = h.calls.find((c) => c.method === 'PATCH');
  expect(patch?.url).toBe('/api/nav/placements/tp_1');
  expect(patch?.body).toEqual({ displayName: 'Nouveau nom' });

  await ouvrirMenu();
  fireEvent.click(node('1-3.actions.renommer')!);
  fireEvent.change(node('1-3.entete.titre.champ')!, { target: { value: '' } });
  fireEvent.keyDown(node('1-3.entete.titre.champ')!, { key: 'Enter' });
  await waitFor(() => expect(node('1-3.entete.titre')?.textContent).toBe('Mon sujet'));
  expect(h.calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ displayName: null });
});

test('D112 : Épingler et Archiver passent par le placement, et reviennent en arrière sur un refus', async () => {
  const h = open(placement(), {
    'PATCH /api/nav/placements/tp_1': (body) =>
      (body as { archived?: boolean }).archived !== undefined
        ? json(500, { error: 'refusé' })()
        : json(200, {})(),
  });
  await ouvrirMenu();
  expect(node('1-3.actions.epingler')?.textContent).toBe('Épingler');
  fireEvent.click(node('1-3.actions.epingler')!);
  await waitFor(() =>
    expect(
      h.calls.some((c) => c.method === 'PATCH' && (c.body as { pinned?: boolean }).pinned),
    ).toBe(true),
  );
  await ouvrirMenu();
  await waitFor(() => expect(node('1-3.actions.epingler')?.textContent).toBe('Désépingler'));

  fireEvent.click(node('1-3.actions.archiver')!);
  await screen.findByRole('alert');
  await ouvrirMenu();
  await waitFor(() => expect(node('1-3.actions.archiver')?.textContent).toBe('Archiver'));
  expect(h.calls.some((c) => (c.body as { archived?: boolean } | undefined)?.archived)).toBe(true);
});
