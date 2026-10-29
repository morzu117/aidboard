// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { ActionRun } from '../../src/shared/model.js';
import type { GitBranch } from '../../src/shared/git.js';
import { SelecteurBranche } from '../../web/src/dialogues/SelecteurBranche.js';
import { json, setup, snapshot, topic, ws } from './helpers.js';

afterEach(cleanup);

const action = (over: Partial<ActionRun>): ActionRun => ({
  id: 'ac_1',
  topicId: 'tp_1',
  workspaceId: 'ws_1',
  action: 'topic.branch-changer',
  state: 'running',
  exitCode: null,
  result: null,
  startedAt: 't',
  finishedAt: null,
  ...over,
});

const branch = (over: Partial<GitBranch>): GitBranch => ({
  name: 'feat/sujet',
  hash: 'h',
  date: 't',
  ahead: 0,
  behind: 0,
  worktree: null,
  isCurrent: false,
  topicId: null,
  ...over,
});

test('chemin heureux : choisir une branche, confirmer, ferme le sélecteur', async () => {
  const onClose = vi.fn();
  const h = setup(
    <SelecteurBranche topicId="tp_1" onClose={onClose} />,
    snapshot({
      actions: [action({ id: 'ac_1', state: 'succeeded', result: { branch: 'autre' } })],
    }),
    '/',
    {
      'GET /api/topics/tp_1/git/branches': json(200, {
        branches: [branch({ name: 'feat/sujet', isCurrent: true }), branch({ name: 'autre' })],
      }),
      'POST /api/topics/tp_1/actions/topic.branch-changer': json(202, { actionId: 'ac_1' }),
    },
  );
  await userEvent.click(await screen.findByRole('option', { name: /autre/ }));
  expect(screen.getByText('git switch autre')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Changer de branche' }));
  expect(
    h.calls.find((c) => c.url === '/api/topics/tp_1/actions/topic.branch-changer')?.body,
  ).toEqual({ targetBranch: 'autre' });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test('non commité : refus affiché, « mettre de côté et changer » relance avec le stash', async () => {
  const onClose = vi.fn();
  const h = setup(
    <SelecteurBranche topicId="tp_1" onClose={onClose} />,
    snapshot({
      actions: [
        action({ id: 'ac_1', state: 'needs_human', exitCode: 2, result: {} }),
        action({ id: 'ac_2', state: 'succeeded', result: { branch: 'autre', stashRef: 'r' } }),
      ],
    }),
    '/',
    {
      'GET /api/topics/tp_1/git/branches': json(200, {
        branches: [branch({ name: 'feat/sujet', isCurrent: true }), branch({ name: 'autre' })],
      }),
      'POST /api/topics/tp_1/actions/topic.branch-changer': (body: unknown) =>
        new Response(
          JSON.stringify({
            actionId: (body as { dirtyAction?: string }).dirtyAction === 'stash' ? 'ac_2' : 'ac_1',
          }),
          { status: 202 },
        ),
    },
  );
  await userEvent.click(await screen.findByRole('option', { name: /autre/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Changer de branche' }));
  expect((await screen.findByRole('alert')).textContent).toContain('non commitées');
  await userEvent.click(screen.getByRole('button', { name: 'Mettre de côté et changer' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(
    h.calls.filter((c) => c.url === '/api/topics/tp_1/actions/topic.branch-changer').at(-1)?.body,
  ).toEqual({ targetBranch: 'autre', dirtyAction: 'stash' });
});

// 15 : la ligne « déjà extraite ailleurs » devient activable (décompte adapté : 3 expects avant,
// 3 après — non-désactivée, lien inchangé, aperçu de la commande de libération au lieu du refus).
test('branche déjà extraite ailleurs : activable, ouvre l’écran de libération dédié', async () => {
  setup(<SelecteurBranche topicId="tp_1" onClose={vi.fn()} />, snapshot(), '/', {
    'GET /api/topics/tp_1/git/branches': json(200, {
      branches: [
        branch({ name: 'feat/sujet', isCurrent: true }),
        branch({ name: 'feat/ailleurs', worktree: '/w/ailleurs', topicId: 'tp_2' }),
      ],
    }),
  });
  const bouton = await screen.findByRole('option', { name: /feat\/ailleurs/ });
  expect(bouton.getAttribute('aria-disabled')).toBeNull();
  const lien = screen.getByRole('link', { name: 'Aller au sujet' });
  expect(lien.getAttribute('href')).toBe('/sujets/tp_2');
  await userEvent.click(bouton);
  expect(screen.getByText('git -C /w/ailleurs switch --detach')).toBeTruthy();
});

test('libérer puis prendre : deux commandes (base libre), liberer: true, lien persiste après annulation', async () => {
  const onClose = vi.fn();
  const h = setup(
    <SelecteurBranche topicId="tp_1" onClose={onClose} />,
    snapshot({
      workspaces: [ws({ id: 'ws_1', root: '/w/ailleurs', baseBranch: 'main' })],
      topics: [topic({ id: 'tp_1', workspaceId: 'ws_1' })],
      actions: [action({ id: 'ac_1', state: 'succeeded', result: { branch: 'feat/ailleurs' } })],
    }),
    '/',
    {
      'GET /api/topics/tp_1/git/branches': json(200, {
        branches: [
          branch({ name: 'feat/sujet', isCurrent: true }),
          branch({
            name: 'feat/ailleurs',
            worktree: '/w/ailleurs',
            topicId: 'tp_2',
            liberationVers: 'main',
          }),
          branch({ name: 'main', worktree: null }),
        ],
      }),
      'POST /api/topics/tp_1/actions/topic.branch-changer': json(202, { actionId: 'ac_1' }),
    },
  );
  await userEvent.click(await screen.findByRole('option', { name: /feat\/ailleurs/ }));
  expect(screen.getByText(/est extraite dans \/w\/ailleurs/)).toBeTruthy();
  expect(screen.getByText('git -C /w/ailleurs switch main')).toBeTruthy();
  expect(screen.getByText('git switch feat/ailleurs')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  expect(screen.getByRole('link', { name: 'Aller au sujet' })).toBeTruthy();
  await userEvent.click(screen.getByRole('option', { name: /feat\/ailleurs/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Libérer et changer' }));
  expect(
    h.calls.find((c) => c.url === '/api/topics/tp_1/actions/topic.branch-changer')?.body,
  ).toEqual({ targetBranch: 'feat/ailleurs', liberer: true });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

// review (3) : X sale est désormais un 409 synchrone (route), plus un needs_human du script —
// l'écran ne doit donc plus proposer « Mettre de côté et changer », qui ne s'applique qu'au
// sujet courant et reboucle sur le même refus quand la cause est X.
// C7 : « Libérer et changer » reste actif après le refus — l'opérateur peut nettoyer X ailleurs
// puis réessayer sans rouvrir le dialogue.
test('libérer puis prendre : X sale, 409 synchrone, message affiché, « Libérer et changer » reste actif', async () => {
  const onClose = vi.fn();
  let appel = 0;
  const h = setup(
    <SelecteurBranche topicId="tp_1" onClose={onClose} />,
    snapshot({
      actions: [action({ id: 'ac_1', state: 'succeeded', result: { branch: 'feat/ailleurs' } })],
    }),
    '/',
    {
      'GET /api/topics/tp_1/git/branches': json(200, {
        branches: [
          branch({ name: 'feat/sujet', isCurrent: true }),
          branch({ name: 'feat/ailleurs', worktree: '/w/ailleurs', topicId: 'tp_2' }),
        ],
      }),
      'POST /api/topics/tp_1/actions/topic.branch-changer': () => {
        appel += 1;
        if (appel === 1) {
          return new Response(
            JSON.stringify({
              error:
                '/w/ailleurs a des modifications non commitées : commit ou mise de côté là-bas d’abord',
            }),
            { status: 409 },
          );
        }
        return new Response(JSON.stringify({ actionId: 'ac_1' }), { status: 202 });
      },
    },
  );
  await userEvent.click(await screen.findByRole('option', { name: /feat\/ailleurs/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Libérer et changer' }));
  expect((await screen.findByRole('alert')).textContent).toContain('non commitées');
  expect(screen.queryByRole('button', { name: 'Mettre de côté et changer' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Aller au sujet' })).toBeTruthy();
  const reessayer = screen.getByRole('button', { name: 'Libérer et changer' });
  expect(reessayer.hasAttribute('disabled')).toBe(false);
  await userEvent.click(reessayer);
  expect(
    h.calls.filter((c) => c.url === '/api/topics/tp_1/actions/topic.branch-changer').length,
  ).toBe(2);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test('filtre sans correspondance : état vide', async () => {
  setup(<SelecteurBranche topicId="tp_1" onClose={vi.fn()} />, snapshot(), '/', {
    'GET /api/topics/tp_1/git/branches': json(200, {
      branches: [branch({ name: 'feat/sujet', isCurrent: true }), branch({ name: 'autre' })],
    }),
  });
  await screen.findByRole('option', { name: /autre/ });
  await userEvent.type(screen.getByLabelText('Filtrer les branches'), 'zzz');
  expect(await screen.findByText('Aucune branche ne correspond au filtre.')).toBeTruthy();
});

// branches-libres : la zone de création affiche la base du sujet et appelle branche.creer.
test('nouvelle branche depuis la base : affiche la base, appelle branche.creer, ferme au succès', async () => {
  const onClose = vi.fn();
  const h = setup(
    <SelecteurBranche topicId="tp_1" onClose={onClose} />,
    snapshot({
      topics: [topic({ id: 'tp_1', base: 'main' })],
      actions: [action({ id: 'ac_1', action: 'branche.creer', state: 'succeeded', result: {} })],
    }),
    '/',
    {
      'GET /api/topics/tp_1/git/branches': json(200, {
        branches: [branch({ name: 'feat/sujet', isCurrent: true })],
      }),
      'POST /api/topics/tp_1/actions/branche.creer': json(202, { actionId: 'ac_1' }),
    },
  );
  expect(await screen.findByText('Nouvelle branche depuis main')).toBeTruthy();
  await userEvent.type(
    screen.getByLabelText('Nom de la nouvelle branche'),
    'feat/nouvelle-depuis-main',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Créer' }));
  expect(h.calls.find((c) => c.url === '/api/topics/tp_1/actions/branche.creer')?.body).toEqual({
    targetBranch: 'feat/nouvelle-depuis-main',
  });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test('nouvelle branche depuis la base : non commité, « mettre de côté et créer » relance avec le stash', async () => {
  const onClose = vi.fn();
  const h = setup(
    <SelecteurBranche topicId="tp_1" onClose={onClose} />,
    snapshot({
      topics: [topic({ id: 'tp_1', base: 'main' })],
      actions: [
        action({
          id: 'ac_1',
          action: 'branche.creer',
          state: 'needs_human',
          exitCode: 2,
          result: {},
        }),
        action({ id: 'ac_2', action: 'branche.creer', state: 'succeeded', result: {} }),
      ],
    }),
    '/',
    {
      'GET /api/topics/tp_1/git/branches': json(200, {
        branches: [branch({ name: 'feat/sujet', isCurrent: true })],
      }),
      'POST /api/topics/tp_1/actions/branche.creer': (body: unknown) =>
        new Response(
          JSON.stringify({
            actionId: (body as { dirtyAction?: string }).dirtyAction === 'stash' ? 'ac_2' : 'ac_1',
          }),
          { status: 202 },
        ),
    },
  );
  await userEvent.type(await screen.findByLabelText('Nom de la nouvelle branche'), 'feat/nouvelle');
  await userEvent.click(screen.getByRole('button', { name: 'Créer' }));
  expect((await screen.findByRole('alert')).textContent).toContain('non commitées');
  await userEvent.click(screen.getByRole('button', { name: 'Mettre de côté et créer' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(
    h.calls.filter((c) => c.url === '/api/topics/tp_1/actions/branche.creer').at(-1)?.body,
  ).toEqual({ targetBranch: 'feat/nouvelle', dirtyAction: 'stash' });
});

test('nouvelle branche depuis la base : nom déjà pris par une branche locale, refusé sans appel', async () => {
  const h = setup(
    <SelecteurBranche topicId="tp_1" onClose={vi.fn()} />,
    snapshot({ topics: [topic({ id: 'tp_1', base: 'main' })] }),
    '/',
    {
      'GET /api/topics/tp_1/git/branches': json(200, {
        branches: [branch({ name: 'feat/sujet', isCurrent: true }), branch({ name: 'autre' })],
      }),
    },
  );
  await userEvent.type(await screen.findByLabelText('Nom de la nouvelle branche'), 'autre');
  expect(await screen.findByText('La branche autre existe déjà.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Créer' }).hasAttribute('disabled')).toBe(true);
  expect(h.calls.some((c) => c.url === '/api/topics/tp_1/actions/branche.creer')).toBe(false);
});
