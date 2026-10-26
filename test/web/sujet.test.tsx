// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { ActionRun } from '../../src/shared/model.js';
import { Sujet } from '../../web/src/ecrans/Sujet.js';
import { agent, FakeSocket, json, setup, snapshot, topic, ws } from './helpers.js';

const action = (over: Partial<ActionRun>): ActionRun => ({
  id: 'ac_1',
  topicId: 'tp_1',
  workspaceId: 'ws_1',
  action: 'topic.create',
  state: 'running',
  exitCode: null,
  result: null,
  startedAt: 't',
  finishedAt: null,
  ...over,
});

vi.mock('../../web/src/terminal/Terminal.js', () => ({
  Terminal: ({ agentId, visible }: { agentId: string; visible: boolean }) => (
    <div data-testid={`term-${agentId}`} data-visible={String(visible)} />
  ),
}));

vi.mock('../../web/src/conversation/Conversation.js', () => ({
  Conversation: ({ agent: a, visible }: { agent: { id: string }; visible: boolean }) => (
    <div data-testid={`conv-${a.id}`} data-visible={String(visible)} />
  ),
}));

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const text = (id: string) => node(id)?.textContent;
const run = {
  id: 'run_1',
  topicId: 'tp_1',
  mode: 'standard' as const,
  state: 'open',
  createdAt: 't',
};
const page = (
  <Routes>
    <Route path="/sujets/:topicId" element={<Sujet />} />
  </Routes>
);
const open = (
  state: ReturnType<typeof snapshot> | 'down',
  id = 'tp_1',
  routes: Record<string, (body: unknown) => Response> = {},
) => setup(page, state, `/sujets/${id}`, routes);

function PageAvecChemin() {
  const loc = useLocation();
  return (
    <>
      <p data-testid="chemin">{loc.pathname}</p>
      <Routes>
        <Route path="/sujets/:topicId" element={<Sujet />} />
        <Route path="/" element={<p>Accueil</p>} />
      </Routes>
    </>
  );
}
const openAvecChemin = (state: ReturnType<typeof snapshot> | 'down', id = 'tp_1') =>
  setup(<PageAvecChemin />, state, `/sujets/${id}`);

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])('choix de lancement : mesh=%s, Swairm=%s, ordre conservé', async (mesh, swairm) => {
  const state = snapshot({
    workspaces: [ws()],
    topics: [topic()],
    runs: [run],
    ...(mesh && {
      mesh: {
        state: {
          connected: false,
          tailscale: 'absent' as const,
          monitor: 'absent' as const,
          pending: 0,
          since: null,
          cell: 'test-cell',
        },
        inbox: [],
        tailscaleManage: false,
      },
    }),
    ...(swairm && { swairm: { enabled: true as const } }),
  });
  const h = open(state);
  await screen.findByText('Aucun agent ne tourne sur ce sujet.');
  const labels = [
    'Lancer claude',
    'Lancer codex',
    'Ouvrir un shell',
    ...(mesh ? ['Ouvrir la cell swarph'] : []),
    ...(swairm ? ['Ouvrir la cell Swairm'] : []),
  ];
  const choices = () =>
    Array.from(document.querySelectorAll('[data-action="agent.lancer"]')).map(
      (button) => button.textContent,
    );
  expect(choices()).toEqual(labels);
  h.state = { ...state, agents: [agent()] };
  await act(() => h.client.refresh());
  await userEvent.click(await screen.findByText('+ Agent'));
  expect(choices()).toEqual(labels);
});

