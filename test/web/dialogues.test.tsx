// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import type { ActionRun } from '../../src/shared/model.js';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { NouveauSujet } from '../../web/src/dialogues/NouveauSujet.js';
import { FakeSocket, json, setup, snapshot, topic, ws } from './helpers.js';

afterEach(cleanup);

function Page() {
  const loc = useLocation();
  return (
    <>
      <p data-testid="chemin">{loc.pathname}</p>
      <Accueil />
    </>
  );
}

const action = (over: Partial<ActionRun>): ActionRun => ({
  id: 'ac_1',
  topicId: null,
  workspaceId: 'ws_1',
  action: 'topic.create',
  state: 'running',
  exitCode: null,
  result: null,
  startedAt: 't',
  finishedAt: null,
  ...over,
});

// Nav pose aussi un bouton « Nouveau sujet » (B.2, finding 7) : findByRole serait ambigu entre
// les deux ; les deux appellent openNewTopic(), le premier (celui de la barre du haut) suffit.
async function boutonNouveauSujet() {
  return (await screen.findAllByRole('button', { name: 'Nouveau sujet' }))[0]!;
}

async function pushEvent() {
  await act(async () => {
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.push({
      kind: 'event',
      event: { id: `E${Math.random()}`, type: 'cost', data: {} },
    });
    await new Promise((r) => setTimeout(r, 40));
  });
}

test('enregistrer un workspace : l’erreur du daemon est affichée telle quelle', async () => {
  const h = setup(<Accueil />, snapshot());
  h.respond.set('POST /api/workspaces', json(422, { error: "/tmp/x n'est pas un dépôt git" }));
  await userEvent.click(await boutonNouveauSujet());
  await userEvent.click(await screen.findByRole('button', { name: 'Choisir mon-depot' }));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect((await screen.findByRole('alert')).textContent).toBe("/tmp/x n'est pas un dépôt git");
  expect(h.calls.find((c) => c.url === '/api/workspaces')?.body).toEqual({
    path: '/home/moi/mon-depot',
  });
});

test('enregistrer un workspace : la base facultative est envoyée, les avertissements sont montrés avant de continuer', async () => {
  const h = setup(<Accueil />, snapshot());
  h.respond.set(
    'POST /api/workspaces',
    json(201, { ...ws(), warnings: ['repo sous /mnt : performances WSL2 dégradées'] }),
  );
  await userEvent.click(await boutonNouveauSujet());
  await userEvent.click(await screen.findByRole('button', { name: 'Choisir mon-depot' }));
  await userEvent.type(screen.getByLabelText(/Branche de base/), 'develop');
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByText(/performances WSL2 dégradées/)).toBeTruthy();
  expect(h.calls.find((c) => c.url === '/api/workspaces')?.body).toEqual({
    path: '/home/moi/mon-depot',
    baseBranch: 'develop',
  });
  await userEvent.click(screen.getByRole('button', { name: 'Continuer' }));
  expect(await screen.findByRole('dialog', { name: 'Nouveau sujet' })).toBeTruthy();
});

