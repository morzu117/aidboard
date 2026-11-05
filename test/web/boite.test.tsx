// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { Agent, MeshDm, MeshState } from '../../src/shared/model.js';
import { Boite } from '../../web/src/ecrans/Boite.js';
import { Sujet } from '../../web/src/ecrans/Sujet.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

vi.mock('../../web/src/terminal/Terminal.js', () => ({
  Terminal: ({ agentId, visible }: { agentId: string; visible: boolean }) => (
    <div data-testid={`term-${agentId}`} data-visible={String(visible)} />
  ),
}));

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const text = (id: string) => node(id)?.textContent;
const el = (n: number, rest = '') => `1-2.liste.element-${n}${rest ? `.${rest}` : ''}`;
const run = (id: string, topicId: string) => ({
  id,
  topicId,
  mode: 'standard' as const,
  state: 'open',
  createdAt: 't',
});
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const claude = (over: Partial<Agent>) =>
  agent({ kind: 'claude', role: 'dev', status: 'working', statusSource: 'hook', ...over });

const etat = () =>
  snapshot({
    workspaces: [ws(), ws({ id: 'ws_2', name: 'project_1' })],
    topics: [topic(), topic({ id: 'tp_2', workspaceId: 'ws_2', branch: 'feat/csv', slug: 'csv' })],
    runs: [run('run_1', 'tp_1'), run('run_2', 'tp_2')],
    agents: [
      claude({
        id: 'ag_perm',
        status: 'needs_input',
        statusAt: at(2),
        pending: {
          id: 'p1',
          kind: 'permission',
          question: 'Autoriser Bash(npm test) ?',
          options: [
            { label: 'Autoriser une fois', answer: 'yes' },
            { label: 'Refuser', answer: 'no' },
          ],
        },
      }),
      claude({
        id: 'ag_q',
        runId: 'run_2',
        status: 'needs_input',
        statusAt: at(5),
        pending: { id: 'p2', kind: 'question', question: 'Quel séparateur ?', options: [] },
      }),
      claude({ id: 'ag_err', status: 'error', exitCode: 3, statusAt: at(21) }),
      claude({ id: 'ag_tour', status: 'idle', statusMessage: 'Tests verts.', statusAt: at(12) }),
      claude({
        id: 'ag_est',
        kind: 'codex',
        status: 'idle',
        statusSource: 'heuristic',
        statusDetail: { silenceMs: 240_000 },
        statusAt: at(4),
      }),
      claude({
        id: 'ag_run',
        runId: 'run_2',
        lastTool: 'Bash(npm run typecheck)',
        statusAt: at(0),
      }),
      claude({ id: 'ag_pause', pausedAt: at(18) }),
      agent({ id: 'ag_shell', status: 'working' }),
      claude({ id: 'ag_fini', status: 'done' }),
    ],
  });

test('groupes par urgence, comptes, et un élément par agent qui a quelque chose à dire', async () => {
  setup(<Boite />, etat());
  await screen.findByText('Autoriser Bash(npm test) ?');
  expect(text('1-2.entete.resume')).toBe('7 éléments sur 2 sujets · triés par urgence');
  expect(
    [...document.querySelectorAll('.groupe')].map((g) => g.getAttribute('aria-label')),
  ).toEqual(['Attend une réponse', 'Erreur', 'À relire', 'En cours', 'En pause']);
  expect(text('1-2.liste.groupe-attente.compte')).toBe('2');
  expect(text('1-2.liste.groupe-relire.compte')).toBe('2');
  // ni le shell, ni l'agent terminé
  expect(document.querySelectorAll('article')).toHaveLength(7);
  expect(document.body.textContent).not.toContain('shell');
  // l'attente la plus ancienne d'abord, le tour terminé le plus récent d'abord
  expect([1, 2, 3, 4, 5, 6, 7].map((n) => text(el(n, 'type')))).toEqual([
    'Question',
    'Permission',
    'Erreur',
    'Inactif · estimé',
    'Tour terminé',
    'En cours',
    'En pause',
  ]);
  expect(text(el(1, 'question'))).toBe('Quel séparateur ?');
  expect(text(el(1, 'workspace'))).toBe('project_1');
  expect(text(el(1, 'branche'))).toBe('feat/csv');
  expect(text(el(3, 'detail'))).toBe('Sortie en erreur (code 3)');
  expect(text(el(4, 'detail'))).toBe('Terminal silencieux depuis 4 min');
  expect(node(el(4, 'type'))?.className).toContain('badge--estime');
  expect(text(el(5, 'detail'))).toBe('Tests verts.');
  expect(text(el(6, 'detail'))).toBe('Bash(npm run typecheck)');
  expect(text(el(7, 'moment'))).toBe('il y a 18 min');
});

