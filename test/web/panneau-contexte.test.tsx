// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { PanneauContexte } from '../../web/src/ecrans/PanneauContexte.js';
import { json, setup, snapshot } from './helpers.js';

afterEach(cleanup);

const GIT_LOG_VIDE = json(200, {
  commits: [],
  dirty: false,
  live: { aheadBehind: { ahead: 0, behind: 0 }, rebaseInProgress: false, onTopicBranch: true },
});

const panneau = (over: Partial<Parameters<typeof PanneauContexte>[0]> = {}) => (
  <PanneauContexte
    namespace="aid"
    topicSlug="s"
    topicId="tp_1"
    base="main"
    remote={null}
    activeAgentId={null}
    {...over}
  />
);

const pageMemoire = (slug: string, body: string) => ({
  slug,
  namespace: 'aid',
  title: slug,
  frontmatter: {},
  body,
  revision: 1,
  author: 'x',
  createdAt: 't',
  updatedAt: 't',
});

test('onglets fixes toujours présents ; Plan vide affiche « Plan pas encore écrit »', async () => {
  setup(panneau(), snapshot());
  expect(await screen.findByRole('tab', { name: 'Plan' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Git' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Fichiers' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Revue' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Rétro' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Passation' })).toBeNull();
  expect(await screen.findByText('Plan pas encore écrit')).toBeTruthy();
  expect(screen.queryByText(/Demander un plan à l’agent/)).toBeNull();
});

test('Revue apparaît seulement quand sa page mémoire existe, et affiche son contenu', async () => {
  setup(panneau(), snapshot(), '/', {
    'GET /api/memory/pages?prefix=aid%2F': json(200, { slugs: ['aid/review/s'] }),
    'GET /api/memory/pages/aid/review/s': json(
      200,
      pageMemoire('aid/review/s', 'Corps de la revue.'),
    ),
  });
  const onglet = await screen.findByRole('tab', { name: 'Revue' });
  await userEvent.click(onglet);
  expect(await screen.findByText('Corps de la revue.')).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Rétro' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Passation' })).toBeNull();
});

test('sélection initiale via prop (reprend ?onglet=git) : Git affiché sans clic', async () => {
  setup(panneau({ initialOnglet: 'git' }), snapshot(), '/', {
    'GET /api/topics/tp_1/git/log': GIT_LOG_VIDE,
  });
  const git = await screen.findByRole('tab', { name: 'Git' });
  expect(git.getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('Aucun commit depuis la base.')).toBeTruthy();
});

test('flèches gauche/droite : déplacent le focus et la sélection entre onglets', async () => {
  setup(panneau(), snapshot(), '/', { 'GET /api/topics/tp_1/git/log': GIT_LOG_VIDE });
  const plan = await screen.findByRole('tab', { name: 'Plan' });
  plan.focus();
  await userEvent.keyboard('{ArrowRight}');
  const git = screen.getByRole('tab', { name: 'Git' });
  expect(document.activeElement).toBe(git);
  expect(git.getAttribute('aria-selected')).toBe('true');
  await userEvent.keyboard('{ArrowLeft}');
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Plan' }));
});
