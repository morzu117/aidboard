// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { Consignes } from '../../web/src/ecrans/Consignes.js';
import { Reglages } from '../../web/src/ecrans/Reglages.js';
import { json, setup, snapshot, topic, ws } from './helpers.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const text = (id: string) => node(id)?.textContent;
const deux = () =>
  snapshot({
    workspaces: [
      ws({ id: 'a', name: 'api', root: '/p/api' }),
      ws({ id: 'b', name: 'web', root: '/p/web', remote: null, baseBranch: 'dev' }),
    ],
    topics: [
      topic({ id: 't1', workspaceId: 'b' }),
      topic({ id: 't2', workspaceId: 'b', branch: 'feat/x', slug: 'x' }),
    ],
  });

test('l’Accueil n’a plus de section Projets : un projet sans sujet y est une puce de filtre', async () => {
  setup(<Accueil />, deux());
  await screen.findByText('feat/x');
  expect(screen.queryByRole('region', { name: 'Projets' })).toBeNull();
  expect(text('1-1.filtres.workspace-1.nom')).toBe('api');
  await userEvent.click(node('1-1.filtres.workspace-1')!);
  expect(text('1-1.vide.message')).toBe('Aucun sujet ouvert dans api.');
  await userEvent.click(node('1-1.vide.creer')!);
  expect((screen.getByLabelText('Projet') as HTMLSelectElement).value).toBe('a');
});

test('Réglages : chaque projet avec chemin, base, « local » sans remote, et ses sujets ouverts', async () => {
  setup(<Reglages />, deux());
  await screen.findByText('/p/api');
  expect(text('reglages.projets.compte')).toBe('2');
  expect(text('reglages.projets.projet-1.base')).toBe('origin/main');
  expect(node('reglages.projets.projet-1.local')).toBeNull();
  expect(text('reglages.projets.projet-1.sujets')).toBe('aucun sujet ouvert');
  expect(text('reglages.projets.projet-2.base')).toBe('dev');
  expect(text('reglages.projets.projet-2.local')).toBe('local');
  expect(text('reglages.projets.projet-2.sujets')).toBe('2 sujets ouverts');
  // un projet avec des sujets ouverts ne se retire pas
  expect(node('reglages.projets.projet-1.retirer')).not.toBeNull();
  expect(node('reglages.projets.projet-2.retirer')).toBeNull();
});

test('Retirer : confirmation, DELETE, puis la liste se recharge ; un refus s’affiche', async () => {
  const h = setup(<Reglages />, deux());
  await userEvent.click(await screen.findByRole('button', { name: 'Retirer api' }));
  expect(await screen.findByRole('dialog', { name: 'Retirer api ?' })).toBeTruthy();
  h.state = snapshot({ workspaces: [deux().workspaces[1]!], topics: deux().topics });
  await userEvent.click(screen.getByRole('button', { name: 'Retirer' }));
  await waitFor(() => expect(screen.queryByText('/p/api')).toBeNull());
  expect(h.calls.some((c) => c.method === 'DELETE' && c.url === '/api/workspaces/a')).toBe(true);
  cleanup();

  const k = setup(<Reglages />, deux());
  k.respond.set('DELETE /api/workspaces/a', json(409, { error: '1 sujet ouvert : les archiver' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Retirer api' }));
  await userEvent.click(screen.getByRole('button', { name: 'Retirer' }));
  expect((await screen.findByRole('alert')).textContent).toContain('1 sujet ouvert');
});

test('« Ajouter un projet » enregistre sans enchaîner sur la création d’un sujet', async () => {
  const h = setup(<Reglages />, snapshot({ workspaces: [ws()] }));
  h.respond.set(
    'POST /api/workspaces',
    json(201, { ...ws({ id: 'ws_2', name: 'autre' }), warnings: [] }),
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Ajouter un projet' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Choisir mon-depot' }));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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
    <Reglages />,
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

test('hooks : état, installation après confirmation, rappel de relancer les sessions', async () => {
  const h = setup(<Reglages />, snapshot());
  const path = '/home/moi/.claude/settings.json';
  h.respond.set('GET /api/hooks', json(200, { path, installed: false, missing: ['Stop'] }));
  h.respond.set(
    'POST /api/hooks/install',
    json(200, { path, installed: true, missing: [], changed: true, backup: `${path}.aid-1.bak` }),
  );
  await waitFor(() => expect(text('reglages.hooks.etat')).toBe('Non installés'));
  expect(text('reglages.hooks.chemin')).toBe(path);
  await userEvent.click(node('reglages.hooks.installer')!);
  // rien n'est écrit avant la confirmation
  expect(h.calls.some((c) => c.url === '/api/hooks/install')).toBe(false);
  await userEvent.click(node('reglages.hooks.confirmer')!);
  await waitFor(() => expect(text('reglages.hooks.etat')).toBe('Installés'));
  expect(h.calls.find((c) => c.url === '/api/hooks/install')?.body).toEqual({ confirm: true });
  expect(text('reglages.hooks.relancer')).toContain('Relance les sessions');
  expect(text('reglages.hooks.relancer')).toContain('.aid-1.bak');
  expect(node('reglages.hooks.installer')).toBeNull();
});

test('notifications : le bouton demande l’autorisation au navigateur', async () => {
  const requestPermission = vi.fn(async () => 'granted' as const);
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  setup(<Reglages />, snapshot());
  await userEvent.click(await screen.findByRole('button', { name: 'Autoriser les notifications' }));
  expect(requestPermission).toHaveBeenCalled();
  await waitFor(() => expect(text('reglages.notifications.etat')).toBe('Autorisées'));
});

test('Consignes : par projet, fichiers présents, bloc et noyau ; un bloc en retard le dit', async () => {
  const h = setup(<Consignes />, deux());
  h.respond.set(
    'GET /api/workspaces/a/consignes',
    json(200, { claudeMd: true, agentsMd: false, blockVersion: '0.7.1', kernelVersion: '0.8.0' }),
  );
  h.respond.set(
    'GET /api/workspaces/b/consignes',
    json(200, { claudeMd: false, agentsMd: false, blockVersion: null, kernelVersion: '0.8.0' }),
  );
  await waitFor(() => expect(text('consignes.projet-1.claude-md')).toBe('CLAUDE.md présent'));
  expect(text('consignes.projet-1.agents-md')).toBe('AGENTS.md absent');
  expect(text('consignes.projet-1.bloc')).toBe('Bloc agentkit 0.7.1 · noyau installé 0.8.0');
  expect(node('consignes.projet-1.retard')).not.toBeNull();
  await waitFor(() =>
    expect(text('consignes.projet-2.bloc')).toBe(
      'Pas de bloc agentkit dans ces fichiers · noyau installé 0.8.0',
    ),
  );
  expect(node('consignes.projet-2.retard')).toBeNull();
});

test('Réglages (13.2) : la section Version montre AID Server, son mode et la version disponible', async () => {
  const h = setup(<Reglages />, deux());
  h.respond.set(
    'GET /api/daemon/update',
    json(200, {
      mode: 'release',
      version: '0.2.0',
      available: true,
      latest: '0.3.0',
      lastError: null,
    }),
  );
  await screen.findByText('api');
  await waitFor(() => expect(text('reglages.version.serveur')).toBe('AID Server 0.2.0'));
  expect(text('reglages.version.mode')).toContain('releases GitHub');
  expect(text('reglages.version.mode')).toContain('0.3.0 disponible');
});