test('Swairm : POST exact et sélection du terminal créé après rafraîchissement', async () => {
  const state = snapshot({
    workspaces: [ws()],
    topics: [topic()],
    runs: [run],
    agents: [agent()],
    swairm: { enabled: true },
  });
  const created = agent({ id: 'ag_swairm', kind: 'swairm-cell', command: ['fake-swairm', 'cell'] });
  const h = open(state, 'tp_1', { 'POST /api/agents': json(201, created) });
  await userEvent.click(await screen.findByText('+ Agent'));
  await userEvent.click(screen.getByRole('button', { name: 'Ouvrir la cell Swairm' }));
  expect(h.calls.filter((c) => c.url === '/api/agents')).toEqual([
    { method: 'POST', url: '/api/agents', body: { topicId: 'tp_1', kind: 'swairm-cell' } },
  ]);
  // Le nouvel agent n'est pas le dernier : la sélection doit venir de la réponse POST.
  h.state = { ...state, agents: [created, agent()] };
  await act(() => h.client.refresh());
  expect(screen.getByTestId('term-ag_swairm').getAttribute('data-visible')).toBe('true');
  expect(screen.getByTestId('term-ag_1').getAttribute('data-visible')).toBe('false');
});

test.each([
  [409, 'Une cell Swairm est déjà ouverte : ag_existant'],
  [422, 'swairm introuvable dans le PATH du daemon'],
])('Swairm : erreur %s affichée sans terminal fantôme', async (status, error) => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic()],
      runs: [run],
      swairm: { enabled: true },
    }),
    'tp_1',
    { 'POST /api/agents': json(status, { error }) },
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Ouvrir la cell Swairm' }));
  expect((await screen.findByRole('alert')).textContent).toBe(error);
  expect(screen.queryByTestId(/^term-/)).toBeNull();
});

test('en-tête : fil d’Ariane, titre, état, branche, base, worktree', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  await screen.findByText('Mon sujet');
  expect(text('1-3.entete.workspace')).toBe('aid');
  expect(text('1-3.entete.titre')).toBe('Mon sujet');
  expect(text('1-3.entete.etat')).toBe('active');
  expect(text('1-3.entete.branche')).toBe('feat/s');
  expect(text('1-3.entete.base.branche')).toBe('origin/main');
  expect(text('1-3.entete.worktree')).toBe('/w/s');
});

test('en-tête d’un projet sans remote : la base est la branche locale, sans « origin/ »', async () => {
  open(snapshot({ workspaces: [ws({ remote: null })], topics: [topic()], runs: [run] }));
  await screen.findByText('Mon sujet');
  expect(text('1-3.entete.base.branche')).toBe('main');
});

test.each([
  ['disabled', 'index absent : lecture directe'],
  ['indexing', 'indexation en cours'],
  ['ready', 'index prêt'],
  ['failed', 'index en échec : lecture directe'],
] as const)(
  'index %s : « %s » (le repli est déclaré, jamais silencieux)',
  async (indexState, label) => {
    open(snapshot({ workspaces: [ws()], topics: [topic({ indexState })], runs: [run] }));
    await screen.findByText('Mon sujet');
    expect(text('1-3.entete.index')).toBe(label);
  },
);

test('la colonne de gauche liste les sujets par workspace et marque le sujet courant', async () => {
  open(
    snapshot({
      workspaces: [ws(), ws({ id: 'ws_2', name: 'project_1' })],
      topics: [topic(), topic({ id: 'tp_2', workspaceId: 'ws_2', branch: 'fix/y', slug: 'y' })],
    }),
  );
  await screen.findByText('Mon sujet');
  expect(text('1-3.sujets.groupe-1.nom')).toBe('aid');
  expect(text('1-3.sujets.groupe-2.nom')).toBe('project_1');
  expect(node('1-3.sujets.sujet-1')?.className).toContain('est-actif');
  expect(node('1-3.sujets.sujet-2')?.getAttribute('href')).toBe('/sujets/tp_2');
});

test('sans agent : trois façons de démarrer, et le lancement appelle POST /api/agents', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  h.respond.set('POST /api/agents', json(201, { ...agent({ id: 'ag_9', kind: 'claude' }) }));
  await screen.findByText('Aucun agent ne tourne sur ce sujet.');
  expect(screen.getByText(/dialogue de confiance/)).toBeTruthy();
  await userEvent.click(node('1-3.vide.lancer-claude')!);
  await waitFor(() =>
    expect(h.calls.find((c) => c.url === '/api/agents')?.body).toEqual({
      topicId: 'tp_1',
      kind: 'claude',
    }),
  );
  await userEvent.click(node('1-3.vide.shell')!);
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url === '/api/agents').at(-1)?.body).toEqual({
      topicId: 'tp_1',
      kind: 'shell',
    }),
  );
  expect(node('1-3.vide.lancer-cursor')).toBeNull();
});

