// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { ActionRun } from '../../src/shared/model.js';
import { Sujet } from '../../web/src/ecrans/Sujet.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

const action = (over: Partial<ActionRun>): ActionRun => ({
  id: 'ac_1',
  topicId: 'tp_1',
  workspaceId: 'ws_1',
  action: 'topic.create',
  state: 'running',
  exitCode: null,
  result: null,
  startedAt: 't',
  finishedAt: null,
  ...over,
});

let montagesNav = 0;
vi.mock('../../web/src/ui/Nav.js', async () => {
  const { useEffect } = await import('react');
  return {
    // Nav est posée une fois par Layout, qui ne démonte jamais entre les deux branches de Sujet
    // (chargement/chargé) ni entre l'ouverture/fermeture de son propre popup : ce compteur le vérifie.
    Nav: () => {
      useEffect(() => {
        montagesNav += 1;
      }, []);
      return <div data-testid="nav-stub" />;
    },
  };
});
vi.mock('../../web/src/terminal/Terminal.js', () => ({
  Terminal: ({ agentId }: { agentId: string }) => <div data-testid={`term-${agentId}`} />,
}));
vi.mock('../../web/src/conversation/Conversation.js', () => ({
  Conversation: ({ agent: a }: { agent: { id: string } }) => <div data-testid={`conv-${a.id}`} />,
}));

afterEach(cleanup);

const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const run = {
  id: 'run_1',
  topicId: 'tp_1',
  mode: 'standard' as const,
  state: 'open',
  createdAt: 't',
};
const page = (
  <Routes>
    <Route path="/sujets/:topicId" element={<Sujet />} />
  </Routes>
);
const GIT_LOG_VIDE = json(200, {
  commits: [],
  dirty: false,
  live: { aheadBehind: { ahead: 0, behind: 0 }, rebaseInProgress: false, onTopicBranch: true },
});
const open = (route = '/sujets/tp_1', routes: Record<string, (body: unknown) => Response> = {}) => {
  montagesNav = 0;
  return setup(
    page,
    snapshot({
      workspaces: [ws()],
      topics: [topic()],
      runs: [run],
      agents: [agent({ id: 'ag_1', kind: 'claude', role: 'free' })],
    }),
    route,
    routes,
  );
};

// Hors vue complète (finding 1) : sujet absent de l'état (archivé ou en échec de préparation).
const ouvrirSansVueComplete = (
  snap: ReturnType<typeof snapshot>,
  routes: Record<string, (body: unknown) => Response> = {},
) => {
  montagesNav = 0;
  return setup(page, snap, '/sujets/tp_1', routes);
};

test('le panneau contextuel est une colonne à part : agents et Git/Fichiers coexistent, sans clic', async () => {
  open();
  await screen.findByTestId('term-ag_1');
  expect(node('1-3.panneau')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Git' })).toBeTruthy();
  expect(screen.getByTestId('term-ag_1')).toBeTruthy();
});

test('?onglet=git présélectionne l’onglet Git du panneau, sans clic', async () => {
  open('/sujets/tp_1?onglet=git', { 'GET /api/topics/tp_1/git/log': GIT_LOG_VIDE });
  const git = await screen.findByRole('tab', { name: 'Git' });
  expect(git.getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('Aucun commit depuis la base.')).toBeTruthy();
});

test('le bouton flottant « Ouvrir la navigation » ouvre un popup ; Échap le referme et rend le focus', async () => {
  open();
  await screen.findByTestId('term-ag_1');
  const bouton = screen.getByRole('button', { name: 'Ouvrir la navigation' });
  await userEvent.click(bouton);
  expect(await screen.findByRole('dialog', { name: 'Navigation' })).toBeTruthy();
  expect(screen.getByTestId('nav-stub')).toBeTruthy();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull());
  expect(document.activeElement).toBe(bouton);
});

test('un seul popup ouvert à la fois ; le bouton « Fermer » referme et rend le focus au déclencheur', async () => {
  open();
  await screen.findByTestId('term-ag_1');
  const boutonNav = screen.getByRole('button', { name: 'Ouvrir la navigation' });
  const boutonPanneau = screen.getByRole('button', { name: 'Ouvrir le panneau du sujet' });
  await userEvent.click(boutonNav);
  expect(await screen.findByRole('dialog', { name: 'Navigation' })).toBeTruthy();
  await userEvent.click(boutonPanneau);
  expect(await screen.findByRole('dialog', { name: 'Panneau du sujet' })).toBeTruthy();
  // un seul popup à la fois : ouvrir le panneau a refermé la navigation restée ouverte.
  expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Fermer' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(boutonPanneau);
});

