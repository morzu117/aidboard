// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { ActionRun } from '../../src/shared/model.js';
import type { GitBranch } from '../../src/shared/git.js';
import { SelecteurBranche } from '../../web/src/dialogues/SelecteurBranche.js';
import { json, setup, snapshot } from './helpers.js';

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

test('branche déjà extraite ailleurs : non activable, lien vers le sujet propriétaire', async () => {
  setup(<SelecteurBranche topicId="tp_1" onClose={vi.fn()} />, snapshot(), '/', {
    'GET /api/topics/tp_1/git/branches': json(200, {
      branches: [
        branch({ name: 'feat/sujet', isCurrent: true }),
        branch({ name: 'feat/ailleurs', worktree: '/w/ailleurs', topicId: 'tp_2' }),
      ],
    }),
  });
  const ligne = await screen.findByText('feat/ailleurs');
  expect(ligne.closest('[role="option"]')?.getAttribute('aria-disabled')).toBe('true');
  const lien = screen.getByRole('link', { name: 'Aller au sujet' });
  expect(lien.getAttribute('href')).toBe('/sujets/tp_2');
  await userEvent.click(ligne);
  expect(screen.queryByText(/git switch/)).toBeNull();
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