test('un binaire absent : le message du daemon est affiché', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  h.respond.set(
    'POST /api/agents',
    json(422, { error: 'claude introuvable dans le PATH du daemon' }),
  );
  await userEvent.click(await screen.findByText('Lancer claude'));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'claude introuvable dans le PATH du daemon',
  );
});

test('onglets : un terminal monté par agent, un seul visible ; « Arrêter » sur un agent vivant, « Fermer » sur un agent terminé', async () => {
  const h = open(
    snapshot({
      workspaces: [ws()],
      topics: [topic()],
      runs: [run],
      agents: [
        agent({ id: 'ag_1', kind: 'claude', role: 'free' }),
        agent({ id: 'ag_2', kind: 'shell', status: 'done' }),
      ],
    }),
  );
  h.respond.set('DELETE /api/agents/ag_1', json(202, { id: 'ag_1' }));
  h.respond.set('DELETE /api/agents/ag_2', json(200, { id: 'ag_2' }));
  await screen.findByTestId('term-ag_1');
  expect(screen.getByTestId('term-ag_2').getAttribute('data-visible')).toBe('true');
  expect(screen.getByTestId('term-ag_1').getAttribute('data-visible')).toBe('false');
  expect(text('1-3.terminaux.onglet-1.type')).toBe('claude');
  // « free » n'est pas du français : l'agent lancé à la main est « libre »
  expect(text('1-3.terminaux.onglet-1.role')).toBe('libre');
  expect(node('1-3.terminaux.onglet-1.arreter')?.textContent).toBe('Arrêter');
  expect(node('1-3.terminaux.onglet-2.arreter')?.textContent).toBe('Fermer');
  await userEvent.click(node('1-3.terminaux.onglet-1')!);
  expect(screen.getByTestId('term-ag_1').getAttribute('data-visible')).toBe('true');
  expect(screen.getByTestId('term-ag_2').getAttribute('data-visible')).toBe('false');
  await userEvent.click(node('1-3.terminaux.onglet-1.arreter')!);
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'DELETE' && c.url === '/api/agents/ag_1')).toBe(true),
  );
  await userEvent.click(node('1-3.terminaux.onglet-2.arreter')!);
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'DELETE' && c.url === '/api/agents/ag_2')).toBe(true),
  );
});

test('onglets de contenu (11.1) : Agents par défaut, Git et Fichiers affichent un espace réservé, le terminal reste monté (masqué) en changeant d’onglet', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic()],
      runs: [run],
      agents: [agent({ id: 'ag_1', kind: 'claude', role: 'free' })],
    }),
    'tp_1',
    {
      'GET /api/topics/tp_1/git/log': json(200, {
        commits: [],
        dirty: false,
        live: {
          aheadBehind: { ahead: 0, behind: 0 },
          rebaseInProgress: false,
          onTopicBranch: true,
        },
      }),
      'GET /api/topics/tp_1/files?scope=tout': json(200, {
        tree: [],
        total: 0,
        modified: 0,
        truncated: false,
      }),
    },
  );
  await screen.findByTestId('term-ag_1');
  // D28 : pas de dérive déclarée (onTopicBranch) ⇒ pas de bandeau, même hors de l'onglet Git.
  expect(screen.queryByText(/pas sur la branche du sujet/)).toBeNull();
  expect(node('1-3.onglets.agents')?.className).toContain('est-actif');
  await userEvent.click(node('1-3.onglets.git')!);
  expect(await screen.findByText('Aucun commit depuis la base.')).toBeTruthy();
  expect(node('1-3.onglets.git')?.className).toContain('est-actif');
  // le terminal reste dans le DOM (masqué), pas démonté : pas de reconnexion à la bascule.
  expect(screen.getByTestId('term-ag_1')).toBeTruthy();
  await userEvent.click(node('1-3.onglets.fichiers')!);
  await waitFor(() => expect(text('3-4.explorateur.compteur')).toContain('0 fichier'));
  await userEvent.click(node('1-3.onglets.agents')!);
  expect(screen.getByTestId('term-ag_1')).toBeTruthy();
});

