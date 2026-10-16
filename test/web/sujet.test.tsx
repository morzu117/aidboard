// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { Sujet } from '../../web/src/ecrans/Sujet.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

vi.mock('../../web/src/terminal/Terminal.js', () => ({
  Terminal: ({ agentId, visible }: { agentId: string; visible: boolean }) => (
    <div data-testid={`term-${agentId}`} data-visible={String(visible)} />
  ),
}));

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const text = (id: string) => node(id)?.textContent;
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
const open = (state: ReturnType<typeof snapshot> | 'down', id = 'tp_1') =>
  setup(page, state, `/sujets/${id}`);

test('en-tête : fil d’Ariane, titre, état, branche, base, worktree', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  await screen.findByText('Mon sujet');
  expect(text('1-3.entete.workspace')).toBe('aid');
  expect(text('1-3.entete.titre')).toBe('Mon sujet');
  expect(text('1-3.entete.etat')).toBe('active');
  expect(text('1-3.entete.branche')).toBe('feat/s');
  expect(text('1-3.entete.base.branche')).toBe('origin/main');
  expect(text('1-3.entete.worktree')).toBe('/w/s');
});

test('en-tête d’un projet sans remote : la base est la branche locale, sans « origin/ »', async () => {
  open(snapshot({ workspaces: [ws({ remote: null })], topics: [topic()], runs: [run] }));
  await screen.findByText('Mon sujet');
  expect(text('1-3.entete.base.branche')).toBe('main');
});

test.each([
  ['disabled', 'index absent : lecture directe'],
  ['indexing', 'indexation en cours'],
  ['ready', 'index prêt'],
  ['failed', 'index en échec : lecture directe'],
] as const)(
  'index %s : « %s » (le repli est déclaré, jamais silencieux)',
  async (indexState, label) => {
    open(snapshot({ workspaces: [ws()], topics: [topic({ indexState })], runs: [run] }));
    await screen.findByText('Mon sujet');
    expect(text('1-3.entete.index')).toBe(label);
  },
);

test('la colonne de gauche liste les sujets par workspace et marque le sujet courant', async () => {
  open(
    snapshot({
      workspaces: [ws(), ws({ id: 'ws_2', name: 'project_1' })],
      topics: [topic(), topic({ id: 'tp_2', workspaceId: 'ws_2', branch: 'fix/y', slug: 'y' })],
    }),
  );
  await screen.findByText('Mon sujet');
  expect(text('1-3.sujets.groupe-1.nom')).toBe('aid');
  expect(text('1-3.sujets.groupe-2.nom')).toBe('project_1');
  expect(node('1-3.sujets.sujet-1')?.className).toContain('est-actif');
  expect(node('1-3.sujets.sujet-2')?.getAttribute('href')).toBe('/sujets/tp_2');
});

test('sans agent : trois façons de démarrer, et le lancement appelle POST /api/agents', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  h.respond.set('POST /api/agents', json(201, { ...agent({ id: 'ag_9', kind: 'claude' }) }));
  await screen.findByText('Aucun agent ne tourne sur ce sujet.');
  expect(screen.getByText(/dialogue de confiance/)).toBeTruthy();
  await userEvent.click(node('1-3.vide.lancer-claude')!);
  await waitFor(() =>
    expect(h.calls.find((c) => c.url === '/api/agents')?.body).toEqual({
      topicId: 'tp_1',
      kind: 'claude',
    }),
  );
  await userEvent.click(node('1-3.vide.shell')!);
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url === '/api/agents').at(-1)?.body).toEqual({
      topicId: 'tp_1',
      kind: 'shell',
    }),
  );
  expect(node('1-3.vide.lancer-cursor')).toBeNull();
});

test('un binaire absent : le message du daemon est affiché', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  h.respond.set(
    'POST /api/agents',
    json(422, { error: 'claude introuvable dans le PATH du daemon' }),
  );
  await userEvent.click(await screen.findByText('Lancer claude'));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'claude introuvable dans le PATH du daemon',
  );
});

