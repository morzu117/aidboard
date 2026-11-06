// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
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

function Ici() {
  const l = useLocation();
  return <p data-node="ici">{`${l.pathname}${l.search}`}</p>;
}

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
  snap: Partial<ReturnType<typeof snapshot>> = {},
) {
  return setup(
    <Routes>
      <Route path="/sujets/:topicId/livraison" element={<Livraison />} />
      <Route path="/sujets/:topicId" element={<Ici />} />
    </Routes>,
    snapshot({ workspaces: [ws()], topics: [t], ...snap }),
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

// 27.6 : contrôles et revue (Q2, Q7, D126, D130, D131).

const pages = (slugs: string[]) => ({
  [`GET /api/memory/pages?prefix=${encodeURIComponent('aid/')}`]: json(200, { slugs }),
});
const pageRevue = (body: string, frontmatter: Record<string, unknown> = {}) => ({
  ...pages(['aid/review/s']),
  'GET /api/memory/pages/aid/review/s': json(200, {
    slug: 'aid/review/s',
    namespace: 'aid',
    title: 'Revue',
    frontmatter,
    body,
    revision: 1,
    author: 'codex',
    createdAt: 't',
    updatedAt: 't',
  }),
});
const avecRevue = (commit: string, revue: Partial<NonNullable<LivraisonGit['revue']>>) => ({
  [`GET /api/topics/tp_1/git/livraison?revue=${commit}`]: json(
    200,
    gitLu({ revue: { commit, connu: true, ancetre: true, retard: 0, ...revue } }),
  ),
});

test('Q7, D130 : tuile et liste des contrôles ; un test local sur une autre tête est grisé et ne compte pas', async () => {
  const h = ouvrir(avecPr, {
    'POST /api/topics/tp_1/actions/topic.test': json(202, { actionId: 'ac_t2' }),
  });
  await arrive(h, [
    lecture({
      statusCheckRollup: [
        {
          name: 'ci',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          startedAt: '2026-11-06T10:00:00Z',
          completedAt: '2026-11-06T10:00:42Z',
          detailsUrl: 'https://ci/1',
        },
        { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    }),
    {
      ...lecture({}),
      id: 'ac_t1',
      action: 'topic.test',
      result: { head: LOCALE },
      startedAt: '2026-11-06T09:00:00.000Z',
      finishedAt: '2026-11-06T09:02:05.000Z',
    },
  ]);
  await waitFor(() =>
    expect(node('livraison.tuile-controles.valeur')?.textContent).toBe('1 passé · 1 panne'),
  );
  expect(node('livraison.tuile-controles')?.dataset.ton).toBe('rouge');
  expect(node('livraison.tuile-controles.note')?.textContent).toBe('Exécutés sur 3f2a91c');
  expect(node('livraison.controles.compte')?.textContent).toBe(' · 1 sur 2');
  expect(node('livraison.controles.controle-0')?.textContent).toBe('✓ passéci3f2a91c · 42 s');
  expect(node('livraison.controles.controle-0')?.querySelector('a')?.getAttribute('href')).toBe(
    'https://ci/1',
  );
  expect(node('livraison.controles.controle-1')?.dataset.etat).toBe('panne');
  const local = node('livraison.controles.controle-2')!;
  expect(local.className).toContain('livraison-controle--ailleurs');
  expect(local.textContent).toBe('✓ passénpm test (local)sur 9e8d7c6 · 2 min 5 s');
  fireEvent.click(node('livraison.controles.relancer')!);
  await waitFor(() => expect(h.calls.some((c) => c.url.endsWith('/topic.test'))).toBe(true));
  expect(node('livraison.controles.relancer')?.textContent).toBe('Test en cours…');
});

test('Q7 : sans contrôle connu, la tuile le dit', async () => {
  ouvrir(topic());
  await waitFor(() =>
    expect(node('livraison.tuile-controles.valeur')?.textContent).toBe('Aucun contrôle'),
  );
  expect(node('livraison.controles.vide')).not.toBeNull();
});

test('D126, D131 : la page review en retard sur la tête rend la revue obsolète, avec son avis', async () => {
  const h = ouvrir(topic(), {
    ...pageRevue(
      'On peut livrer : le changement est petit.\n\nExaminé : les 2 fichiers du diff.\nNon examiné : la recette.',
      { commit: BASE },
    ),
    ...avecRevue(BASE, { retard: 2 }),
  });
  await waitFor(() => expect(node('livraison.tuile-revue.valeur')?.textContent).toBe('Obsolète'));
  // jamais « absent de la branche » pendant la lecture de la position du commit
  expect(node('livraison.tuile-revue.note')?.textContent).toBe(
    'Porte sur 1111111 · 2 commits de retard',
  );
  expect(node('livraison.tuile-revue')?.dataset.ton).toBe('ambre');
  expect(node('livraison.avis.obsolete')?.textContent).toBe(
    'Revue obsolète. L’avis porte sur 1111111, la tête est maintenant 3f2a91c.',
  );
  expect(node('livraison.avis.texte')?.textContent).toBe(
    'On peut livrer : le changement est petit.',
  );
  expect(node('livraison.avis.examine')?.textContent).toBe('Examiné : les 2 fichiers du diff.');
  expect(node('livraison.avis.non-examine')?.textContent).toBe('Non examiné : la recette.');
  expect(node('livraison.avis.onglet')?.getAttribute('href')).toBe('/sujets/tp_1?onglet=review');
  // le dépôt n'est lu qu'une fois la page connue : une seule lecture, avec le commit de la revue
  expect(h.calls.filter((c) => c.url.includes('/git/livraison')).map((c) => c.url)).toEqual([
    `/api/topics/tp_1/git/livraison?revue=${BASE}`,
  ]);
});

test('D126 : pendant la lecture, la tuile Revue ne conclut rien', async () => {
  let rendre: (r: Response) => void = () => {};
  ouvrir(topic(), {
    ...pageRevue('Avis.', { commit: BASE }),
    [`GET /api/topics/tp_1/git/livraison?revue=${BASE}`]: () =>
      new Promise<Response>((r) => (rendre = r)) as unknown as Response,
  });
  // la page est lue : seule la position de son commit manque
  await attendre('livraison.avis.texte');
  expect(node('livraison.tuile-revue.valeur')?.textContent).toBe('Lecture…');
  expect(node('livraison.avis.obsolete')).toBeNull();
  await act(async () =>
    rendre(json(200, gitLu({ revue: { commit: BASE, connu: true, ancetre: true, retard: 3 } }))()),
  );
  await waitFor(() => expect(node('livraison.tuile-revue.valeur')?.textContent).toBe('Obsolète'));
});
test('D126 : à jour, sans tête connue, absente de la branche', async () => {
  ouvrir(topic(), { ...pageRevue('Rien à redire.', { commit: TETE }), ...avecRevue(TETE, {}) });
  await waitFor(() => expect(node('livraison.tuile-revue.valeur')?.textContent).toBe('À jour'));
  expect(node('livraison.tuile-revue')?.dataset.ton).toBe('ok');
  expect(node('livraison.avis.obsolete')).toBeNull();
  cleanup();
  ouvrir(topic(), pageRevue('Rien à redire.'));
  await waitFor(() =>
    expect(node('livraison.tuile-revue.valeur')?.textContent).toBe('Revue sans tête connue'),
  );
  expect(node('livraison.tuile-revue')?.dataset.ton).toBe('neutre');
  cleanup();
  ouvrir(topic(), {
    ...pageRevue('Rien à redire.', { commit: 'abcdef1' }),
    ...avecRevue('abcdef1', { commit: null, connu: false, ancetre: false }),
  });
  await waitFor(() =>
    expect(node('livraison.tuile-revue.note')?.textContent).toBe(
      'Porte sur abcdef1, absent de la branche',
    ),
  );
});

test('D126 : sans page, la dernière revue GitHub ; sans l’une ni l’autre, aucune revue', async () => {
  ouvrir(topic());
  await waitFor(() =>
    expect(node('livraison.tuile-revue.valeur')?.textContent).toBe('Aucune revue'),
  );
  expect(node('livraison.avis.aucune')).not.toBeNull();
  expect(node('livraison.avis.onglet')).toBeNull();
  cleanup();
  const h = ouvrir(avecPr, avecRevue(BASE, { retard: 1 }));
  await arrive(h, [
    lecture({
      reviews: [{ author: { login: 'alice' }, commit: { oid: BASE }, state: 'APPROVED' }],
    }),
  ]);
  await waitFor(() =>
    expect(node('livraison.tuile-revue.note')?.textContent).toBe(
      'Porte sur 1111111 · 1 commit de retard',
    ),
  );
  expect(node('livraison.avis.github')?.textContent).toBe(
    'Revue GitHub de alice, sans page de revue dans la mémoire.',
  );
});

// 27.7 : autoriser le merge (D123, D127, D128).

const prete = { ...gitLu({ head: TETE }) };

test('D127 : la raison du blocage, une seule, sous le bouton désactivé', async () => {
  ouvrir(topic(), {}, prete);
  await waitFor(() =>
    expect(node('livraison.autoriser.blocage')?.textContent).toBe('Bloqué : aucune PR ouverte.'),
  );
  expect((node('livraison.autoriser') as HTMLButtonElement).disabled).toBe(true);
  expect(node('livraison.autoriser')?.textContent).toBe('Autoriser le merge de 3f2a91c');
  cleanup();

  let h = ouvrir(avecPr, {}, gitLu({ head: LOCALE }));
  // pendant la lecture de la PR : désactivé, sans raison annoncée
  await waitFor(() => expect(h.calls.some((c) => c.url.includes('pr.rafraichir'))).toBe(true));
  expect((node('livraison.autoriser') as HTMLButtonElement).disabled).toBe(true);
  expect(node('livraison.autoriser.blocage')).toBeNull();
  await arrive(h, [lecture({ headRefOid: TETE })]);
  await waitFor(() =>
    expect(node('livraison.autoriser.blocage')?.textContent).toBe(
      'Bloqué : la tête locale 9e8d7c6 n’est pas sur la PR.',
    ),
  );
  cleanup();

  h = ouvrir(avecPr, {
    ...pageRevue('Avis.', { commit: BASE }),
    ...avecRevue(BASE, { retard: 1 }),
  });
  await arrive(h, [lecture({})]);
  await waitFor(() =>
    expect(node('livraison.autoriser.blocage')?.textContent).toBe(
      'Bloqué : la revue ne porte pas sur cette tête.',
    ),
  );
  cleanup();

  h = ouvrir(avecPr, {}, prete);
  await arrive(h, [lecture({ mergeable: 'CONFLICTING' })]);
  await waitFor(() =>
    expect(node('livraison.autoriser.blocage')?.textContent).toBe(
      'Bloqué : GitHub signale un conflit avec la base.',
    ),
  );
});

test('D128 : la confirmation nomme la tête, cite ce qui ne bloque pas, et le merge part avec la tête', async () => {
  const h = ouvrir(
    avecPr,
    { 'POST /api/topics/tp_1/actions/topic.merge': json(202, { actionId: 'ac_m' }) },
    prete,
  );
  await arrive(h, [
    lecture({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] }),
  ]);
  const bouton = (await attendre('livraison.autoriser')) as HTMLButtonElement;
  await waitFor(() => expect(bouton.disabled).toBe(false));
  expect(node('livraison.autoriser.blocage')).toBeNull();
  expect(node('livraison.tuile-autorisation.valeur')?.textContent).toBe('Aucune');
  expect(node('livraison.tuile-autorisation.note')?.textContent).toBe('Elle ciblera 3f2a91c');
  fireEvent.click(bouton);
  expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(
    'Fusionner 3f2a91c dans main ?',
  );
  expect(node('livraison.confirmer-merge.citations')?.querySelectorAll('li')).toHaveLength(2);
  expect(node('livraison.confirmer-merge.citations')?.textContent).toContain('Aucune revue');
  expect(node('livraison.confirmer-merge.citations')?.textContent).toContain('1 contrôle en panne');
  const radios = node('livraison.confirmer-merge.strategie')!.querySelectorAll('input');
  expect([...radios].map((r) => [r.value, r.checked])).toEqual([
    ['merge', true],
    ['squash', false],
    ['rebase', false],
  ]);
  expect((node('livraison.confirmer-merge.supprimer-branche') as HTMLInputElement).checked).toBe(
    false,
  );
  expect((node('livraison.confirmer-merge.nettoyer') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(radios[1]!);
  fireEvent.click(node('livraison.confirmer-merge.supprimer-branche')!);
  fireEvent.click(node('livraison.confirmer-merge.valider')!);
  await waitFor(() =>
    expect(h.calls.find((c) => c.url.endsWith('/topic.merge'))?.body).toEqual({
      strategy: 'squash',
      deleteBranch: true,
      cleanupAfter: false,
      head: TETE,
    }),
  );
  expect(node('livraison.confirmer-merge.valider')?.textContent).toBe('Fusion…');
  // fusionné : le dialogue se ferme, la tuile le dit
  await arrive(
    h,
    [
      lecture({ state: 'MERGED' }),
      { ...lecture({}), id: 'ac_m', action: 'topic.merge', result: null },
    ],
    [{ ...avecPr, state: 'merged' }],
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(node('livraison.tuile-autorisation.valeur')?.textContent).toBe('Fusionnée');
  expect(node('livraison.tuile-autorisation.note')?.textContent).toBe('Sur 3f2a91c');
  expect(node('livraison.autoriser')).toBeNull();
});

test('D128 : un refus de GitHub s’affiche tel quel, le dialogue se ferme et la PR est relue', async () => {
  const h = ouvrir(
    avecPr,
    { 'POST /api/topics/tp_1/actions/topic.merge': json(202, { actionId: 'ac_m' }) },
    prete,
  );
  await arrive(h, [lecture({})]);
  const bouton = (await attendre('livraison.autoriser')) as HTMLButtonElement;
  await waitFor(() => expect(bouton.disabled).toBe(false));
  fireEvent.click(bouton);
  fireEvent.click(node('livraison.confirmer-merge.valider')!);
  await waitFor(() => expect(h.calls.some((c) => c.url.endsWith('/topic.merge'))).toBe(true));
  const refus = 'Head branch was modified. Review and try the merge again.';
  await act(async () => {
    FakeSocket.all[0]!.push({
      kind: 'ephemeral',
      type: 'action.output',
      actionId: 'ac_m',
      stream: 'stderr',
      line: refus,
    });
  });
  await arrive(h, [
    lecture({}),
    {
      ...lecture({}),
      id: 'ac_m',
      action: 'topic.merge',
      state: 'failed',
      exitCode: 1,
      result: null,
    },
  ]);
  await waitFor(() => expect(node('livraison.autoriser.refus')?.textContent).toBe(refus));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url.includes('pr.rafraichir'))).toHaveLength(2),
  );
  // une nouvelle tentative rouvre le dialogue
  await waitFor(() => expect(bouton.disabled).toBe(false));
  fireEvent.click(bouton);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

// 27.8 : relancer la revue (D129).

test('D129 : un agent codex relit la tête, reçoit le message fixe, et le sujet s’ouvre sur lui', async () => {
  const h = ouvrir(topic(), {
    ...pageRevue('Avis.', { commit: BASE }),
    ...avecRevue(BASE, { retard: 1 }),
    'POST /api/agents': json(201, { id: 'ag_r', kind: 'codex', transport: 'stream' }),
    'POST /api/agents/ag_r/input': json(202, { id: 'ag_r' }),
  });
  const bouton = (await attendre('livraison.relancer-revue.bouton')) as HTMLButtonElement;
  await waitFor(() => expect(bouton.disabled).toBe(false));
  expect(bouton.textContent).toBe('Relancer la revue sur 3f2a91c');
  // revue obsolète : c'est l'action proposée
  await waitFor(() => expect(bouton.className).toContain('bouton--primaire'));
  expect((node('livraison.relancer-revue.agent') as HTMLSelectElement).value).toBe('codex');
  fireEvent.click(bouton);
  await waitFor(() => expect(node('ici')?.textContent).toBe('/sujets/tp_1?agent=ag_r'));
  expect(h.calls.find((c) => c.url === '/api/agents')?.body).toEqual({
    topicId: 'tp_1',
    kind: 'codex',
  });
  const texte = (h.calls.find((c) => c.url === '/api/agents/ag_r/input')?.body as { text: string })
    .text;
  expect(texte).toContain(`git diff ${BASE}...${TETE}`);
  expect(texte).toContain(`aid/review/s, avec dans son frontmatter « commit: ${TETE} »`);
  const ordre = h.calls.map((c) => c.url).filter((u) => u.startsWith('/api/agents'));
  expect(ordre).toEqual(['/api/agents', '/api/agents/ag_r/input']);
});

test('D129 : claude au choix ; un refus s’affiche et rien ne bouge', async () => {
  const h = ouvrir(topic(), {
    'POST /api/agents': json(409, { error: 'worktree occupé' }),
  });
  const bouton = (await attendre('livraison.relancer-revue.bouton')) as HTMLButtonElement;
  await waitFor(() => expect(bouton.disabled).toBe(false));
  expect(bouton.className).not.toContain('bouton--primaire');
  fireEvent.change(node('livraison.relancer-revue.agent')!, { target: { value: 'claude' } });
  fireEvent.click(bouton);
  expect((await attendre('livraison.relancer-revue.erreur')).textContent).toBe('worktree occupé');
  expect(h.calls.find((c) => c.url === '/api/agents')?.body).toEqual({
    topicId: 'tp_1',
    kind: 'claude',
  });
  expect(h.calls.some((c) => c.url.endsWith('/input'))).toBe(false);
  expect(node('ici')).toBeNull();
});

test('D129 : en transport PTY, ou sans origin/<base>, le bouton est désactivé avec la raison', async () => {
  ouvrir(topic(), {}, gitLu(), { agentTransport: 'pty' });
  const raison = await attendre('livraison.relancer-revue.raison');
  expect(raison.textContent).toContain('agents.transport: pty');
  expect((node('livraison.relancer-revue.bouton') as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  ouvrir(topic(), {}, gitLu({ mergeBase: null, empreinte: null, files: [] }));
  await waitFor(() =>
    expect(node('livraison.relancer-revue.raison')?.textContent).toBe(
      'Rien à relire tant que origin/main et la tête ne sont pas connus.',
    ),
  );
  cleanup();
  ouvrir({ ...avecPr, state: 'merged' });
  await attendre('livraison.avis');
  expect(node('livraison.relancer-revue')).toBeNull();
});