test('dérive (D28, écran 3.6) : branche différente du sujet — bandeau, Revenir et Rattacher', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }), 'tp_1', {
    'GET /api/topics/tp_1/git/log': json(200, {
      commits: [],
      dirty: false,
      live: {
        aheadBehind: null,
        rebaseInProgress: false,
        onTopicBranch: false,
        headBranch: 'autre',
      },
    }),
    'POST /api/topics/tp_1/actions/branche.revenir': json(202, { actionId: 'ac_1' }),
    'POST /api/topics/tp_1/actions/sujet.rattacher-branche': json(200, { branch: 'autre' }),
  });
  expect(await screen.findByText(/pas sur la branche du sujet/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Revenir sur feat/s' }));
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) => c.method === 'POST' && c.url === '/api/topics/tp_1/actions/branche.revenir',
      ),
    ).toBe(true),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Rattacher le sujet à autre' }));
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) => c.method === 'POST' && c.url === '/api/topics/tp_1/actions/sujet.rattacher-branche',
      ),
    ).toBe(true),
  );
});

test('dérive : HEAD détachée — bandeau sans bouton Rattacher', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }), 'tp_1', {
    'GET /api/topics/tp_1/git/log': json(200, {
      commits: [],
      dirty: false,
      live: { aheadBehind: null, rebaseInProgress: false, onTopicBranch: false, headBranch: null },
    }),
  });
  expect(await screen.findByText(/HEAD détachée/)).toBeTruthy();
  expect(screen.queryByText(/Rattacher le sujet/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Revenir sur feat/s' })).toBeTruthy();
});

test('« + Agent » propose les trois types et lance celui choisi', async () => {
  const h = open(
    snapshot({ workspaces: [ws()], topics: [topic()], runs: [run], agents: [agent()] }),
  );
  h.respond.set('POST /api/agents', json(201, agent({ id: 'ag_7', kind: 'codex' })));
  await userEvent.click(await screen.findByText('+ Agent'));
  await userEvent.click(screen.getByText('Lancer codex'));
  await waitFor(() =>
    expect(h.calls.find((c) => c.url === '/api/agents')?.body).toEqual({
      topicId: 'tp_1',
      kind: 'codex',
    }),
  );
});

test('ouvrir dans l’éditeur : appelle l’action, et un éditeur introuvable est expliqué', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  h.respond.set(
    'POST /api/topics/tp_1/actions/editor.open',
    json(422, {
      error: 'impossible de lancer l’éditeur (code). Régler « editor » dans ~/.aid/config.yaml.',
    }),
  );
  await userEvent.click(await screen.findByText('Ouvrir dans l’éditeur'));
  expect((await screen.findByRole('alert')).textContent).toContain('config.yaml');
});

test('nettoyer : le menu appelle topic.cleanup, un refus pour travail non commité est affiché sans option de forcer', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  h.respond.set(
    'POST /api/topics/tp_1/actions/topic.cleanup',
    json(409, { error: 'des agents tournent encore : les arrêter avant de nettoyer' }),
  );
  await userEvent.click(await screen.findByLabelText('Plus d’actions'));
  await userEvent.click(screen.getByText('Nettoyer le sujet'));
  expect((await screen.findByRole('alert')).textContent).toContain('des agents tournent encore');
  expect(screen.queryByText('Supprimer quand même')).toBeNull();
});

