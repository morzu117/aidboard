// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`);
const text = (id: string) => node(id)?.textContent;
// 13.2 : la forme de GET /api/daemon/update (UpdateInfo), mode repo par défaut
const maj = (over: Record<string, unknown> = {}) => ({
  mode: 'repo',
  version: '0.1.0',
  available: true,
  latest: '1234567deadbeef',
  lastError: null,
  ...over,
});

test('loading : des squelettes tant que l’instantané n’est pas arrivé', () => {
  setup(<Accueil />, snapshot());
  expect(node('1-1.grille.squelette-1')).not.toBeNull();
  expect(node('1-1.grille.squelette-6')).not.toBeNull();
});

test('empty : aucun sujet, le bouton ouvre d’abord « Nouveau projet » quand aucun dépôt n’est enregistré', async () => {
  setup(<Accueil />, snapshot());
  expect(await screen.findByText(/Aucun projet/)).toBeTruthy();
  await userEvent.click(node('1-1.vide.creer')!);
  expect(await screen.findByRole('dialog', { name: 'Nouveau projet' })).toBeTruthy();
});

test('empty avec un dépôt : « Nouveau sujet » ouvre la création de sujet', async () => {
  setup(<Accueil />, snapshot({ workspaces: [ws()] }));
  await userEvent.click(
    await screen
      .findByRole('button', { name: 'Nouveau sujet', hidden: false })
      .then(() => node('1-1.vide.creer')!),
  );
  expect(await screen.findByRole('dialog', { name: 'Nouveau sujet' })).toBeTruthy();
});

test('default : une carte par sujet, avec branche, workspace, titre, badge, agents et lien', async () => {
  setup(
    <Accueil />,
    snapshot({
      workspaces: [ws(), ws({ id: 'ws_2', name: 'project_1' })],
      topics: [
        topic(),
        topic({ id: 'tp_2', workspaceId: 'ws_2', branch: 'fix/x', title: 'Autre', slug: 'x' }),
      ],
      runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' }],
      agents: [agent(), agent({ id: 'ag_2', kind: 'claude', status: 'error' })],
    }),
  );
  await screen.findByText('feat/s');
  expect(text('1-1.entete.resume.sujets')).toBe('2');
  expect(text('1-1.grille.sujet-1.branche')).toBe('feat/s');
  expect(text('1-1.grille.sujet-1.workspace')).toBe('aid');
  expect(text('1-1.grille.sujet-1.titre')).toBe('Mon sujet');
  expect(text('1-1.grille.sujet-1.statut')).toBe('Erreur');
  expect(text('1-1.grille.sujet-1.agent-1.type')).toBe('shell');
  expect(text('1-1.grille.sujet-1.agent-2.type')).toBe('claude');
  expect(text('1-1.grille.sujet-2.statut')).toBe('Aucun agent');
  expect(node('1-1.grille.sujet-1.actions.ouvrir')?.getAttribute('href')).toBe('/sujets/tp_1');
});

test('un agent qui démarre est « Démarrage » ; un shell seul est « shell », sans rôle', async () => {
  setup(
    <Accueil />,
    snapshot({
      workspaces: [ws()],
      topics: [topic(), topic({ id: 'tp_2', branch: 'feat/t', slug: 't' })],
      runs: [
        { id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' },
        { id: 'run_2', topicId: 'tp_2', mode: 'standard', state: 'open', createdAt: 't' },
      ],
      agents: [agent({ kind: 'claude' }), agent({ id: 'ag_2', runId: 'run_2' })],
    }),
  );
  await screen.findByText('feat/s');
  expect(text('1-1.grille.sujet-1.statut')).toBe('Démarrage');
  expect(text('1-1.grille.sujet-2.statut')).toBe('shell');
  expect(node('1-1.grille.sujet-2.agent-1.role')).toBeNull();
});

test('le filtre par workspace masque les autres sujets', async () => {
  setup(
    <Accueil />,
    snapshot({
      workspaces: [ws(), ws({ id: 'ws_2', name: 'project_1' })],
      topics: [topic(), topic({ id: 'tp_2', workspaceId: 'ws_2', branch: 'fix/x', slug: 'x' })],
    }),
  );
  await screen.findByText('feat/s');
  await userEvent.click(node('1-1.filtres.workspace-2')!);
  expect(screen.queryByText('feat/s')).toBeNull();
  expect(screen.getByText('fix/x')).toBeTruthy();
  await userEvent.click(node('1-1.filtres.workspace-tous')!);
  expect(screen.getByText('feat/s')).toBeTruthy();
});

test('error : daemon injoignable, bandeau avec cause, et « Réessayer » relit l’état', async () => {
  const h = setup(<Accueil />, 'down');
  const band = await screen.findByRole('alert', {}, { timeout: 3000 });
  expect(within(band).getByText('Impossible de lire l’état des sujets')).toBeTruthy();
  expect(text('1-1.erreur.bandeau.cause')).toContain('injoignable');
  expect(text('1-1.entete.resume') ?? document.querySelector('.resume')?.textContent).toContain(
    'État indisponible',
  );
  h.state = snapshot({ workspaces: [ws()], topics: [topic()] });
  await userEvent.click(node('1-1.erreur.bandeau.reessayer')!);
  await screen.findByText('feat/s');
});

test('worktree introuvable : cas d’erreur, et « Archiver » appelle topic.cleanup', async () => {
  const h = setup(
    <Accueil />,
    snapshot({ workspaces: [ws()], topics: [topic({ worktreeMissing: true })] }),
  );
  h.respond.set('POST /api/topics/tp_1/actions/topic.cleanup', json(202, { actionId: 'ac_1' }));
  await screen.findByText(/Worktree introuvable/);
  expect(screen.queryByText('Ouvrir le sujet →')).toBeNull();
  await userEvent.click(node('1-1.erreur.sujet-1.archiver')!);
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) => c.method === 'POST' && c.url === '/api/topics/tp_1/actions/topic.cleanup',
      ),
    ).toBe(true),
  );
});

