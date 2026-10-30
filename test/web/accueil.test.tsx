// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { NavPlacement, NavState, Topic } from '../../src/shared/model.js';
import type { StateSnapshot } from '../../src/shared/state.js';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { compteVue, topicsForVue } from '../../web/src/ui/navVues.js';
import { resetNavCacheForTests } from '../../web/src/ui/Nav.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

// La ligne (point 8) navigue elle-même quand le clic n'est pas sur un lien/bouton ; le lien du nom
// navigue aussi, par son propre mécanisme (<Link>). Les deux passent par `useNavigate` : un espion
// dessus distingue « une seule navigation » de la double navigation corrigée (finding 5).
const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateSpy };
});

afterEach(() => {
  cleanup();
  resetNavCacheForTests();
  navigateSpy.mockClear();
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
  // finding 2 : le titre ne prétend plus « Rien n'attend ta réponse » avant que l'état n'arrive.
  expect(text('1-1.entete.titre')).toBe('Accueil');
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
  expect(text('1-1.table.ligne-1.nom')).toBe('feat/s');
  expect(text('1-1.table.ligne-1.projet')).toBe('aid');
  expect(text('1-1.table.ligne-1.agent')).toBe('shell · au travail');
  expect(text('1-1.table.ligne-2.agent')).toBe('Aucun agent');
  expect(node('1-1.table.ligne-1.sujet')?.querySelector('a')?.getAttribute('href')).toBe(
    '/sujets/tp_1',
  );
  // finding 4 : le point de statut porte son propre data-node, avec le libellé accessible.
  expect(node('1-1.table.ligne-1.statut')?.getAttribute('aria-label')).toBe('shell');
});

test('nom affiché : reprend le renommage du placement, pas la branche, comme Nav', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), {
    ...navDefaut([topic()]),
    placements: [placement({ displayName: 'Mon nom' })],
  });
  await attendreTable();
  expect(text('1-1.table.ligne-1.nom')).toBe('Mon nom');
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
  await waitFor(() => expect(text('1-1.table.ligne-1.nom')).toBe('fix/x'));
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
  expect(text('1-1.table.ligne-1.nom')).toBe('feat/s');
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
  expect(text('1-1.table.ligne-1.nom')).toBe('feat/<b>gras</b>');
  expect(document.querySelector('b')).toBeNull();
});

test('error : daemon injoignable, bandeau avec cause, et « Réessayer » relit l’état', async () => {
  const h = setup(<Accueil />, 'down');
  const band = await screen.findByRole('alert', {}, { timeout: 3000 });
  expect(within(band).getByText('Impossible de lire l’état des sujets')).toBeTruthy();
  expect(text('1-1.erreur.bandeau.cause')).toContain('injoignable');
  expect(document.querySelector('.resume')?.textContent).toContain('État indisponible');
  // finding 2 : le titre lui-même dit « État indisponible », jamais « Rien n'attend ta réponse ».
  expect(text('1-1.entete.titre')).toBe('État indisponible');
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

// finding 1 : avant la réponse de /api/nav (ou pour un sujet jamais placé), `placementByTopic` ne
// connaît pas le sujet — un sujet sans placement doit compter comme un placement par défaut
// (visible, ni archivé ni épinglé), pas disparaître de « Tous » (navVues.ts, définition partagée
// avec Nav).
test('vue : un sujet sans placement compte comme visible, comme un placement par défaut', () => {
  const t = topic();
  expect(topicsForVue('tous', [t], new Map(), () => [])).toEqual([t]);
  expect(compteVue('tous', [t], new Map(), () => [], [])).toBe(1);
  expect(topicsForVue('archives', [t], new Map(), () => [])).toEqual([]);
});

test('clic de ligne : le lien du nom ne déclenche pas aussi la navigation du <tr> (finding 5)', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }));
  await attendreTable();
  // le lien navigue par son propre mécanisme (hors du `useNavigate` espionné ici) : le <tr> ne doit
  // pas en plus appeler le sien — sinon la double navigation du bug.
  await userEvent.click(node('1-1.table.ligne-1.nom')!);
  expect(navigateSpy).not.toHaveBeenCalled();
  // ailleurs dans la ligne (hors lien/bouton), le <tr> navigue toujours lui-même.
  await userEvent.click(node('1-1.table.ligne-1.projet')!);
  expect(navigateSpy).toHaveBeenCalledTimes(1);
  expect(navigateSpy.mock.calls[0]?.[0]).toBe('/sujets/tp_1');
});

test('action de ligne : « Trancher » vise le même agent que la colonne Agent (mostUrgent), pas le premier agent en attente (finding 6)', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic()],
      runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' }],
      agents: [
        agent({
          id: 'ag_shell',
          status: 'needs_input',
          pending: { id: 'pr_0', kind: 'question', question: 'Ignoré ?', options: [] },
        }),
        agent({
          id: 'ag_claude',
          kind: 'claude',
          status: 'needs_input',
          pending: { id: 'pr_1', kind: 'question', question: 'Continuer ?', options: [] },
        }),
      ],
    }),
  );
  await attendreTable();
  expect(node('1-1.table.ligne-1.action.bouton')?.getAttribute('href')).toBe(
    '/sujets/tp_1?agent=ag_claude',
  );
});

test('vue archivés : « Désarchiver » appelle le PATCH de Nav et retire le sujet de la vue (finding 7)', async () => {
  const h = open(
    snapshot({ workspaces: [ws()], topics: [topic()] }),
    { ...navDefaut([topic()]), placements: [placement({ archived: true })] },
    '/?vue=archives',
  );
  await attendreTable();
  expect(node('1-1.table.ligne-1.action.bouton')?.textContent).toBe('Désarchiver');
  await userEvent.click(node('1-1.table.ligne-1.action.bouton')!);
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) =>
          c.method === 'PATCH' &&
          c.url === '/api/nav/placements/tp_1' &&
          (c.body as { archived?: boolean })?.archived === false,
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(node('1-1.table.ligne-1')).toBeNull());
});

test('shells en arrière-plan : le sujet qui n’affiche plus rien porte l’icône, pas le sujet sans agent', async () => {
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
  expect(node('1-1.table.ligne-1.shells')?.getAttribute('aria-label')).toBe(
    '1 shell en arrière-plan',
  );
  expect(node('1-1.table.ligne-2.shells')).toBeNull();
});