test('la pastille de branche ouvre le sélecteur (11.6), qui lit /git/branches', async () => {
  const h = open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  h.respond.set(
    'GET /api/topics/tp_1/git/branches',
    json(200, {
      branches: [
        {
          name: 'feat/s',
          hash: 'h',
          date: 't',
          ahead: 0,
          behind: 0,
          worktree: null,
          isCurrent: true,
          topicId: null,
        },
      ],
    }),
  );
  await screen.findByText('Mon sujet');
  await userEvent.click(node('1-3.entete.branche')!);
  expect(await screen.findByRole('dialog', { name: 'Changer de branche' })).toBeTruthy();
  await waitFor(() =>
    expect(h.calls.some((c) => c.url === '/api/topics/tp_1/git/branches')).toBe(true),
  );
});

test('worktree introuvable : bandeau, aucun terminal, éditeur désactivé', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ worktreeMissing: true })],
      runs: [run],
      agents: [agent()],
    }),
  );
  expect(await screen.findByText('Worktree introuvable')).toBeTruthy();
  expect(screen.queryByTestId('term-ag_1')).toBeNull();
  expect((screen.getByText('Ouvrir dans l’éditeur') as HTMLButtonElement).disabled).toBe(true);
});

test('sujet inconnu ou archivé', async () => {
  open(snapshot({ workspaces: [ws()], topics: [topic()] }), 'tp_nope');
  expect(await screen.findByText('Sujet introuvable ou archivé.')).toBeTruthy();
});

test('brouillon (écran 2.2) : progression en direct, pas de bandeau « worktree introuvable », pas de nettoyage', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ state: 'draft', worktreeMissing: true })],
      runs: [run],
      actions: [action({})],
    }),
  );
  expect(await screen.findByText('Préparation du worktree…')).toBeTruthy();
  expect(text('1-3.preparation.bandeau.cause')).toBe('feat/s depuis origin/main');
  expect(screen.queryByText('Worktree introuvable')).toBeNull();
  expect(screen.queryByLabelText('Plus d’actions')).toBeNull();
});

test('brouillon : la sortie de topic.create en direct est affichée', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ state: 'draft', worktreeMissing: true })],
      runs: [run],
      actions: [action({})],
    }),
  );
  await screen.findByText('Préparation du worktree…');
  await act(async () => {
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.push({
      kind: 'ephemeral',
      type: 'action.output',
      actionId: 'ac_1',
      stream: 'stdout',
      line: 'git fetch --quiet origin main',
    });
  });
  expect(await screen.findByText('git fetch --quiet origin main')).toBeTruthy();
});

test('brouillon : « Ignorer » appelle topic.setup-ignorer et revient à l’accueil', async () => {
  const h = openAvecChemin(
    snapshot({
      workspaces: [ws()],
      topics: [topic({ state: 'draft', worktreeMissing: true })],
      runs: [run],
      actions: [action({})],
    }),
  );
  h.respond.set('POST /api/topics/tp_1/actions/topic.setup-ignorer', json(204, {}));
  await userEvent.click(await screen.findByText('Ignorer'));
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) => c.method === 'POST' && c.url === '/api/topics/tp_1/actions/topic.setup-ignorer',
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(screen.getByTestId('chemin').textContent).toBe('/'));
});

test('brouillon abandonné par le script : le sujet disparu affiche la cause plutôt qu’un 404 générique', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [],
      actions: [action({ state: 'needs_human', exitCode: 2 })],
    }),
  );
  expect(await screen.findByText('La préparation du sujet a échoué')).toBeTruthy();
  expect(screen.queryByText('Sujet introuvable ou archivé.')).toBeNull();
});

