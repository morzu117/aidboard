// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { PanneauContexte } from '../../web/src/ecrans/PanneauContexte.js';
import { agent, json, setup, snapshot, topic } from './helpers.js';

afterEach(cleanup);

const GIT_LOG_VIDE = json(200, {
  commits: [],
  dirty: false,
  live: { aheadBehind: { ahead: 0, behind: 0 }, rebaseInProgress: false, onTopicBranch: true },
});

const panneau = (over: Partial<Parameters<typeof PanneauContexte>[0]> = {}) => (
  <PanneauContexte
    namespace="aid"
    topicSlug="s"
    topicId="tp_1"
    base="main"
    remote={null}
    activeAgentId={null}
    {...over}
  />
);

const pageMemoire = (slug: string, body: string) => ({
  slug,
  namespace: 'aid',
  title: slug,
  frontmatter: {},
  body,
  revision: 1,
  author: 'x',
  createdAt: 't',
  updatedAt: 't',
});

test('onglets fixes toujours présents ; l’onglet Sujet (ex-Plan) vide affiche « Plan pas encore écrit »', async () => {
  setup(panneau(), snapshot());
  expect(await screen.findByRole('tab', { name: 'Sujet' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Git' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Fichiers' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Revue' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Rétro' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Passation' })).toBeNull();
  expect(await screen.findByText('Plan pas encore écrit')).toBeTruthy();
  expect(screen.queryByText(/Demander un plan à l’agent/)).toBeNull();
});

test('Revue apparaît seulement quand sa page mémoire existe, et affiche son contenu', async () => {
  setup(panneau(), snapshot(), '/', {
    'GET /api/memory/pages?prefix=aid%2F': json(200, { slugs: ['aid/review/s'] }),
    'GET /api/memory/pages/aid/review/s': json(
      200,
      pageMemoire('aid/review/s', 'Corps de la revue.'),
    ),
  });
  const onglet = await screen.findByRole('tab', { name: 'Revue' });
  await userEvent.click(onglet);
  expect(await screen.findByText('Corps de la revue.')).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Rétro' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Passation' })).toBeNull();
});

test('sélection initiale via prop (reprend ?onglet=git) : Git affiché sans clic', async () => {
  setup(panneau({ initialOnglet: 'git' }), snapshot(), '/', {
    'GET /api/topics/tp_1/git/log': GIT_LOG_VIDE,
  });
  const git = await screen.findByRole('tab', { name: 'Git' });
  expect(git.getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('Aucun commit depuis la base.')).toBeTruthy();
});

test('flèches gauche/droite : déplacent le focus et la sélection entre onglets', async () => {
  setup(panneau(), snapshot(), '/', { 'GET /api/topics/tp_1/git/log': GIT_LOG_VIDE });
  const plan = await screen.findByRole('tab', { name: 'Sujet' });
  plan.focus();
  await userEvent.keyboard('{ArrowRight}');
  const git = screen.getByRole('tab', { name: 'Git' });
  expect(document.activeElement).toBe(git);
  expect(git.getAttribute('aria-selected')).toBe('true');
  await userEvent.keyboard('{ArrowLeft}');
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Sujet' }));
});

// review D, finding 6 : l'aside et sa tablist ne doivent pas partager le même libellé — sinon
// deux régions nommées « Panneau du sujet » sont indiscernables à la navigation par repères.
test('libellés distincts pour l’aside et la tablist', async () => {
  setup(panneau(), snapshot());
  expect(await screen.findByRole('complementary', { name: 'Panneau du sujet' })).toBeTruthy();
  expect(screen.getByRole('tablist', { name: 'Onglets du panneau' })).toBeTruthy();
});

// review D, finding 3 : un seul tabpanel existe dans le DOM (celui de l'onglet actif) —
// aria-controls des autres onglets ne doit pas pointer vers un id absent.
test('aria-controls seulement sur l’onglet sélectionné', async () => {
  setup(panneau(), snapshot());
  const plan = await screen.findByRole('tab', { name: 'Sujet' });
  const git = screen.getByRole('tab', { name: 'Git' });
  const fichiers = screen.getByRole('tab', { name: 'Fichiers' });
  expect(plan.getAttribute('aria-controls')).toBe('panneau-tabpanel-plan');
  expect(git.hasAttribute('aria-controls')).toBe(false);
  expect(fichiers.hasAttribute('aria-controls')).toBe(false);
});

// review D, finding 4 : au changement de sujet, les onglets mémoire de l'ancien sujet
// disparaissent sans attendre la requête du nouveau, et une réponse tardive de l'ancien est ignorée.
function Commutateur() {
  const [second, setSecond] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setSecond(true)}>
        basculer
      </button>
      {panneau({ topicSlug: second ? 's2' : 's1' })}
    </>
  );
}