test('onglets : un terminal monté par agent, un seul visible ; « Arrêter » seulement sur un agent vivant', async () => {
  const h = open(
    snapshot({
      workspaces: [ws()],
      topics: [topic()],
      runs: [run],
      agents: [
        agent({ id: 'ag_1', kind: 'claude', role: 'free' }),
        agent({ id: 'ag_2', kind: 'shell', status: 'done' }),
      ],
    }),
  );
  h.respond.set('DELETE /api/agents/ag_1', json(202, { id: 'ag_1' }));
  await screen.findByTestId('term-ag_1');
  expect(screen.getByTestId('term-ag_2').getAttribute('data-visible')).toBe('true');
  expect(screen.getByTestId('term-ag_1').getAttribute('data-visible')).toBe('false');
  expect(text('1-3.terminaux.onglet-1.type')).toBe('claude');
  // « free » n'est pas du français : l'agent lancé à la main est « libre »
  expect(text('1-3.terminaux.onglet-1.role')).toBe('libre');
  expect(node('1-3.terminaux.onglet-1.arreter')).not.toBeNull();
  expect(node('1-3.terminaux.onglet-2.arreter')).toBeNull();
  await userEvent.click(node('1-3.terminaux.onglet-1')!);
  expect(screen.getByTestId('term-ag_1').getAttribute('data-visible')).toBe('true');
  expect(screen.getByTestId('term-ag_2').getAttribute('data-visible')).toBe('false');
  await userEvent.click(node('1-3.terminaux.onglet-1.arreter')!);
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'DELETE' && c.url === '/api/agents/ag_1')).toBe(true),
  );
});

test('« + Agent » propose les trois types et lance celui choisi', async () => {
  const h = open(
    snapshot({ workspaces: [ws()], topics: [topic()], runs: [run], agents: [agent()] }),
  );
  h.respond.set('POST /api/agents', json(201, agent({ id: 'ag_7', kind: 'codex' })));
  await userEvent.click(await screen.findByText('+ Agent'));
  await userEvent.click(screen.getByText('Lancer codex'));
  await waitFor(() =>
    expect(h.calls.find((c) => c.url === '/api/agents')?.body).toEqual({
      topicId: 'tp_1',
      kind: 'codex',
    }),
  );
});

test('ouvrir dans l’éditeur : appelle l’action, et un éditeur introuvable est expliqué', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  h.respond.set(
    'POST /api/topics/tp_1/actions/editor.open',
    json(422, {
      error: 'impossible de lancer l’éditeur (code). Régler « editor » dans ~/.aid/config.yaml.',
    }),
  );
  await userEvent.click(await screen.findByText('Ouvrir dans l’éditeur'));
  expect((await screen.findByRole('alert')).textContent).toContain('config.yaml');
});

test('nettoyer : le menu appelle topic.cleanup, un refus pour travail non commité est affiché sans option de forcer', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  h.respond.set(
    'POST /api/topics/tp_1/actions/topic.cleanup',
    json(409, { error: 'des agents tournent encore : les arrêter avant de nettoyer' }),
  );
  await userEvent.click(await screen.findByLabelText('Plus d’actions'));
  await userEvent.click(screen.getByText('Nettoyer le sujet'));
  expect((await screen.findByRole('alert')).textContent).toContain('des agents tournent encore');
  expect(screen.queryByText('Supprimer quand même')).toBeNull();
});

test('worktree introuvable : bandeau, aucun terminal, éditeur désactivé', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ worktreeMissing: true })],
      runs: [run],
      agents: [agent()],
    }),
  );
  expect(await screen.findByText('Worktree introuvable')).toBeTruthy();
  expect(screen.queryByTestId('term-ag_1')).toBeNull();
  expect((screen.getByText('Ouvrir dans l’éditeur') as HTMLButtonElement).disabled).toBe(true);
});

test('sujet inconnu ou archivé', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), 'tp_nope');
  expect(await screen.findByText('Sujet introuvable ou archivé.')).toBeTruthy();
});

test('loading : squelettes ; error : bandeau avec « Réessayer » ; liste de gauche indisponible', async () => {
  open(snapshot());
  expect(node('1-3.terminaux')?.className).toContain('squelette');
  expect(node('1-3.sujets.squelette-1')).not.toBeNull();
  cleanup();
  const h = open('down');
  expect((await screen.findByRole('alert', {}, { timeout: 3000 })).textContent).toContain(
    'injoignable',
  );
  expect(text('1-3.sujets.indisponible')).toBe('Liste indisponible');
  h.state = snapshot({ workspaces: [ws()], topics: [topic()] });
  await userEvent.click(node('1-3.erreur.bandeau.reessayer')!);
  await screen.findByText('Mon sujet');
});

test('un titre ou une branche piégés ne sont jamais du HTML', async () => {
  open(
    snapshot({ workspaces: [ws()], topics: [topic({ title: '<img src=x onerror=alert(1)>' })] }),
  );
  await screen.findByText('<img src=x onerror=alert(1)>');
  expect(document.querySelector('img')).toBeNull();
});