test('sujet archivé : chronologie lue à part, bouton « Retirer la mention du stash »', async () => {
  // L'effet de useArchive part dès le premier rendu (present=false tant que l'état n'est
  // pas chargé) : la route doit être connue avant open(), pas ajoutée après coup.
  const h = open(snapshot({ workspaces: [ws()], topics: [] }), 'tp_1', {
    'GET /api/topics/tp_1/events': json(200, {
      topic: {
        id: 'tp_1',
        workspaceId: 'ws_1',
        slug: 's',
        title: 'Sujet clos',
        branch: 'feat/s',
        base: 'main',
        worktree: '/w/s',
        state: 'archived',
        stashRef: 'd'.repeat(40),
        createdAt: 't',
        updatedAt: 't',
      },
      events: [
        {
          seq: 1,
          v: 1,
          id: 'e1',
          ts: '2026-10-15T10:00:00.000Z',
          source: 'daemon',
          type: 'topic.state',
          data: { state: 'archived' },
        },
      ],
    }),
  });
  await screen.findByText('Sujet clos');
  expect(text('1-3.archive.etat')).toBe('archived');
  expect(screen.getByText(/Sujet passé en/)).toBeTruthy();
  h.respond.set('POST /api/topics/tp_1/actions/archive.oublier-stash', json(200, { found: true }));
  await userEvent.click(screen.getByText('Retirer la mention du stash'));
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) => c.method === 'POST' && c.url === '/api/topics/tp_1/actions/archive.oublier-stash',
      ),
    ).toBe(true),
  );
  await screen.findByText('Stash supprimé.');
});

test('loading : squelettes ; error : bandeau avec « Réessayer » ; liste de gauche indisponible', async () => {
  open(snapshot());
  expect(node('1-3.terminaux')?.className).toContain('squelette');
  expect(node('1-3.sujets.squelette-1')).not.toBeNull();
  cleanup();
  const h = open('down');
  expect((await screen.findByRole('alert', {}, { timeout: 3000 })).textContent).toContain(
    'injoignable',
  );
  expect(text('1-3.sujets.indisponible')).toBe('Liste indisponible');
  h.state = snapshot({ workspaces: [ws()], topics: [topic()] });
  await userEvent.click(node('1-3.erreur.bandeau.reessayer')!);
  await screen.findByText('Mon sujet');
});

test('un titre ou une branche piégés ne sont jamais du HTML', async () => {
  open(
    snapshot({ workspaces: [ws()], topics: [topic({ title: '<img src=x onerror=alert(1)>' })] }),
  );
  await screen.findByText('<img src=x onerror=alert(1)>');
  expect(document.querySelector('img')).toBeNull();
});

test('« Ouvrir la cell swarph » n’apparaît qu’avec un mesh configuré, et lance kind swarph-cell', async () => {
  const sans = open(snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }));
  await screen.findByText('Aucun agent ne tourne sur ce sujet.');
  expect(screen.queryByText('Ouvrir la cell swarph')).toBeNull();
  cleanup();
  await sans.client.stop();
  const h = open({
    ...snapshot({ workspaces: [ws()], topics: [topic()], runs: [run] }),
    mesh: {
      state: {
        connected: true,
        tailscale: 'running',
        monitor: 'running',
        pending: 0,
        since: 't',
        cell: 'morzu-mac',
      },
      inbox: [],
      tailscaleManage: false,
    },
  });
  h.respond.set('POST /api/agents', json(201, { ...agent({ id: 'ag_c', kind: 'swarph-cell' }) }));
  await userEvent.click(await screen.findByText('Ouvrir la cell swarph'));
  await waitFor(() =>
    expect(h.calls.find((c) => c.url === '/api/agents')?.body).toEqual({
      topicId: 'tp_1',
      kind: 'swarph-cell',
    }),
  );
});

test('transport (D53) : un agent stream affiche <Conversation>, un agent pty affiche <Terminal>', async () => {
  open(
    snapshot({
      workspaces: [ws()],
      topics: [topic()],
      runs: [run],
      agents: [
        agent({ id: 'ag_1', kind: 'claude', transport: 'pty' }),
        agent({ id: 'ag_2', kind: 'claude', transport: 'stream' }),
      ],
    }),
  );
  await screen.findByTestId('term-ag_1');
  expect(screen.getByTestId('conv-ag_2')).toBeTruthy();
  expect(screen.queryByTestId('term-ag_2')).toBeNull();
  expect(screen.queryByTestId('conv-ag_1')).toBeNull();
});