test('changement de sujet : les onglets mémoire de l’ancien disparaissent immédiatement', async () => {
  const h = setup(<Commutateur />, snapshot(), '/', {
    'GET /api/memory/pages?prefix=aid%2F': json(200, { slugs: ['aid/review/s1'] }),
    'GET /api/memory/pages/aid/review/s1': json(
      200,
      pageMemoire('aid/review/s1', 'Corps de la revue.'),
    ),
  });
  // le premier sujet a fini de charger : Revue est affiché.
  await screen.findByRole('tab', { name: 'Revue' });
  // la requête du second sujet reste en vol : la disparition de Revue ne doit pas l'attendre.
  let resoudreDeux!: (r: Response) => void;
  h.respond.set(
    'GET /api/memory/pages?prefix=aid%2F',
    () => new Promise<Response>((resolve) => (resoudreDeux = resolve)) as unknown as Response,
  );
  await userEvent.click(screen.getByText('basculer'));
  expect(screen.queryByRole('tab', { name: 'Revue' })).toBeNull();
  resoudreDeux(new Response(JSON.stringify({ slugs: [] }), { status: 200 }));
  await new Promise((r) => setTimeout(r, 10));
  expect(screen.queryByRole('tab', { name: 'Revue' })).toBeNull();
});

test('réponse tardive de l’ancien sujet ignorée après un changement de sujet', async () => {
  let lent = false;
  let resoudreUn: ((r: Response) => void) | null = null;
  const h = setup(<Commutateur />, snapshot(), '/', {
    'GET /api/memory/pages?prefix=aid%2F': () => {
      if (lent) {
        return new Promise<Response>((resolve) => (resoudreUn = resolve)) as unknown as Response;
      }
      return new Response(JSON.stringify({ slugs: [] }), { status: 200 });
    },
  });
  await screen.findByRole('tab', { name: 'Sujet' });
  expect(screen.queryByRole('tab', { name: 'Revue' })).toBeNull();
  // force une nouvelle requête pour le premier sujet, cette fois lente, encore en vol au
  // moment du changement de sujet plus bas.
  lent = true;
  await h.client.refresh();
  await waitFor(() => expect(resoudreUn).not.toBeNull());
  lent = false;
  await userEvent.click(screen.getByText('basculer'));
  // la réponse tardive du premier sujet (avec Revue) arrive après le changement : ignorée.
  resoudreUn!(new Response(JSON.stringify({ slugs: ['aid/review/s1'] }), { status: 200 }));
  await new Promise((r) => setTimeout(r, 10));
  expect(screen.queryByRole('tab', { name: 'Revue' })).toBeNull();
});

