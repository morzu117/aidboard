// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import type { NavPlacement, NavState, Topic } from '../../src/shared/model.js';
import type { StateSnapshot } from '../../src/shared/state.js';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { resetNavCacheForTests } from '../../web/src/ui/Nav.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

afterEach(() => {
  cleanup();
  resetNavCacheForTests();
});
const node = (id: string) => document.querySelector(`[data-node="${id}"]`);
const text = (id: string) => node(id)?.textContent;
// La table n'est pas seule à montrer le nom d'un sujet : la barre gauche (Nav) le fait aussi dès
// qu'un placement existe — toujours attendre/lire par data-node de la table, jamais par texte brut.
const attendreTable = () => waitFor(() => expect(node('1-1.table.ligne-1')).not.toBeNull());
// 13.2 : la forme de GET /api/daemon/update (UpdateInfo), mode repo par défaut
const maj = (over: Record<string, unknown> = {}) => ({
  mode: 'repo',
  version: '0.1.0',
  available: true,
  latest: '1234567deadbeef',
  lastError: null,
  ...over,
});

const placement = (over: Partial<NavPlacement> = {}): NavPlacement => ({
  topicId: 'tp_1',
  groupId: 'ng_1',
  ord: 0,
  pinned: false,
  archived: false,
  hidden: false,
  displayName: null,
  ...over,
});

// Une « vue » place chaque sujet dans un groupe par défaut : la plupart des tests n'ont rien à
// dire sur les groupes, seulement sur ce qui doit apparaître dans la table (D56, point 5).
const navDefaut = (topics: Topic[]): NavState => ({
  groups: [
    {
      id: 'ng_1',
      name: 'aid',
      color: '#5de0a1',
      ord: 0,
      collapsed: false,
      hidden: false,
      workspaceId: null,
    },
  ],
  placements: topics.map((t, i) => placement({ topicId: t.id, ord: i })),
  prefs: { reduit: false },
});

const open = (
  snap: StateSnapshot,
  nav?: NavState,
  route = '/',
  extra: Record<string, (body: unknown) => Response> = {},
) =>
  setup(<Accueil />, snap, route, {
    'GET /api/nav': json(200, nav ?? navDefaut(snap.topics)),
    ...extra,
  });

test('loading : des squelettes tant que l’instantané n’est pas arrivé', () => {
  setup(<Accueil />, snapshot());
  expect(node('1-1.grille.squelette-1')).not.toBeNull();
  expect(node('1-1.grille.squelette-6')).not.toBeNull();
});

test('empty : aucun sujet, le bouton ouvre d’abord « Nouveau projet » quand aucun dépôt n’est enregistré', async () => {
  open(snapshot());
  expect(await screen.findByText(/Aucun projet/)).toBeTruthy();
  await userEvent.click(node('1-1.vide.creer')!);
  expect(await screen.findByRole('dialog', { name: 'Nouveau projet' })).toBeTruthy();
});

test('empty avec un dépôt : « Nouveau sujet » ouvre la création de sujet', async () => {
  open(snapshot({ workspaces: [ws()] }));
  // Nav pose aussi un bouton « Nouveau sujet » (B.2, finding 7) : findByRole serait ambigu, viser
  // l'id du CTA de l'écran vide directement.
  await waitFor(() => expect(node('1-1.vide.creer')).not.toBeNull());
  await userEvent.click(node('1-1.vide.creer')!);
  expect(await screen.findByRole('dialog', { name: 'Nouveau sujet' })).toBeTruthy();
});

test('default : une ligne par sujet, avec nom affiché, projet, agent et lien', async () => {
  open(
    snapshot({
      workspaces: [ws(), ws({ id: 'ws_2', name: 'project_1' })],
      topics: [
        topic(),
        topic({ id: 'tp_2', workspaceId: 'ws_2', branch: 'fix/x', title: 'Autre', slug: 'x' }),
      ],
      runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' }],
      agents: [agent({ status: 'working' })],
    }),
  );
  await attendreTable();
  expect(text('1-1.table.titre')).toBe('Tous les sujets · 2');
  expect(text('1-1.table.ligne-1.sujet.nom')).toBe('feat/s');
  expect(text('1-1.table.ligne-1.projet')).toBe('aid');
  expect(text('1-1.table.ligne-1.agent')).toBe('shell · au travail');
  expect(text('1-1.table.ligne-2.agent')).toBe('Aucun agent');
  expect(node('1-1.table.ligne-1.sujet')?.querySelector('a')?.getAttribute('href')).toBe(
    '/sujets/tp_1',
  );
});

