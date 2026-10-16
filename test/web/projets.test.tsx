// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { json, setup, snapshot, topic, ws } from './helpers.js';

afterEach(cleanup);

test('un projet existe sans sujet : il est listé, avec « aucun sujet »', async () => {
  setup(<Accueil />, snapshot({ workspaces: [ws({ name: 'api', root: '/p/api' })] }));
  const projets = await screen.findByRole('region', { name: 'Projets' });
  expect(within(projets).getByText('api')).toBeTruthy();
  expect(within(projets).getByText('aucun sujet')).toBeTruthy();
  expect(screen.getByText(/un projet peut attendre/)).toBeTruthy();
});

test('un projet compte ses sujets, au singulier comme au pluriel', async () => {
  setup(
    <Accueil />,
    snapshot({
      workspaces: [ws({ id: 'a', name: 'a' }), ws({ id: 'b', name: 'b' })],
      topics: [
        topic({ id: 't1', workspaceId: 'a' }),
        topic({ id: 't2', workspaceId: 'b', branch: 'feat/x' }),
        topic({ id: 't3', workspaceId: 'b', branch: 'feat/y' }),
      ],
    }),
  );
  const projets = await screen.findByRole('region', { name: 'Projets' });
  expect(within(projets).getByText('1 sujet')).toBeTruthy();
  expect(within(projets).getByText('2 sujets')).toBeTruthy();
});

test('« Ajouter un projet » enregistre sans enchaîner sur la création d’un sujet', async () => {
  const h = setup(<Accueil />, snapshot({ workspaces: [ws()] }));
  h.respond.set(
    'POST /api/workspaces',
    json(201, { ...ws({ id: 'ws_2', name: 'autre' }), warnings: [] }),
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Ajouter un projet' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Choisir mon-depot' }));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await screen.findByRole('region', { name: 'Projets' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('sans aucun projet, « Nouveau sujet » commence par enregistrer le projet puis enchaîne', async () => {
  const h = setup(<Accueil />, snapshot());
  h.respond.set('POST /api/workspaces', json(201, { ...ws(), warnings: [] }));
  await userEvent.click(await screen.findByRole('button', { name: 'Nouveau sujet' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Choisir mon-depot' }));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByRole('dialog', { name: 'Nouveau sujet' })).toBeTruthy();
});

test('« Nouveau sujet » d’un projet présélectionne ce projet, pas le plus récent', async () => {
  setup(
    <Accueil />,
    snapshot({
      workspaces: [
        ws({ id: 'ws_a', name: 'ancien', createdAt: '2026-01-01T00:00:00Z' }),
        ws({ id: 'ws_z', name: 'récent', createdAt: '2026-10-01T00:00:00Z' }),
      ],
    }),
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Nouveau sujet dans ancien' }));
  expect((screen.getByLabelText('Projet') as HTMLSelectElement).value).toBe('ws_a');
});