// review D, finding 5 : la page mémoire sélectionnée disparaît au rafraîchissement — repli sur
// Plan, et le focus doit suivre (sinon il reste sur un bouton qui vient de quitter le DOM).
test('repli sur Plan quand l’onglet mémoire sélectionné disparaît, et y rend le focus', async () => {
  const h = setup(panneau(), snapshot(), '/', {
    'GET /api/memory/pages?prefix=aid%2F': json(200, { slugs: ['aid/review/s'] }),
    'GET /api/memory/pages/aid/review/s': json(
      200,
      pageMemoire('aid/review/s', 'Corps de la revue.'),
    ),
  });
  const revue = await screen.findByRole('tab', { name: 'Revue' });
  await userEvent.click(revue);
  expect(await screen.findByText('Corps de la revue.')).toBeTruthy();
  h.respond.set('GET /api/memory/pages?prefix=aid%2F', json(200, { slugs: [] }));
  await h.client.refresh();
  await waitFor(() => expect(screen.queryByRole('tab', { name: 'Revue' })).toBeNull());
  // le repli et le focus suivent la disparition de l'onglet sur un rendu ultérieur :
  // les attendre, pas les lire juste après (échec intermittent sous Node 24, PR #123)
  await waitFor(() => {
    const plan = screen.getByRole('tab', { name: 'Sujet' });
    expect(plan.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(plan);
  });
});

// review D, finding 1 (re-dev 2) : un repli déclenché par un changement de sujet (onglet
// Revue du sujet A absent pour le sujet B) ne doit pas voler le focus à un champ extérieur.
// Le bascule se fait via fireEvent sur un <div> : userEvent.click reproduit le comportement
// des navigateurs qui renvoie le focus au document quand la cible n'est pas focusable — ce
// qui rendrait le test muet sur le comportement de l'effet de repli à tester ici.
function CommutateurSansFocus() {
  const [second, setSecond] = useState(false);
  return (
    <>
      <div data-testid="basculer-sans-focus" onClick={() => setSecond(true)} />
      {panneau({ topicSlug: second ? 's2' : 's1' })}
    </>
  );
}

test('changement de sujet : le repli sur Plan ne vole pas le focus resté à l’extérieur du panneau', async () => {
  const h = setup(<CommutateurSansFocus />, snapshot(), '/', {
    'GET /api/memory/pages?prefix=aid%2F': json(200, { slugs: ['aid/review/s1'] }),
    'GET /api/memory/pages/aid/review/s1': json(
      200,
      pageMemoire('aid/review/s1', 'Corps de la revue.'),
    ),
  });
  const revue = await screen.findByRole('tab', { name: 'Revue' });
  await userEvent.click(revue);
  await screen.findByText('Corps de la revue.');
  const champExterieur = document.createElement('input');
  document.body.appendChild(champExterieur);
  champExterieur.focus();
  expect(document.activeElement).toBe(champExterieur);
  h.respond.set('GET /api/memory/pages?prefix=aid%2F', json(200, { slugs: [] }));
  fireEvent.click(screen.getByTestId('basculer-sans-focus'));
  await waitFor(() => expect(screen.queryByRole('tab', { name: 'Revue' })).toBeNull());
  const plan = screen.getByRole('tab', { name: 'Sujet' });
  expect(plan.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(champExterieur);
  champExterieur.remove();
});

const run = {
  id: 'run_1',
  topicId: 'tp_1',
  mode: 'standard' as const,
  state: 'open',
  createdAt: 't',
};
const question = (id: string, q: string) =>
  agent({
    id,
    kind: 'claude',
    transport: 'stream',
    status: 'needs_input',
    pending: { id: `pr_${id}`, kind: 'question', question: q, options: [] },
  });

test('D119 : l’onglet Sujet montre d’abord la prochaine décision ; « Voir la question » choisit son agent', async () => {
  const vus: string[] = [];
  setup(
    panneau({ onVoirAgent: (id) => vus.push(id) }),
    snapshot({
      runs: [run, { ...run, id: 'run_2', topicId: 'tp_autre' }],
      agents: [
        agent({ id: 'ag_1', kind: 'claude', transport: 'stream', status: 'working' }),
        question('ag_2', 'Inclure la migration ?'),
        { ...question('ag_3', 'Question d’un autre sujet'), runId: 'run_2' },
      ],
    }),
  );
  await waitFor(() =>
    expect(document.querySelector('[data-node="1-3.panneau.decision.question"]')?.textContent).toBe(
      'Inclure la migration ?',
    ),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Voir la question' }));
  expect(vus).toEqual(['ag_2']);
  // le plan suit, tel qu'avant
  expect(await screen.findByText('Plan pas encore écrit')).toBeTruthy();
});

test('D119 : sans question en attente, l’onglet Sujet le dit', async () => {
  setup(panneau(), snapshot({ runs: [run], agents: [] }));
  await waitFor(() =>
    expect(document.querySelector('[data-node="1-3.panneau.decision.aucune"]')?.textContent).toBe(
      'Aucune décision en attente',
    ),
  );
  expect(screen.queryByRole('button', { name: 'Voir la question' })).toBeNull();
});

test('chantier 27 (D133) : onglet Livraison après Fichiers ; il relit la PR, résume et ouvre la vue', async () => {
  const TETE = '3f2a91c0000000000000000000000000000000aa';
  const h = setup(
    panneau(),
    snapshot({
      topics: [topic({ prNumber: 7, state: 'review' })],
      actions: [
        {
          id: 'ac_pr',
          topicId: 'tp_1',
          workspaceId: 'ws_1',
          action: 'pr.rafraichir',
          state: 'succeeded',
          exitCode: 0,
          result: {
            state: 'OPEN',
            headRefOid: TETE,
            baseRefName: 'main',
            statusCheckRollup: [
              { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
              { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
            ],
            reviews: [],
          },
          startedAt: 't',
          finishedAt: 't',
        },
      ],
    }),
    '/',
    {
      'POST /api/topics/tp_1/actions/pr.rafraichir': json(202, { actionId: 'ac_pr' }),
      'GET /api/topics/tp_1/git/livraison': json(200, {
        head: TETE,
        base: 'main',
        mergeBase: null,
        files: [],
        additions: 0,
        deletions: 0,
        empreinte: null,
      }),
    },
  );
  const onglets = await screen.findAllByRole('tab');
  expect(onglets.map((o) => o.textContent)).toEqual([
    'Sujet',
    'Git',
    'Fichiers',
    'Artefacts',
    'Livraison',
  ]);
  expect(h.calls.some((c) => c.url.includes('pr.rafraichir'))).toBe(false);
  await userEvent.click(screen.getByRole('tab', { name: 'Livraison' }));
  await waitFor(() => expect(h.calls.some((c) => c.url.includes('pr.rafraichir'))).toBe(true));
  const resume = (id: string) =>
    document.querySelector(`[data-node="1-3.panneau.livraison.${id}"]`)?.textContent;
  await waitFor(() => expect(resume('controles')).toBe('1 sur 2 · 1 en panne'));
  expect(resume('autorisation')).toBe('Aucune · elle ciblera 3f2a91c');
  expect(
    document.querySelector('[data-node="1-3.panneau.livraison.ouvrir"]')?.getAttribute('href'),
  ).toBe('/sujets/tp_1/livraison');
});