test('nom affiché : reprend le renommage du placement, pas la branche, comme Nav', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), {
    ...navDefaut([topic()]),
    placements: [placement({ displayName: 'Mon nom' })],
  });
  await attendreTable();
  expect(text('1-1.table.ligne-1.sujet.nom')).toBe('Mon nom');
});

test('agent : « au travail », « libre », « arrêté » selon le statut, jamais codé par la seule couleur', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [
        topic({ id: 'tp_1' }),
        topic({ id: 'tp_2', branch: 'feat/t', slug: 't' }),
        topic({ id: 'tp_3', branch: 'feat/u', slug: 'u' }),
      ],
      runs: [
        { id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' },
        { id: 'run_2', topicId: 'tp_2', mode: 'standard', state: 'open', createdAt: 't' },
        { id: 'run_3', topicId: 'tp_3', mode: 'standard', state: 'open', createdAt: 't' },
      ],
      agents: [
        agent({ id: 'ag_1', runId: 'run_1', status: 'idle' }),
        agent({ id: 'ag_2', runId: 'run_2', status: 'done' }),
        agent({ id: 'ag_3', runId: 'run_3', status: 'working' }),
      ],
    }),
  );
  await attendreTable();
  expect(text('1-1.table.ligne-1.agent')).toContain('libre');
  expect(text('1-1.table.ligne-2.agent')).toContain('arrêté');
  expect(text('1-1.table.ligne-3.agent')).toContain('au travail');
});

test('décision en attente : la carte de décision est reprise, répondre appelle /answer', async () => {
  const h = open(
    snapshot({
      workspaces: [ws()],
      topics: [topic()],
      runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' }],
      agents: [
        agent({
          status: 'needs_input',
          pending: {
            id: 'pr_1',
            kind: 'question',
            question: 'Continuer ?',
            options: [{ label: 'Oui', answer: 'yes' }],
          },
        }),
      ],
    }),
  );
  await screen.findByText('Continuer ?');
  expect(text('1-1.decisions.decision-1.contexte')).toContain('feat/s');
  await userEvent.click(screen.getByText('Oui'));
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url === '/api/agents/ag_1/answer' &&
          (c.body as { answer?: string })?.answer === 'yes',
      ),
    ).toBe(true),
  );
  await attendreTable();
  expect(node('1-1.table.ligne-1.action.bouton')?.textContent).toBe('Trancher');
});

test('décision en attente : au-delà de 3, un lien « voir les N autres » renvoie à la boîte', async () => {
  const topics = [1, 2, 3, 4].map((n) =>
    topic({ id: `tp_${n}`, branch: `feat/${n}`, slug: `s${n}` }),
  );
  open(
    snapshot({
      workspaces: [ws()],
      topics,
      runs: topics.map((t, i) => ({
        id: `run_${i + 1}`,
        topicId: t.id,
        mode: 'standard',
        state: 'open',
        createdAt: 't',
      })),
      agents: topics.map((_t, i) =>
        agent({
          id: `ag_${i + 1}`,
          runId: `run_${i + 1}`,
          status: 'needs_input',
          pending: {
            id: `pr_${i + 1}`,
            kind: 'question',
            question: `Décision ${i + 1}`,
            options: [],
          },
        }),
      ),
    }),
    navDefaut(topics),
  );
  await screen.findByText('Décision 1');
  expect(screen.queryByText('Décision 4')).toBeNull();
  const lien = await screen.findByText('voir les 1 autres →');
  expect(lien.getAttribute('href')).toBe('/boite');
});

