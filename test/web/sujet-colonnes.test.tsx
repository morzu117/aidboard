// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { Sujet } from '../../web/src/ecrans/Sujet.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

let montagesCote = 0;
vi.mock('../../web/src/ecrans/Cote.js', async () => {
  const { useEffect } = await import('react');
  return {
    // un démontage/remontage (contrairement à une simple relecture d'état) déclencherait cet
    // effet à vide une seconde fois : c'est ce que le test « ne démonte jamais » vérifie.
    Cote: ({ activeTopicId }: { activeTopicId: string }) => {
      useEffect(() => {
        montagesCote += 1;
      }, []);
      return <div data-testid="cote-stub" data-active={activeTopicId} />;
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
  montagesCote = 0;
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
  expect(screen.getByTestId('cote-stub')).toBeTruthy();
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
  await userEvent.click(node('1-3.volet.fond')!);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('ouvrir/fermer le popup de navigation ne démonte jamais Cote', async () => {
  open();
  await screen.findByTestId('term-ag_1');
  // le passage « chargement → chargé » remonte Cote une fois (deux branches de rendu
  // distinctes) : c'est la bascule ouvert/fermé du popup qui ne doit plus en ajouter.
  const apresChargement = montagesCote;
  const bouton = screen.getByRole('button', { name: 'Ouvrir la navigation' });
  await userEvent.click(bouton);
  await screen.findByRole('dialog', { name: 'Navigation' });
  await userEvent.click(bouton);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(montagesCote).toBe(apresChargement);
});
