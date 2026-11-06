// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { LivraisonGit } from '../../src/shared/git.js';
import type { ActionRun, NavState } from '../../src/shared/model.js';
import { Livraison } from '../../web/src/ecrans/Livraison.js';
import { resetNavCacheForTests } from '../../web/src/ui/Nav.js';
import { FakeSocket, type Harness, json, setup, snapshot, topic, ws } from './helpers.js';

// Chantier 27 : l'écran Livraison (D121 à D135).

beforeEach(resetNavCacheForTests);
afterEach(cleanup);

export const TETE = '3f2a91c0000000000000000000000000000000aa';
export const LOCALE = '9e8d7c60000000000000000000000000000000cc';
export const BASE = '1111111000000000000000000000000000000011';

const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const attendre = (id: string) =>
  waitFor(() => {
    const n = node(id);
    expect(n).not.toBeNull();
    return n!;
  });

export const gitLu = (over: Partial<LivraisonGit> = {}): LivraisonGit => ({
  head: TETE,
  base: 'main',
  mergeBase: BASE,
  files: [
    { path: 'examples/run.py', status: 'M', additions: 3, deletions: 5 },
    { path: 'nouveau.txt', status: 'A', additions: 2, deletions: 0 },
  ],
  additions: 5,
  deletions: 5,
  empreinte: '7c41e0a2',
  ...over,
});

const nav: NavState = {
  groups: [],
  placements: [],
  prefs: { reduit: false, rangement: 'etat' },
};

export const lecture = (result: Record<string, unknown>, over: Partial<ActionRun> = {}) => ({
  id: 'ac_pr',
  topicId: 'tp_1',
  workspaceId: 'ws_1',
  action: 'pr.rafraichir',
  state: 'succeeded' as const,
  exitCode: 0,
  result: {
    number: 7,
    url: 'https://github.com/test/test/pull/7',
    state: 'OPEN',
    headRefOid: TETE,
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [],
    reviews: [],
    ...result,
  },
  startedAt: '2026-11-06T10:00:00.000Z',
  finishedAt: '2026-11-06T10:00:02.000Z',
  ...over,
});

export const avecPr = topic({
  prNumber: 7,
  prUrl: 'https://github.com/test/test/pull/7',
  state: 'review',
});

export function ouvrir(
  t = topic(),
  routes: Record<string, (body: unknown) => Response> = {},
  git: LivraisonGit = gitLu(),
) {
  return setup(
    <Routes>
      <Route path="/sujets/:topicId/livraison" element={<Livraison />} />
      <Route path="/sujets/:topicId" element={<p>écran sujet</p>} />
    </Routes>,
    snapshot({ workspaces: [ws()], topics: [t] }),
    '/sujets/tp_1/livraison',
    {
      'GET /api/nav': json(200, nav),
      'GET /api/topics/tp_1/git/livraison': json(200, git),
      'POST /api/topics/tp_1/actions/pr.rafraichir': json(202, { actionId: 'ac_pr' }),
      ...routes,
    },
  );
}

/** L'action lue arrive dans l'état, puis un événement fait relire l'état. */
export async function arrive(h: Harness, actions: object[], topics = [avecPr]) {
  h.state = snapshot({
    workspaces: [ws()],
    topics,
    actions: actions as ActionRun[],
  });
  await waitFor(() => expect(FakeSocket.all[0]).toBeDefined());
  await act(async () => {
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.push({
      kind: 'event',
      event: { id: `E${Math.random()}`, type: 'cost', data: {} },
    });
    await new Promise((r) => setTimeout(r, 40));
  });
}

test('D121, D122 : sans PR, le titre porte la tête locale ; contexte, fichiers, PR à créer', async () => {
  const h = ouvrir(topic(), {}, gitLu({ head: LOCALE }));
  await waitFor(() =>
    expect(node('livraison.titre')?.textContent).toBe('Peut-on livrer 9e8d7c6 ?'),
  );
  expect(node('livraison.contexte')?.textContent).toBe(
    'feat/s → main · diff 7c41e0a2 · 2 fichiers · +5 −5',
  );
  expect(node('livraison.fichiers.fichier-0')?.textContent).toBe('modifiéexamples/run.py+3 −5');
  expect(node('livraison.fichiers.fichier-1')?.textContent).toContain('ajouté');
  expect(node('livraison.trace.pr')?.textContent).toBe('PR vers main○ à créer');
  expect(node('livraison.relire')).toBeNull();
  expect(h.calls.some((c) => c.url.includes('pr.rafraichir'))).toBe(false);
  expect(node('livraison.fil-ariane.sujet')?.getAttribute('href')).toBe('/sujets/tp_1');
  expect(node('livraison.fil-ariane')?.textContent).toBe('Mon sujet / livraison');
});

test('D18 : avec une PR, elle est relue à l’ouverture ; le titre passe sur sa tête', async () => {
  const h = ouvrir(avecPr, {}, gitLu({ head: TETE }));
  await waitFor(() => expect(h.calls.some((c) => c.url.includes('pr.rafraichir'))).toBe(true));
  expect(node('livraison.relire')?.textContent).toBe('Lecture de la PR…');
  await arrive(h, [lecture({ headRefOid: TETE })]);
  await waitFor(() => expect(node('livraison.relire')?.textContent).toBe('Relire la PR'));
  expect(node('livraison.titre')?.textContent).toBe('Peut-on livrer 3f2a91c ?');
  expect(node('livraison.tete-locale')).toBeNull();
  const lien = node('livraison.trace.pr')!.querySelector('a')!;
  expect(lien.textContent).toBe('● #7 ouverte');
  expect(lien.getAttribute('href')).toBe('https://github.com/test/test/pull/7');

  fireEvent.click(node('livraison.relire')!);
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url.includes('pr.rafraichir'))).toHaveLength(2),
  );
  expect(h.calls.filter((c) => c.url.endsWith('/git/livraison')).length).toBeGreaterThanOrEqual(2);
});

