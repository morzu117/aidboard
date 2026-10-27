// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { NavGroup, NavPlacement, NavState } from '../../src/shared/model.js';
import { LayoutCtx } from '../../web/src/ui/Layout.js';
import { Nav, resetNavCacheForTests } from '../../web/src/ui/Nav.js';
import { json, setup, snapshot, topic, ws } from './helpers.js';

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
  color: '#5de0a1',
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
  extra: Record<string, (body: unknown) => Response> = {},
) =>
  setup(
    <LayoutCtx.Provider
      value={{ openNewTopic, openNewWorkspace: () => {}, overlay: 'aucun', setOverlay: () => {} }}
    >
      <Nav screen="1-1" />
    </LayoutCtx.Provider>,
    snap,
    '/',
    { 'GET /api/nav': json(200, nav), ...extra },
  );

const basiqueSnap = () => snapshot({ workspaces: [ws()], topics: [topic({ id: 'tp_1' })] });

test('« Modifier » bascule en mode édition, devient « Terminer », aria-pressed', async () => {
  open(basiqueSnap(), navState());
  await screen.findByText('feat/s');
  const bascule = node('1-1.barre-gauche.groupes.modifier')!;
  expect(bascule.textContent).toBe('Modifier');
  expect(bascule.getAttribute('aria-pressed')).toBe('false');
  await userEvent.click(bascule);
  expect(bascule.textContent).toBe('Terminer');
  expect(bascule.getAttribute('aria-pressed')).toBe('true');
  expect(node('1-1.barre-gauche.sujet-tp_1.actions')).not.toBeNull();
  await userEvent.click(bascule);
  expect(bascule.textContent).toBe('Modifier');
  expect(node('1-1.barre-gauche.sujet-tp_1.actions')).toBeNull();
});

test('« + » crée un groupe et ouvre immédiatement son renommage, texte sélectionné', async () => {
  const h = open(basiqueSnap(), navState(), {
    'POST /api/nav/groups': json(201, {
      id: 'ng_2',
      name: 'Nouveau groupe',
      color: '#a78bfa',
      ord: 1,
      collapsed: false,
      hidden: false,
      workspaceId: null,
    }),
  });
  await screen.findByText('feat/s');
  await userEvent.click(node('1-1.barre-gauche.groupes.nouveau')!);
  const champ = await waitFor(
    () => node('1-1.barre-gauche.groupe-ng_2.renommer') as HTMLInputElement,
  );
  expect(champ.value).toBe('Nouveau groupe');
  expect(champ.placeholder).toBe('Nom du groupe');
  expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/nav/groups')).toBe(true);
});

test('renommer un sujet : Entrée valide (PATCH displayName), Échap annule, vide efface le nom', async () => {
  const h = open(basiqueSnap(), navState(), {
    'PATCH /api/nav/placements/tp_1': json(200, {}),
  });
  await screen.findByText('feat/s');
  await userEvent.click(node('1-1.barre-gauche.groupes.modifier')!);

  await userEvent.dblClick(node('1-1.barre-gauche.sujet-tp_1')!);
  const champRenommage = () => node('1-1.barre-gauche.sujet-tp_1.renommer') as HTMLInputElement;
  expect(champRenommage()).not.toBeNull();
  expect(screen.getByText('branche inchangée : feat/s')).toBeTruthy();

  await userEvent.keyboard('{Escape}');
  expect(node('1-1.barre-gauche.sujet-tp_1.renommer')).toBeNull();
  expect(h.calls.some((c) => c.method === 'PATCH')).toBe(false);

  await userEvent.dblClick(node('1-1.barre-gauche.sujet-tp_1')!);
  await userEvent.clear(champRenommage());
  await userEvent.type(champRenommage(), 'Nom personnalisé');
  await userEvent.keyboard('{Enter}');
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'PATCH' && c.url === '/api/nav/placements/tp_1')).toBe(
      true,
    ),
  );
  const dernierAppel = h.calls.filter((c) => c.url === '/api/nav/placements/tp_1').at(-1)!;
  expect(dernierAppel.body).toEqual({ displayName: 'Nom personnalisé' });

  await userEvent.dblClick(screen.getByText('Nom personnalisé'));
  await userEvent.clear(champRenommage());
  await userEvent.keyboard('{Enter}');
  await waitFor(() => {
    const appels = h.calls.filter((c) => c.url === '/api/nav/placements/tp_1');
    expect(appels.at(-1)!.body).toEqual({ displayName: null });
  });
});

test('renommer un groupe : vide annule (aucun appel), un nom valide persiste', async () => {
  const h = open(basiqueSnap(), navState(), {
    'PATCH /api/nav/groups/ng_1': json(200, {}),
  });
  await screen.findByText('feat/s');
  await userEvent.click(node('1-1.barre-gauche.groupes.modifier')!);
  await userEvent.dblClick(node('1-1.barre-gauche.groupe-ng_1.bascule')!);
  const champ = node('1-1.barre-gauche.groupe-ng_1.renommer') as HTMLInputElement;
  await userEvent.clear(champ);
  await userEvent.keyboard('{Enter}');
  // le double-clic combine deux clics (bascule de repli, sans effet net) et un dblclick (rename) :
  // seule l'absence d'un PATCH portant `name` prouve l'annulation du renommage lui-même.
  expect(
    h.calls.some(
      (c) =>
        c.method === 'PATCH' &&
        c.url === '/api/nav/groups/ng_1' &&
        (c.body as { name?: string })?.name,
    ),
  ).toBe(false);
  expect(screen.getByText('aid')).toBeTruthy();

  await userEvent.dblClick(node('1-1.barre-gauche.groupe-ng_1.bascule')!);
  const champ2 = node('1-1.barre-gauche.groupe-ng_1.renommer') as HTMLInputElement;
  await userEvent.clear(champ2);
  await userEvent.type(champ2, 'Produit');
  await userEvent.keyboard('{Enter}');
  await waitFor(() => {
    const appel = h.calls.find(
      (c) =>
        c.method === 'PATCH' &&
        c.url === '/api/nav/groups/ng_1' &&
        (c.body as { name?: string })?.name,
    );
    expect(appel?.body).toEqual({ name: 'Produit' });
  });
});