test('un clic sur le fond assombri referme le popup ouvert', async () => {
  open();
  await screen.findByTestId('term-ag_1');
  await userEvent.click(screen.getByRole('button', { name: 'Ouvrir le panneau du sujet' }));
  await screen.findByRole('dialog', { name: 'Panneau du sujet' });
  await userEvent.click(node('1-3.volet.panneau.fond')!);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('Nav, posée une fois par Layout, ne démonte jamais à l’ouverture/fermeture de son popup', async () => {
  open();
  await screen.findByTestId('term-ag_1');
  expect(montagesNav).toBe(1);
  const bouton = screen.getByRole('button', { name: 'Ouvrir la navigation' });
  await userEvent.click(bouton);
  await screen.findByRole('dialog', { name: 'Navigation' });
  await userEvent.click(bouton);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(montagesNav).toBe(1);
});

// review D, finding 1 : hors vue complète (sujet absent de l'état, ou préparation en échec),
// aucun bouton ni panneau pour le volet du sujet — Contenu rend sa propre vue à une colonne
// comme avant. La navigation (B.2) reste posée par Layout : elle n'est pas liée à vueComplete.
test('sujet archivé : vue à une colonne, Nav posée, aucun bouton ni panneau de volet sujet', async () => {
  ouvrirSansVueComplete(snapshot({ workspaces: [ws()], topics: [] }), {
    'GET /api/topics/tp_1/events': json(200, {
      topic: {
        id: 'tp_1',
        workspaceId: 'ws_1',
        slug: 's',
        title: 'Sujet clos',
        branch: 'feat/s',
        base: 'main',
        worktree: '/w/s',
        state: 'archived',
        stashRef: null,
        createdAt: 't',
        updatedAt: 't',
      },
      events: [],
    }),
  });
  await screen.findByText('Sujet clos');
  expect(screen.getByRole('button', { name: 'Ouvrir la navigation' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Ouvrir le panneau du sujet' })).toBeNull();
  expect(node('1-3.panneau')).toBeNull();
});

test('sujet en échec de préparation : vue à une colonne, Nav posée, aucun bouton ni panneau de volet sujet', async () => {
  ouvrirSansVueComplete(
    snapshot({
      workspaces: [ws()],
      topics: [],
      actions: [action({ state: 'needs_human', exitCode: 2 })],
    }),
  );
  await screen.findByText('La préparation du sujet a échoué');
  expect(screen.getByRole('button', { name: 'Ouvrir la navigation' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Ouvrir le panneau du sujet' })).toBeNull();
  expect(node('1-3.panneau')).toBeNull();
});

// review D, finding 2 : une pop-up ouverte rend inerte le reste de l'écran (vraie modale).
test('pop-up ouverte : colonne centrale, autre volet et boutons flottants inertes ; fermée, plus d’inert', async () => {
  open();
  await screen.findByTestId('term-ag_1');
  const boutonNav = screen.getByRole('button', { name: 'Ouvrir la navigation' });
  const boutonPanneau = screen.getByRole('button', { name: 'Ouvrir le panneau du sujet' });
  await userEvent.click(boutonPanneau);
  await screen.findByRole('dialog', { name: 'Panneau du sujet' });
  expect(node('1-3.terminaux')!.closest('[inert]')).toBeTruthy();
  expect(node('1-3.volet.nav')!.hasAttribute('inert')).toBe(true);
  expect(boutonNav.hasAttribute('inert')).toBe(true);
  expect(boutonPanneau.hasAttribute('inert')).toBe(true);
  expect(node('1-3.volet.panneau')!.hasAttribute('inert')).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Fermer' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(node('1-3.terminaux')!.closest('[inert]')).toBeNull();
  expect(node('1-3.volet.nav')!.hasAttribute('inert')).toBe(false);
  expect(boutonNav.hasAttribute('inert')).toBe(false);
  expect(boutonPanneau.hasAttribute('inert')).toBe(false);
});

test('pop-up ouverte : Tab depuis le dernier élément revient au premier, Maj+Tab inverse', async () => {
  open();
  await screen.findByTestId('term-ag_1');
  await userEvent.click(screen.getByRole('button', { name: 'Ouvrir le panneau du sujet' }));
  const dialogue = await screen.findByRole('dialog', { name: 'Panneau du sujet' });
  const focusables = Array.from(
    dialogue.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    ),
  );
  expect(focusables.length).toBeGreaterThan(1);
  const premier = focusables[0]!;
  const dernier = focusables[focusables.length - 1]!;
  dernier.focus();
  await userEvent.keyboard('{Tab}');
  expect(document.activeElement).toBe(premier);
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(document.activeElement).toBe(dernier);
});