test('actions : répondre, ouvrir le terminal de l’agent, reprendre', async () => {
  const h = setup(<Boite />, etat());
  await screen.findByText('Autoriser Bash(npm test) ?');
  // une question sans options : seulement le terminal
  expect(node(el(1, 'option-1'))).toBeNull();
  expect(node(el(1, 'ouvrir'))?.getAttribute('href')).toBe('/sujets/tp_2?agent=ag_q');
  expect(node(el(2, 'option-1'))?.className).toBe('bouton bouton--primaire');
  await userEvent.click(node(el(2, 'option-1'))!);
  expect(h.calls.find((c) => c.url === '/api/agents/ag_perm/answer')?.body).toEqual({
    pendingId: 'p1',
    answer: 'yes',
  });
  // « En cours » n'a pas d'action
  expect(node(el(6))?.querySelector('.element-actions')).toBeNull();
  await userEvent.click(node(el(7, 'reprendre'))!);
  expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/agents/ag_pause/resume')).toBe(
    true,
  );
});

test('une réponse refusée par le daemon s’affiche sous l’élément', async () => {
  const h = setup(<Boite />, etat());
  h.respond.set(
    'POST /api/agents/ag_perm/answer',
    json(409, { error: 'l’écran ne montre plus cette demande : ouvrir le terminal' }),
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Autoriser une fois' }));
  expect(text(el(2, 'erreur'))).toContain('ne montre plus');
});

test('filtre de projet ; vide : « Rien à traiter », sans phrase sur les issues', async () => {
  setup(<Boite />, etat());
  await screen.findByText('Autoriser Bash(npm test) ?');
  await userEvent.click(node('1-2.filtres.workspace-2')!);
  expect(text('1-2.entete.resume')).toBe('2 éléments sur 1 sujet · triés par urgence');
  cleanup();
  setup(<Boite />, snapshot({ workspaces: [ws()], topics: [topic()] }));
  expect((await screen.findByText(/Rien à traiter/)).textContent).toBe(
    'Rien à traiter : aucun agent n’attend ta réponse.',
  );
  expect(text('1-2.entete.resume')).toBe('0 élément');
  expect(document.body.textContent).not.toMatch(/issue/i);
  expect(node('1-2.vide.accueil')?.getAttribute('href')).toBe('/');
});

test('chargement : squelettes ; daemon injoignable : bandeau et Réessayer', async () => {
  setup(<Boite />, snapshot());
  expect(node('1-2.liste.squelette-1')).not.toBeNull();
  cleanup();
  const h = setup(<Boite />, 'down');
  await screen.findByRole('alert', {}, { timeout: 3000 });
  expect(text('1-2.erreur.bandeau.titre')).toBe('Impossible de lire la boîte de réception');
  h.state = etat();
  await userEvent.click(node('1-2.erreur.bandeau.reessayer')!);
  await screen.findByText('Autoriser Bash(npm test) ?');
});

test('« Ouvrir le terminal → » ouvre le sujet sur l’onglet de cet agent', async () => {
  const s = etat();
  setup(
    <Routes>
      <Route path="/sujets/:topicId" element={<Sujet />} />
    </Routes>,
    s,
    '/sujets/tp_1?agent=ag_err',
  );
  await waitFor(() =>
    expect(screen.getByTestId('term-ag_err').getAttribute('data-visible')).toBe('true'),
  );
  expect(screen.getByTestId('term-ag_pause').getAttribute('data-visible')).toBe('false');
});

// 12.5 : section « Mesh · <cell> » et pastille de la barre. Le contenu d'un DM est du texte brut (D30).
const dm = (over: Partial<MeshDm>): MeshDm => ({
  id: 1,
  threadId: null,
  from: 'mesh-gw',
  to: 'morzu-mac',
  kind: 'fyi',
  content: 'x',
  createdAt: at(1),
  replyTo: null,
  obligationId: null,
  seenAt: null,
  ...over,
});
const meshEtat = (over: Partial<MeshState> = {}, tailscaleManage = false) => ({
  state: {
    connected: true,
    tailscale: 'running' as const,
    monitor: 'running' as const,
    pending: 0,
    since: at(30),
    cell: 'morzu-mac',
    ...over,
  },
  inbox: [
    dm({ id: 11, kind: 'question', content: 'Tu lis le board ?', threadId: 'thr_abcdefghij' }),
    dm({ id: 12, kind: 'status', content: 'monitor relancé' }),
    dm({ id: 13, kind: 'unblock', content: '<b>pas du HTML</b>\n**ni du Markdown**' }),
    dm({ id: 14, kind: 'fyi', content: 'déjà lu', seenAt: at(0) }),
    dm({ id: 15, kind: 'answer', content: 'oui', from: 'peer-a' }),
  ],
  tailscaleManage,
});

test('mesh : « À traiter » (les plus anciens d’abord) puis « Informations », contenu en texte brut, « Vu »', async () => {
  const h = setup(<Boite />, { ...etat(), mesh: meshEtat() });
  await screen.findByText('Autoriser Bash(npm test) ?');
  expect(node('1-2.mesh')?.getAttribute('aria-label')).toBe('Mesh · morzu-mac');
  expect(text('1-2.mesh.compte')).toBe('4');
  expect(text('1-2.mesh.etat')).toBe('connecté');
  expect(
    [...document.querySelectorAll('[data-node^="1-2.mesh.groupe-"] > .groupe-entete h3')].map(
      (g) => g.textContent,
    ),
  ).toEqual(['À traiter', 'Informations']);
  expect([1, 2, 3, 4].map((n) => text(`1-2.mesh.dm-${n}.type`))).toEqual([
    'Question',
    'Déblocage',
    'Réponse',
    'Statut',
  ]);
  expect(text('1-2.mesh.dm-1.emetteur')).toBe('mesh-gw');
  expect(text('1-2.mesh.dm-1.fil')).toBe('fil thr_abcd');
  expect(text('1-2.mesh.dm-3.emetteur')).toBe('peer-a');
  // le DM vu n'est plus là
  expect(document.body.textContent).not.toContain('déjà lu');
  // texte brut : la balise est affichée telle quelle, jamais interprétée
  const contenu = node('1-2.mesh.dm-2.contenu')!;
  expect(contenu.querySelector('b')).toBeNull();
  expect(contenu.querySelector('pre')?.textContent).toBe('<b>pas du HTML</b>\n**ni du Markdown**');
  expect(contenu.textContent).toContain('donnée d’un pair du mesh');
  await userEvent.click(node('1-2.mesh.dm-1.vu')!);
  expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/mesh/dm/11/seen')).toBe(true);
  // la pastille compte les question/unblock non vus ; elle mène à Réglages, qui bascule (25.4, D99)
  expect(text('1-2.barre.mesh.texte')).toBe('monitor actif · 2 à traiter');
  expect(node('1-2.barre.mesh')?.getAttribute('href')).toBe('/reglages#mesh');
});

test('mesh hors ligne : « hors mesh depuis » ; sans date, « monitor arrêté » (connexion : Réglages, 25.3)', async () => {
  setup(<Boite />, {
    ...snapshot({ workspaces: [ws()], topics: [topic()] }),
    mesh: { ...meshEtat({ connected: false, monitor: 'stopped' }), inbox: [] },
  });
  await screen.findByText(/Rien à traiter/);
  expect(text('1-2.mesh.vide')).toBe('Aucun message à lire.');
  expect(text('1-2.mesh.etat')).toBe('hors mesh');
  expect(text('1-2.barre.mesh.texte')).toBe('hors mesh depuis 30 min');
  cleanup();
  setup(<Boite />, {
    ...snapshot({ workspaces: [ws()], topics: [topic()] }),
    mesh: meshEtat({ connected: false, tailscale: 'stopped', monitor: 'stopped', since: null }),
  });
  await screen.findByText(/Rien à traiter/);
  expect(text('1-2.barre.mesh.texte')).toBe('monitor arrêté');
});

test('sans mesh configuré : ni section ni pastille', async () => {
  setup(<Boite />, etat());
  await screen.findByText('Autoriser Bash(npm test) ?');
  expect(node('1-2.mesh')).toBeNull();
  expect(node('1-2.barre.mesh')).toBeNull();
});

// 12.6 : « Ouvrir la cell » — la cell vit ⇒ lien vers son terminal ; sinon choix du sujet, puis POST et navigation
function Lieu() {
  const l = useLocation();
  return <p data-testid="lieu">{`${l.pathname}${l.search}`}</p>;
}

test('« Ouvrir la cell » : choisir un sujet actif lance swarph-cell et mène à son terminal ; cell vivante ⇒ lien direct', async () => {
  const base = snapshot({
    workspaces: [ws()],
    topics: [
      topic(),
      topic({ id: 'tp_arch', branch: 'feat/vieux', slug: 'vieux', state: 'archived' }),
    ],
    runs: [run('run_1', 'tp_1')],
  });
  const h = setup(
    <Routes>
      <Route path="/boite" element={<Boite />} />
      <Route path="/sujets/:topicId" element={<Lieu />} />
    </Routes>,
    {
      ...base,
      mesh: { ...meshEtat(), inbox: [dm({ id: 21, kind: 'question', content: 'Dispo ?' })] },
    },
    '/boite',
  );
  h.respond.set(
    'POST /api/agents',
    json(201, { ...agent({ id: 'ag_cell', kind: 'swarph-cell' }) }),
  );
  await screen.findByText('Dispo ?');
  await userEvent.click(node('1-2.mesh.dm-1.cell')!);
  // seuls les sujets actifs sont proposés
  expect(text('1-2.mesh.dm-1.cell.sujet-1')).toBe('feat/s');
  expect(node('1-2.mesh.dm-1.cell.sujet-2')).toBeNull();
  await userEvent.click(node('1-2.mesh.dm-1.cell.sujet-1')!);
  expect(h.calls.find((c) => c.url === '/api/agents')?.body).toEqual({
    topicId: 'tp_1',
    kind: 'swarph-cell',
  });
  await waitFor(() =>
    expect(screen.getByTestId('lieu').textContent).toBe('/sujets/tp_1?agent=ag_cell'),
  );
  cleanup();
  setup(<Boite />, {
    ...base,
    agents: [agent({ id: 'ag_cell', kind: 'swarph-cell', status: 'idle' })],
    mesh: { ...meshEtat(), inbox: [dm({ id: 21, kind: 'question', content: 'Dispo ?' })] },
  });
  await screen.findByText('Dispo ?');
  expect(node('1-2.mesh.dm-1.cell')?.tagName).toBe('A');
  expect(node('1-2.mesh.dm-1.cell')?.getAttribute('href')).toBe('/sujets/tp_1?agent=ag_cell');
});