test('nouveau sujet : l’aperçu suit le titre et le type, sans jamais interpréter le titre', async () => {
  setup(<Accueil />, snapshot({ workspaces: [ws()] }));
  await userEvent.click(await boutonNouveauSujet());
  const preview = () => document.querySelector('.apercu-branche')!.textContent;
  expect(preview()).toContain('titre à saisir');
  expect(
    (screen.getByRole('button', { name: 'Créer le sujet' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await userEvent.type(screen.getByLabelText('Titre'), "Écran d'accueil v2 !");
  expect(preview()).toBe('branche : feat/ecran-d-accueil-v2');
  await userEvent.selectOptions(screen.getByLabelText('Type'), 'fix');
  expect(preview()).toBe('branche : fix/ecran-d-accueil-v2');
});

test('créer un sujet : navigation immédiate vers le brouillon (D15), sans attendre le script', async () => {
  const h = setup(<Page />, snapshot({ workspaces: [ws()] }));
  h.respond.set(
    'POST /api/topics',
    json(202, { actionId: 'ac_1', slug: 'abc', branch: 'feat/abc', topicId: 'tp_9' }),
  );
  await userEvent.click(await boutonNouveauSujet());
  await userEvent.type(screen.getByLabelText('Titre'), 'Abc');
  await userEvent.click(screen.getByRole('button', { name: 'Créer le sujet' }));
  expect(h.calls.find((c) => c.url === '/api/topics')?.body).toEqual({
    workspaceId: 'ws_1',
    title: 'Abc',
    type: 'feat',
  });
  await waitFor(() => expect(screen.getByTestId('chemin').textContent).toBe('/sujets/tp_9'));
  expect(screen.queryByRole('dialog', { name: 'Nouveau sujet' })).toBeNull();
});

test('nettoyer avec des commits non fusionnés : la confirmation répète leur nombre exact', async () => {
  const h = setup(
    <Accueil />,
    snapshot({ workspaces: [ws()], topics: [topic({ worktreeMissing: true })] }),
  );
  h.respond.set('POST /api/topics/tp_1/actions/topic.cleanup', json(202, { actionId: 'ac_9' }));
  await userEvent.click(await screen.findByText('Archiver le sujet'));
  h.state = snapshot({
    workspaces: [ws()],
    topics: [topic({ worktreeMissing: true })],
    actions: [
      action({
        id: 'ac_9',
        action: 'topic.cleanup',
        topicId: 'tp_1',
        state: 'needs_human',
        exitCode: 2,
        result: { unmergedCommits: 2 },
      }),
    ],
  });
  await pushEvent();
  expect((await screen.findByRole('alert')).textContent).toContain('2 commits');
  await userEvent.click(screen.getByRole('button', { name: 'Supprimer quand même' }));
  await waitFor(() => {
    const posts = h.calls.filter((c) => c.url === '/api/topics/tp_1/actions/topic.cleanup');
    expect(posts.at(-1)?.body).toEqual({ confirmUnmerged: 2 });
  });
});

test('nettoyer un sujet sale : le refus est affiché et rien ne propose de forcer', async () => {
  const h = setup(
    <Accueil />,
    snapshot({ workspaces: [ws()], topics: [topic({ worktreeMissing: true })] }),
  );
  h.respond.set('POST /api/topics/tp_1/actions/topic.cleanup', json(202, { actionId: 'ac_9' }));
  await userEvent.click(await screen.findByText('Archiver le sujet'));
  h.state = snapshot({
    workspaces: [ws()],
    topics: [topic({ worktreeMissing: true })],
    actions: [
      action({
        id: 'ac_9',
        action: 'topic.cleanup',
        topicId: 'tp_1',
        state: 'needs_human',
        exitCode: 2,
        result: {},
      }),
    ],
  });
  await act(async () => {
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.push({
      kind: 'ephemeral',
      type: 'action.output',
      actionId: 'ac_9',
      stream: 'stderr',
      line: 'modifications non commitées : rien n’est supprimé',
    });
  });
  await pushEvent();
  expect((await screen.findByRole('alert')).textContent).toContain('non commitées');
  expect(screen.queryByRole('button', { name: 'Supprimer quand même' })).toBeNull();
});

test('avec un dépôt déjà enregistré, « Ajouter un projet » ouvre l’enregistrement et revient à la création de sujet', async () => {
  const h = setup(<Accueil />, snapshot({ workspaces: [ws()] }));
  h.respond.set(
    'POST /api/workspaces',
    json(201, { ...ws({ id: 'ws_2', name: 'autre' }), warnings: [] }),
  );
  await userEvent.click(await boutonNouveauSujet());
  await userEvent.click(screen.getByRole('button', { name: 'Ajouter un projet…' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Choisir mon-depot' }));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByRole('dialog', { name: 'Nouveau sujet' })).toBeTruthy();
});

test('la création de sujet préselectionne le projet le plus récent', async () => {
  setup(
    <Accueil />,
    snapshot({
      workspaces: [
        ws({ id: 'ws_a', name: 'ancien', createdAt: '2026-01-01T00:00:00Z' }),
        ws({ id: 'ws_z', name: 'récent', createdAt: '2026-10-01T00:00:00Z' }),
      ],
    }),
  );
  await userEvent.click(await boutonNouveauSujet());
  expect((screen.getByLabelText('Projet') as HTMLSelectElement).value).toBe('ws_z');
});

// B.4 (re-dev 2/2) : le dialogue peut être monté avant l'hydratation de `state` (clic juste
// après un rechargement) — `workspaces` est alors vide et le défaut n'est pas encore connu.
test('nouveau sujet ouvert avant l’hydratation : le projet par défaut arrive avec l’état', async () => {
  setup(
    <NouveauSujet onClose={() => {}} onAddWorkspace={() => {}} />,
    snapshot({ workspaces: [ws({ id: 'ws_1', createdAt: '2026-01-01T00:00:00Z' })] }),
  );
  expect((screen.getByLabelText('Projet') as HTMLSelectElement).value).toBe('');
  await userEvent.type(screen.getByLabelText('Titre'), 'Abc');
  await waitFor(() =>
    expect((screen.getByLabelText('Projet') as HTMLSelectElement).value).toBe('ws_1'),
  );
  expect(
    (screen.getByRole('button', { name: 'Créer le sujet' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test('nouveau sujet : un choix explicite de projet n’est pas écrasé par un nouvel instantané', async () => {
  const h = setup(
    <NouveauSujet onClose={() => {}} onAddWorkspace={() => {}} />,
    snapshot({
      workspaces: [
        ws({ id: 'ws_a', name: 'ancien', createdAt: '2026-01-01T00:00:00Z' }),
        ws({ id: 'ws_z', name: 'récent', createdAt: '2026-10-01T00:00:00Z' }),
      ],
    }),
  );
  await waitFor(() =>
    expect((screen.getByLabelText('Projet') as HTMLSelectElement).value).toBe('ws_z'),
  );
  await userEvent.selectOptions(screen.getByLabelText('Projet'), 'ws_a');
  h.state = snapshot({
    workspaces: [
      ws({ id: 'ws_a', name: 'ancien', createdAt: '2026-01-01T00:00:00Z' }),
      ws({ id: 'ws_z', name: 'récent', createdAt: '2026-10-01T00:00:00Z' }),
      ws({ id: 'ws_n', name: 'nouveau', createdAt: '2026-10-27T00:00:00Z' }),
    ],
  });
  await pushEvent();
  expect((screen.getByLabelText('Projet') as HTMLSelectElement).value).toBe('ws_a');
});