test('texte d’agent ou de titre : jamais interprété comme du HTML', async () => {
  setup(
    <Accueil />,
    snapshot({
      workspaces: [ws()],
      topics: [topic({ title: '<img src=x onerror=alert(1)>', branch: 'feat/<b>gras</b>' })],
    }),
  );
  await screen.findByText('<img src=x onerror=alert(1)>');
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('b')).toBeNull();
});

test('bandeau de mise à jour : affiché si le daemon signale origin/main en avance, absent sinon', async () => {
  const h = setup(<Accueil />, snapshot({ workspaces: [ws()], topics: [topic()] }));
  h.respond.set('GET /api/daemon/update', json(200, maj()));
  await screen.findByText('feat/s');
  expect(await screen.findByText('Nouvelle version d’aidboard disponible')).toBeTruthy();
  expect(text('1-1.maj.aide')).toContain('1234567');
});

test('bandeau de mise à jour : rien si le daemon ne sait pas ou dit à jour', async () => {
  setup(<Accueil />, snapshot({ workspaces: [ws()], topics: [topic()] }));
  await screen.findByText('feat/s');
  expect(node('1-1.maj')).toBeNull();
});

test('bandeau de mise à jour : le CTA « Mettre à jour » lance POST /api/daemon/update', async () => {
  const h = setup(<Accueil />, snapshot({ workspaces: [ws()], topics: [topic()] }));
  h.respond.set('GET /api/daemon/update', json(200, maj()));
  h.respond.set('POST /api/daemon/update', json(202, { updating: true, agents: 0 }));
  await screen.findByText('feat/s');
  await screen.findByText('Nouvelle version d’aidboard disponible');
  await userEvent.click(node('1-1.maj.lancer')!);
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/daemon/update')).toBe(true),
  );
});

test('bandeau de mise à jour : un échec signalé après coup (lastError) sort du blocage « Mise à jour… »', async () => {
  const h = setup(<Accueil />, snapshot({ workspaces: [ws()], topics: [topic()] }));
  h.respond.set('GET /api/daemon/update', json(200, maj()));
  h.respond.set('POST /api/daemon/update', json(202, { updating: true, agents: 0 }));
  await screen.findByText('feat/s');
  await screen.findByText('Nouvelle version d’aidboard disponible');
  await userEvent.click(node('1-1.maj.lancer')!);
  await waitFor(() => expect(text('1-1.maj.lancer')).toBe('Mise à jour…'));
  // La tentative en cours échoue côté daemon (pull refusé, build qui plante…) : il reste en
  // service sur l'ancien build et ne redémarre pas — seul un nouveau GET le révèle.
  h.respond.set(
    'GET /api/daemon/update',
    json(200, maj({ lastError: 'mise à jour échouée (pull) : divergent' })),
  );
  await waitFor(() => expect(text('1-1.maj.erreur')).toContain('divergent'), { timeout: 4000 });
  expect(text('1-1.maj.lancer')).toBe('Mettre à jour');
}, 6000);

test('bandeau de mise à jour : un agent vivant (409) propose de forcer, qui relance avec force: true', async () => {
  const h = setup(<Accueil />, snapshot({ workspaces: [ws()], topics: [topic()] }));
  h.respond.set('GET /api/daemon/update', json(200, maj()));
  h.respond.set(
    'POST /api/daemon/update',
    json(409, { error: '1 agent(s) tournent encore', agents: [{ id: 'ag_1', kind: 'shell' }] }),
  );
  await screen.findByText('feat/s');
  await userEvent.click(node('1-1.maj.lancer')!);
  await waitFor(() => expect(node('1-1.maj.confirmer')).not.toBeNull());
  expect(text('1-1.maj.confirmer')).toContain('1 agent tourne');
  h.respond.set('POST /api/daemon/update', json(202, { updating: true, agents: 1 }));
  await userEvent.click(node('1-1.maj.confirmer')!);
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url === '/api/daemon/update' &&
          (c.body as { force?: boolean } | undefined)?.force === true,
      ),
    ).toBe(true),
  );
});

test('bandeau de mise à jour (13.2) : en mode release, le titre nomme la version publiée et l’aide la version installée', async () => {
  const h = setup(<Accueil />, snapshot({ workspaces: [ws()], topics: [topic()] }));
  h.respond.set(
    'GET /api/daemon/update',
    json(200, maj({ mode: 'release', version: '0.2.0', latest: '0.3.0' })),
  );
  await screen.findByText('feat/s');
  expect(await screen.findByText('AID Server 0.3.0 disponible')).toBeTruthy();
  expect(text('1-1.maj.aide')).toBe('Version installée : 0.2.0.');
});