test('menu ··· au clavier : « Déplacer vers… » appelle PATCH placements avec le groupe choisi', async () => {
  const h = open(
    snapshot({ workspaces: [ws()], topics: [topic({ id: 'tp_1' })] }),
    navState({
      groups: [groupe({ id: 'ng_1', name: 'aid' }), groupe({ id: 'ng_2', name: 'autre', ord: 1 })],
    }),
    { 'PATCH /api/nav/placements/tp_1': json(200, {}) },
  );
  await screen.findByText('feat/s');
  await userEvent.click(node('1-1.barre-gauche.groupes.modifier')!);
  const bouton = node('1-1.barre-gauche.sujet-tp_1.actions')!;
  await userEvent.click(bouton);
  const deplacer = screen.getByRole('menuitem', { name: 'Déplacer vers…' });
  await userEvent.click(deplacer);
  const cible = screen.getByRole('menuitem', { name: 'autre' });
  await userEvent.click(cible);
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'PATCH' && c.url === '/api/nav/placements/tp_1')).toBe(
      true,
    ),
  );
  const appel = h.calls.find((c) => c.method === 'PATCH' && c.url === '/api/nav/placements/tp_1')!;
  expect(appel.body).toEqual({ groupId: 'ng_2' });
  // §2.4 : après un déplacement au clavier, le focus revient sur le bouton « ··· » de l'élément
  // déplacé — un changement de groupe le remonte ailleurs dans l'arbre (nouveau nœud DOM).
  await waitFor(() =>
    expect(document.activeElement).toBe(node('1-1.barre-gauche.sujet-tp_1.actions')),
  );
});

test('menu ··· : le groupe courant est désactivé dans « Déplacer vers… »', async () => {
  open(
    snapshot({ workspaces: [ws()], topics: [topic({ id: 'tp_1' })] }),
    navState({
      groups: [groupe({ id: 'ng_1', name: 'aid' }), groupe({ id: 'ng_2', name: 'autre', ord: 1 })],
    }),
  );
  await screen.findByText('feat/s');
  await userEvent.click(node('1-1.barre-gauche.groupes.modifier')!);
  await userEvent.click(node('1-1.barre-gauche.sujet-tp_1.actions')!);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Déplacer vers…' }));
  expect(screen.getByRole('menuitem', { name: 'aid' })).toHaveProperty('disabled', true);
});

test('épingler un sujet (PATCH pinned), masquer/afficher un sujet (PATCH hidden)', async () => {
  const h = open(basiqueSnap(), navState(), {
    'PATCH /api/nav/placements/tp_1': json(200, {}),
  });
  await screen.findByText('feat/s');
  await userEvent.click(node('1-1.barre-gauche.groupes.modifier')!);
  await userEvent.click(node('1-1.barre-gauche.sujet-tp_1.actions')!);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Épingler en haut' }));
  await waitFor(() => {
    const dernier = h.calls.filter((c) => c.url === '/api/nav/placements/tp_1').at(-1)!;
    expect(dernier.body).toEqual({ pinned: true });
  });

  await userEvent.click(node('1-1.barre-gauche.sujet-tp_1.actions')!);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Masquer de la barre' }));
  await waitFor(() => {
    const dernier = h.calls.filter((c) => c.url === '/api/nav/placements/tp_1').at(-1)!;
    expect(dernier.body).toEqual({ hidden: true });
  });
});

test('un sujet masqué reste visible et atténué en mode édition, avec « Afficher dans la barre »', async () => {
  open(basiqueSnap(), navState({ placements: [placement({ hidden: true })] }));
  expect(screen.queryByText('feat/s')).toBeNull();
  await userEvent.click(node('1-1.barre-gauche.groupes.modifier')!);
  await screen.findByText('feat/s');
  await userEvent.click(node('1-1.barre-gauche.sujet-tp_1.actions')!);
  expect(screen.getByRole('menuitem', { name: 'Afficher dans la barre' })).toBeTruthy();
});

test('archiver un sujet envoie PATCH archived:true', async () => {
  const h = open(basiqueSnap(), navState(), {
    'PATCH /api/nav/placements/tp_1': json(200, {}),
  });
  await screen.findByText('feat/s');
  await userEvent.click(node('1-1.barre-gauche.groupes.modifier')!);
  await userEvent.click(node('1-1.barre-gauche.sujet-tp_1.actions')!);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Archiver' }));
  await waitFor(() => {
    const dernier = h.calls.filter((c) => c.url === '/api/nav/placements/tp_1').at(-1)!;
    expect(dernier.body).toEqual({ archived: true });
  });
});

test('hors mode édition : ni poignée, ni bouton ···, ni double-clic de renommage', async () => {
  open(basiqueSnap(), navState());
  await screen.findByText('feat/s');
  expect(node('1-1.barre-gauche.sujet-tp_1.actions')).toBeNull();
  expect(node('1-1.barre-gauche.groupe-ng_1.actions')).toBeNull();
  await userEvent.dblClick(node('1-1.barre-gauche.sujet-tp_1')!);
  expect(node('1-1.barre-gauche.sujet-tp_1.renommer')).toBeNull();
});