test('D122 : la tête locale hors de la PR se voit, et se pousse', async () => {
  const h = ouvrir(
    avecPr,
    {
      'POST /api/topics/tp_1/actions/git.pousser': json(202, { actionId: 'ac_push' }),
    },
    gitLu({ head: LOCALE }),
  );
  await arrive(h, [lecture({ headRefOid: TETE })]);
  const bandeau = await attendre('livraison.tete-locale');
  expect(node('livraison.tete-locale.constat')?.textContent).toBe(
    'La tête locale 9e8d7c6 n’est pas sur la PR',
  );
  expect(bandeau.textContent).toContain('La PR porte 3f2a91c.');
  expect(node('livraison.titre')?.textContent).toBe('Peut-on livrer 3f2a91c ?');
  fireEvent.click(node('livraison.tete-locale.action')!);
  await waitFor(() => expect(h.calls.some((c) => c.url.endsWith('/git.pousser'))).toBe(true));
  await arrive(h, [
    lecture({ headRefOid: TETE }),
    { ...lecture({}), id: 'ac_push', action: 'git.pousser', result: null },
  ]);
  // poussé : la PR et le dépôt sont relus
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url.includes('pr.rafraichir'))).toHaveLength(2),
  );
});

test('D125 : un fichier ouvre son diff base...tête dans l’éditeur', async () => {
  const h = ouvrir(topic(), {
    'POST /api/topics/tp_1/actions/diff.ouvrir-fichier': json(204, {}),
  });
  fireEvent.click(await attendre('livraison.fichiers.fichier-1'));
  await waitFor(() =>
    expect(h.calls.find((c) => c.url.endsWith('/diff.ouvrir-fichier'))?.body).toEqual({
      hash: TETE,
      depuis: BASE,
      path: 'nouveau.txt',
    }),
  );
});

test('D125 : sans changement, sans origin/<base>, erreur de lecture', async () => {
  ouvrir(topic(), {}, gitLu({ files: [], additions: 0, deletions: 0 }));
  expect((await attendre('livraison.fichiers.vide')).textContent).toBe(
    'Aucun changement par rapport à origin/main.',
  );
  cleanup();
  ouvrir(topic(), {}, gitLu({ mergeBase: null, empreinte: null, files: [] }));
  await attendre('livraison.fichiers.sans-base');
  expect(node('livraison.contexte')?.textContent).toBe('feat/s → main');
  cleanup();
  ouvrir(topic(), {
    'GET /api/topics/tp_1/git/livraison': json(409, { error: 'worktree introuvable' }),
  });
  expect((await attendre('livraison.lecture-git.detail')).textContent).toBe('worktree introuvable');
});

test('D132 : Ouvrir la PR, titre prérempli, topic.pr lancé, refus affiché', async () => {
  const h = ouvrir(topic(), {
    'POST /api/topics/tp_1/actions/topic.pr': json(202, { actionId: 'ac_tpr' }),
  });
  fireEvent.click(await attendre('livraison.trace.ouvrir-pr'));
  const titre = (await attendre('livraison.ouvrir-pr.titre')) as HTMLInputElement;
  expect(titre.value).toBe('Mon sujet');
  fireEvent.change(node('livraison.ouvrir-pr.description')!, { target: { value: 'Pourquoi' } });
  fireEvent.click(node('livraison.ouvrir-pr.valider')!);
  await waitFor(() =>
    expect(h.calls.find((c) => c.url.endsWith('/topic.pr'))?.body).toEqual({
      title: 'Mon sujet',
      body: 'Pourquoi',
    }),
  );
  await arrive(
    h,
    [{ ...lecture({}), id: 'ac_tpr', action: 'topic.pr', state: 'needs_human', result: null }],
    [topic()],
  );
  expect(screen.getByRole('alert').textContent).toBe('Action humaine requise.');
  // réussie : le dialogue se ferme, la PR ouverte est relue
  await arrive(h, [{ ...lecture({}), id: 'ac_tpr', action: 'topic.pr', result: null }], [avecPr]);
  await waitFor(() => expect(node('livraison.ouvrir-pr')).toBeNull());
  await waitFor(() => expect(h.calls.some((c) => c.url.includes('pr.rafraichir'))).toBe(true));
});

test('D121 : sujet inconnu, worktree absent, sujet fusionné', async () => {
  setup(
    <Routes>
      <Route path="/sujets/:topicId/livraison" element={<Livraison />} />
    </Routes>,
    snapshot({ workspaces: [ws()], topics: [] }),
    '/sujets/tp_x/livraison',
    { 'GET /api/nav': json(200, nav) },
  );
  await attendre('livraison.introuvable');
  cleanup();
  const h = ouvrir({ ...avecPr, worktreeMissing: true });
  await attendre('livraison.sans-worktree');
  expect(node('livraison.relire')).toBeNull();
  expect(node('livraison.trace.ouvrir-pr') as HTMLButtonElement | null).toBeNull();
  expect(
    h.calls.some((c) => c.url.includes('pr.rafraichir') || c.url.includes('git/livraison')),
  ).toBe(false);
  cleanup();
  ouvrir({ ...avecPr, state: 'merged' }, {}, gitLu({ head: LOCALE }));
  await waitFor(() =>
    expect(node('livraison.trace.pr')?.textContent).toBe('PR vers main● fusionnée'),
  );
  expect(node('livraison.tete-locale')).toBeNull();
});