test('ligne « Lancer » : aucun agent, lance un agent claude puis ouvre le sujet', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()] }));
  h.respond.set('POST /api/agents', json(200, { id: 'ag_nouveau', kind: 'claude' }));
  await attendreTable();
  expect(node('1-1.table.ligne-1.action.bouton')?.textContent).toBe('Lancer');
  await userEvent.click(node('1-1.table.ligne-1.action.bouton')!);
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url === '/api/agents' &&
          (c.body as { topicId?: string; kind?: string })?.topicId === 'tp_1' &&
          (c.body as { kind?: string })?.kind === 'claude',
      ),
    ).toBe(true),
  );
});

test('ligne « Reprendre » : un agent existe sans décision en attente', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic()],
      runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' }],
      agents: [agent({ status: 'working' })],
    }),
  );
  await attendreTable();
  expect(node('1-1.table.ligne-1.action.bouton')?.textContent).toBe('Reprendre');
});

test('le filtre texte, insensible aux accents, filtre sur le nom affiché, le projet et l’étape', async () => {
  open(
    snapshot({
      workspaces: [ws(), ws({ id: 'ws_2', name: 'Épicerie' })],
      topics: [topic(), topic({ id: 'tp_2', workspaceId: 'ws_2', branch: 'fix/x', slug: 'x' })],
    }),
  );
  await attendreTable();
  await userEvent.type(node('1-1.table.filtre') as HTMLElement, 'epicerie');
  await waitFor(() => expect(text('1-1.table.ligne-1.sujet.nom')).toBe('fix/x'));
  expect(node('1-1.table.ligne-2')).toBeNull();
});

test('vue ?vue=a-decider : ne montre que les sujets avec une décision en attente', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic(), topic({ id: 'tp_2', branch: 'feat/t', slug: 't' })],
      runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' }],
      agents: [
        agent({
          status: 'needs_input',
          pending: { id: 'pr_1', kind: 'question', question: 'Continuer ?', options: [] },
        }),
      ],
    }),
    undefined,
    '/?vue=a-decider',
  );
  await attendreTable();
  expect(text('1-1.table.ligne-1.sujet.nom')).toBe('feat/s');
  expect(node('1-1.table.ligne-2')).toBeNull();
});

test('worktree introuvable : toujours le cas d’erreur dédié, hors de la table', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic({ worktreeMissing: true })] }));
  h.respond.set('POST /api/topics/tp_1/actions/topic.cleanup', json(202, { actionId: 'ac_1' }));
  await screen.findByText(/Worktree introuvable/);
  expect(node('1-1.table.lignes')).toBeNull();
  await userEvent.click(node('1-1.erreur.sujet-1.archiver')!);
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) => c.method === 'POST' && c.url === '/api/topics/tp_1/actions/topic.cleanup',
      ),
    ).toBe(true),
  );
});

test('texte de sujet : jamais interprété comme du HTML', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ branch: 'feat/<b>gras</b>' })],
    }),
  );
  await attendreTable();
  expect(text('1-1.table.ligne-1.sujet.nom')).toBe('feat/<b>gras</b>');
  expect(document.querySelector('b')).toBeNull();
});

test('error : daemon injoignable, bandeau avec cause, et « Réessayer » relit l’état', async () => {
  const h = setup(<Accueil />, 'down');
  const band = await screen.findByRole('alert', {}, { timeout: 3000 });
  expect(within(band).getByText('Impossible de lire l’état des sujets')).toBeTruthy();
  expect(text('1-1.erreur.bandeau.cause')).toContain('injoignable');
  expect(document.querySelector('.resume')?.textContent).toContain('État indisponible');
  h.state = snapshot({ workspaces: [ws()], topics: [topic()] });
  h.respond.set('GET /api/nav', json(200, navDefaut([topic()])));
  await userEvent.click(node('1-1.erreur.bandeau.reessayer')!);
  await attendreTable();
});

test('bandeau de mise à jour : affiché si le daemon signale origin/main en avance, absent sinon', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()] }));
  h.respond.set('GET /api/daemon/update', json(200, maj()));
  await attendreTable();
  expect(await screen.findByText('Nouvelle version d’aidboard disponible')).toBeTruthy();
  expect(text('1-1.maj.aide')).toContain('1234567');
});

test('bandeau de mise à jour : rien si le daemon ne sait pas ou dit à jour', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }));
  await attendreTable();
  expect(node('1-1.maj')).toBeNull();
});
