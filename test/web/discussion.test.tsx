// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { PendingRequest, Server, ServerStatus } from '../../src/shared/model.js';
import type {
  ServerAgentView,
  ServerDiscussionView,
} from '../../web/src/data/discussionsServeur.js';
import { Discussion, OuvrirDiscussion } from '../../web/src/ecrans/Discussion.js';
import { Serveurs } from '../../web/src/ecrans/Serveurs.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

/** Chantier 17 (R.6) : écran Discussion d'un serveur, table des discussions, ouverture depuis la barre. */
vi.stubGlobal('WebSocket', FakeSocket);
afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;

const serveur = (over: Partial<Server> = {}): Server => ({
  id: 'srv_1',
  name: 'vps-ovh',
  mode: 'ssh_alias',
  target: 'vps',
  sshOptions: null,
  loadProfile: true,
  workdir: '~',
  shell: 'bash',
  keepSession: true,
  permissionMode: 'default',
  confirmDestructive: true,
  allowedDirs: ['~'],
  groupName: 'Serveurs',
  color: '#5de0a1',
  detectedAgents: ['claude', 'codex'],
  lastTestAt: null,
  rules: [],
  createdAt: 't',
  updatedAt: 't',
  ...over,
});

const etat = (over: Partial<ServerStatus> = {}): ServerStatus => ({
  serverId: 'srv_1',
  state: 'connected',
  latencyMs: 12,
  checkedAt: '2026-10-30T10:00:00.000Z',
  reason: null,
  ...over,
});

const agentVue = (over: Partial<ServerAgentView> = {}): ServerAgentView => ({
  id: 'sa_1',
  discussionId: 'sd_1',
  kind: 'claude',
  sessionId: 's',
  status: 'idle',
  tmuxSession: 'aid-sa_1',
  outOffset: 0,
  permissionMode: 'default',
  model: null,
  effort: null,
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-10-30T09:00:00.000Z',
  pending: null,
  ...over,
});

const discussion = (over: Partial<ServerDiscussionView> = {}): ServerDiscussionView => ({
  id: 'sd_1',
  serverId: 'srv_1',
  name: 'Déploiement',
  cwd: '~/app',
  archived: false,
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-10-30T09:00:00.000Z',
  agents: [agentVue()],
  ...over,
});

const routes = (
  <Routes>
    <Route path="/serveurs" element={<Serveurs />} />
    <Route path="/serveurs/:id/configuration" element={<p>configuration</p>} />
    <Route path="/serveurs/:id/discussion" element={<OuvrirDiscussion />} />
    <Route path="/serveurs/:id/discussions/:discussionId" element={<Discussion />} />
  </Routes>
);

function ouvrir(
  route: string,
  o: {
    status?: ServerStatus;
    d?: ServerDiscussionView;
    liste?: ServerDiscussionView[];
    agent?: ServerAgentView;
  } = {},
) {
  const d = o.d ?? discussion();
  return setup(routes, snapshot(), route, {
    'GET /api/servers': json(200, [serveur()]),
    'GET /api/servers/status': json(200, [o.status ?? etat()]),
    'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
    'GET /api/servers/srv_1/discussions': json(200, o.liste ?? [d]),
    'GET /api/servers/srv_1/discussions/sd_1': json(200, d),
    'GET /api/server-agents/sa_1': json(200, o.agent ?? d.agents[0]!),
  });
}

/** Le canal du fil distant, et non celui de l'état du daemon. */
const fil = async () => {
  await waitFor(() =>
    expect(FakeSocket.all.some((s) => s.url.includes('/ws/server-agent/'))).toBe(true),
  );
  const s = FakeSocket.all.filter((x) => x.url.includes('/ws/server-agent/')).at(-1)!;
  act(() => s.open());
  return s;
};

const pousser = (s: FakeSocket, items: object[]) =>
  act(() => s.push({ t: 'history', truncated: false, items }));

test('en-tête : fil d’Ariane, titre, puces d’état, serveur, répertoire, session persistante ; canal distant', async () => {
  ouvrir('/serveurs/srv_1/discussions/sd_1');
  await waitFor(() => expect(node('discussion.titre')?.textContent).toBe('Déploiement'));
  await waitFor(() => expect(node('discussion.etat')?.textContent).toBe('Connecté · 12 ms'));
  expect(node('discussion.serveur')?.textContent).toBe('vps-ovh');
  expect(node('discussion.cible')?.textContent).toBe('vps-ovh');
  expect(node('discussion.repertoire')?.textContent).toBe('~/app');
  expect(node('discussion.session')?.textContent).toBe('session persistante');
  expect(node('discussion.agent.nom')?.textContent).toBe('claude');
  expect(node('discussion.agent.etat')?.textContent).toBe('libre');
  const s = await fil();
  expect(s.url).toMatch(/\/ws\/server-agent\/sa_1\?after=0$/);

  fireEvent.click(node('discussion.configurer')!);
  expect(await screen.findByText('configuration')).toBeTruthy();
});

test('fil distant : serveur à côté de l’agent, « N commandes sur <serveur> », composer et étoile sur les routes distantes', async () => {
  const h = ouvrir('/serveurs/srv_1/discussions/sd_1');
  const s = await fil();
  pousser(s, [
    { seq: 1, at: '2026-10-30T09:00:00.000Z', event: { type: 'message', role: 'user', text: 'Q' } },
    { seq: 2, at: 't', event: { type: 'tool_start', toolId: 'a', name: 'Bash', input: 'ls' } },
    { seq: 3, at: 't', event: { type: 'tool_end', toolId: 'a', output: 'x', isError: false } },
    {
      seq: 4,
      at: '2026-10-30T09:00:02.000Z',
      event: { type: 'message', role: 'assistant', text: 'fait' },
    },
  ]);
  expect(await screen.findByText('1 commande sur vps-ovh')).toBeTruthy();
  expect(document.querySelector('.message-agent-serveur')?.textContent).toBe('vps-ovh');

  const champ = screen.getByPlaceholderText('Écris à claude sur vps-ovh…') as HTMLTextAreaElement;
  h.respond.set('POST /api/server-agents/sa_1/input', json(202, { id: 'sa_1' }));
  fireEvent.change(champ, { target: { value: 'bonjour' } });
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
  await waitFor(() =>
    expect(h.calls.some((c) => c.url === '/api/server-agents/sa_1/input')).toBe(true),
  );
  // un événement du fil relit l'agent
  const avant = h.calls.filter((c) => c.url === '/api/server-agents/sa_1').length;
  act(() =>
    s.push({ t: 'event', seq: 5, at: 't', event: { type: 'message', role: 'user', text: 'b' } }),
  );
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url === '/api/server-agents/sa_1').length).toBeGreaterThan(
      avant,
    ),
  );

  h.respond.set('PUT /api/server-agents/sa_1/messages/1/mark', json(200, { seq: 1, marked: true }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Marquer la question' })[0]!);
  await waitFor(() =>
    expect(h.calls.some((c) => c.url === '/api/server-agents/sa_1/messages/1/mark')).toBe(true),
  );
  await waitFor(() =>
    expect(h.calls.some((c) => c.url === '/api/server-agents/sa_1/options')).toBe(true),
  );
  expect(h.calls.some((c) => c.url.startsWith('/api/agents/'))).toBe(false);
});

test('lignes de connexion : perte puis reprise sur une ligne, échec en rouge avec Reconnecter', async () => {
  const h = ouvrir('/serveurs/srv_1/discussions/sd_1');
  const s = await fil();
  const perdue = new Date(2026, 9, 30, 9, 41).toISOString();
  pousser(s, [
    { seq: 1, at: 't', event: { type: 'message', role: 'user', text: 'Q' } },
    { seq: 2, at: perdue, event: { type: 'connection_lost', at: perdue } },
  ]);
  expect((await screen.findByText(/Connexion perdue à 09:41/)).textContent).toBe(
    'Connexion perdue à 09:41 · reconnexion…',
  );
  act(() =>
    s.push({
      t: 'event',
      seq: 3,
      at: 't',
      event: { type: 'connection_resumed', at: 't', afterMs: 4_200, sessionFound: true },
    }),
  );
  expect(
    await screen.findByText('Connexion perdue à 09:41 · reprise après 4 s · session retrouvée'),
  ).toBeTruthy();

  act(() =>
    s.push({
      t: 'event',
      seq: 4,
      at: perdue,
      event: { type: 'resume_failed', reason: 'session absente' },
    }),
  );
  const echec = await screen.findByRole('alert');
  expect(echec.textContent).toContain('Session introuvable sur le serveur : session absente');
  h.respond.set('POST /api/server-agents/sa_1/reconnect', json(202, { id: 'sa_1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reconnecter' }));
  await waitFor(() =>
    expect(h.calls.some((c) => c.url === '/api/server-agents/sa_1/reconnect')).toBe(true),
  );
  // un message après l'échec : le bouton ne vaut plus pour cette ligne
  act(() =>
    s.push({ t: 'event', seq: 5, at: 't', event: { type: 'message', role: 'user', text: 'R' } }),
  );
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Reconnecter' })).toBeNull());
});

const confirmation = (id: string, command: string): PendingRequest => ({
  id,
  kind: 'permission',
  question: `Bash : ${command}`,
  options: [
    { label: 'Autoriser', answer: 'yes' },
    { label: 'Refuser', answer: 'no' },
    { label: 'Toujours autoriser sur ce serveur', answer: 'always' },
  ],
  command,
  confirm: { server: 'vps-ovh' },
});

test('carte de confirmation au fil : en attente, puis autorisée par une règle ; demande ordinaire sur la route distante', async () => {
  const h = ouvrir('/serveurs/srv_1/discussions/sd_1');
  const s = await fil();
  pousser(s, [
    { seq: 1, at: 't', event: { type: 'message', role: 'user', text: 'Q' } },
    { seq: 2, at: 't', event: { type: 'request', request: confirmation('r1', 'rm -f x') } },
    { seq: 3, at: 't', event: { type: 'request', request: confirmation('r2', 'rm -f y') } },
    {
      seq: 4,
      at: 't',
      event: { type: 'request_answered', requestId: 'r2', answer: 'yes', auto: true },
    },
    {
      seq: 5,
      at: 't',
      event: {
        type: 'request',
        request: {
          id: 'r3',
          kind: 'permission',
          question: 'Bash : ls',
          options: [
            { label: 'Oui', answer: 'yes' },
            { label: 'Non', answer: 'no' },
          ],
        },
      },
    },
  ]);
  expect(await screen.findByText('Autorisée par une règle du serveur')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Toujours autoriser sur ce serveur' })).toHaveLength(
    1,
  );
  h.respond.set('POST /api/server-agents/sa_1/answer', json(202, { id: 'sa_1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Oui' }));
  await waitFor(() =>
    expect(h.calls.find((c) => c.url === '/api/server-agents/sa_1/answer')?.body as object).toEqual(
      { pendingId: 'r3', answer: 'yes' },
    ),
  );
  // fin de tour sans réponse au fil : la carte se ferme
  act(() => s.push({ t: 'event', seq: 6, at: 't', event: { type: 'turn_end', ok: true } }));
  expect(await screen.findByText('Demande close')).toBeTruthy();
});

test('serveur injoignable : bandeau au-dessus du composer, composer fermé, Reconnecter relance un contrôle', async () => {
  const h = ouvrir('/serveurs/srv_1/discussions/sd_1', {
    status: etat({ state: 'unreachable', latencyMs: null, reason: 'Connection refused' }),
  });
  await fil();
  const bandeau = await waitFor(() => {
    const b = node('1-3.conversation.injoignable');
    expect(b).not.toBeNull();
    return b!;
  });
  expect(bandeau.textContent).toContain('vps-ovh ne répond pas : Connection refused');
  expect(
    (screen.getByRole('textbox', { name: 'Message à claude' }) as HTMLTextAreaElement).disabled,
  ).toBe(true);
  expect(node('discussion.etat')?.textContent).toBe('Injoignable');
  h.respond.set('POST /api/servers/srv_1/ping', json(200, etat()));
  fireEvent.click(node('1-3.conversation.injoignable.reconnecter')!);
  await waitFor(() => expect(node('1-3.conversation.injoignable')).toBeNull());
  expect(
    (screen.getByRole('textbox', { name: 'Message à claude' }) as HTMLTextAreaElement).disabled,
  ).toBe(false);
});

test('discussion inconnue : message et retour aux serveurs', async () => {
  setup(routes, snapshot(), '/serveurs/srv_1/discussions/sd_1', {
    'GET /api/servers': json(200, [serveur()]),
    'GET /api/servers/status': json(200, [etat()]),
    'GET /api/servers/srv_1/discussions/sd_1': json(404, { error: 'inconnue' }),
  });
  expect(await screen.findByText('Cette discussion n’existe plus sur ce serveur.')).toBeTruthy();
});

test('table des discussions : agent et état, activité, Reprendre ; « Ouvrir la discussion » va à la plus récente', async () => {
  const ancienne = discussion({
    id: 'sd_0',
    name: 'Ancienne',
    agents: [agentVue({ id: 'sa_0', updatedAt: '2026-10-29T09:00:00.000Z', status: 'stopped' })],
    updatedAt: '2026-10-29T09:00:00.000Z',
  });
  // la plus récente par l'activité de son agent, pas par la date de la discussion
  const recente = discussion({
    updatedAt: '2026-10-28T09:00:00.000Z',
    agents: [agentVue({ updatedAt: new Date().toISOString(), status: 'working' })],
  });
  ouvrir('/serveurs', { liste: [ancienne, recente] });
  await waitFor(() => expect(node('serveurs.serveur-1.discussions.table')).not.toBeNull());
  expect(node('serveurs.serveur-1.discussion-1.nom')?.textContent).toBe('Ancienne');
  expect(node('serveurs.serveur-1.discussion-1.agent')?.textContent).toBe('claude · arrêté');
  expect(node('serveurs.serveur-1.discussion-2.agent')?.textContent).toBe('claude · travaille');
  expect(node('serveurs.serveur-1.discussion-2.activite')?.textContent).toBe("à l'instant");

  fireEvent.click(node('serveurs.serveur-1.ouvrir')!);
  await waitFor(() => expect(node('discussion.titre')?.textContent).toBe('Déploiement'));
});

test('« Reprendre » et clic de ligne ouvrent la discussion', async () => {
  ouvrir('/serveurs');
  await waitFor(() => expect(node('serveurs.serveur-1.discussion-1')).not.toBeNull());
  fireEvent.click(node('serveurs.serveur-1.discussion-1.reprendre')!);
  await waitFor(() => expect(node('discussion.titre')?.textContent).toBe('Déploiement'));
  cleanup();
  ouvrir('/serveurs');
  await waitFor(() => expect(node('serveurs.serveur-1.discussion-1')).not.toBeNull());
  fireEvent.click(node('serveurs.serveur-1.discussion-1.agent')!);
  await waitFor(() => expect(node('discussion.titre')?.textContent).toBe('Déploiement'));
});

test('aucune discussion : « Ouvrir la discussion » propose d’en créer une, avec les agents détectés', async () => {
  const h = ouvrir('/serveurs', { liste: [] });
  await waitFor(() => expect(node('serveurs.serveur-1.discussions.vide')).not.toBeNull());
  fireEvent.click(node('serveurs.serveur-1.ouvrir')!);
  const agents = (await waitFor(() => node('nouvelle-discussion.agent')!)) as HTMLSelectElement;
  expect([...agents.options].map((o) => o.value)).toEqual(['claude', 'codex']);
  fireEvent.change(node('nouvelle-discussion.nom')!, { target: { value: '  Logs  ' } });
  fireEvent.change(agents, { target: { value: 'codex' } });
  h.respond.set('POST /api/servers/srv_1/discussions', json(201, discussion()));
  fireEvent.click(node('nouvelle-discussion.creer')!);
  await waitFor(() =>
    expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Logs', kind: 'codex' }),
  );
  await waitFor(() => expect(node('discussion')).not.toBeNull());
});

test('serveur jamais testé : la création dit pourquoi aucun agent n’est proposé', async () => {
  setup(routes, snapshot(), '/serveurs', {
    'GET /api/servers': json(200, [serveur({ detectedAgents: null })]),
    'GET /api/servers/status': json(200, [etat()]),
    'GET /api/servers/srv_1/discussions': json(200, []),
  });
  await waitFor(() => expect(node('serveurs.serveur-1.discussions.vide')).not.toBeNull());
  fireEvent.click(node('serveurs.serveur-1.ouvrir')!);
  await waitFor(() => expect(node('nouvelle-discussion.aucun-agent')).not.toBeNull());
  expect((node('nouvelle-discussion.creer') as HTMLButtonElement).disabled).toBe(true);
});

test('barre gauche → /serveurs/:id/discussion : la plus récente, ou l’écran Serveurs avec la création ouverte', async () => {
  ouvrir('/serveurs/srv_1/discussion');
  await waitFor(() => expect(node('discussion.titre')?.textContent).toBe('Déploiement'));
  cleanup();
  ouvrir('/serveurs/srv_1/discussion', { liste: [] });
  await waitFor(() => expect(node('nouvelle-discussion')).not.toBeNull());
  expect(node('serveurs.serveur-1')).not.toBeNull();
});

test('perte puis échec de reprise : une seule ligne, rouge ; Reconnecter réussi le dit, en échec aussi (revue R.6)', async () => {
  const h = ouvrir('/serveurs/srv_1/discussions/sd_1');
  const s = await fil();
  const perdue = new Date(2026, 9, 30, 9, 41).toISOString();
  pousser(s, [
    { seq: 1, at: 't', event: { type: 'message', role: 'user', text: 'Q' } },
    { seq: 2, at: perdue, event: { type: 'connection_lost', at: perdue } },
    { seq: 3, at: perdue, event: { type: 'connection_lost', at: perdue } },
    { seq: 4, at: perdue, event: { type: 'resume_failed', reason: '' } },
  ]);
  const echec = await screen.findByRole('alert');
  expect(echec.textContent).toContain('Session introuvable sur le serveur');
  expect(screen.queryByText(/reconnexion…/)).toBeNull();
  expect(document.querySelectorAll('.ligne-connexion')).toHaveLength(1);

  h.respond.set('POST /api/server-agents/sa_1/reconnect', json(502, { error: 'ssh injoignable' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reconnecter' }));
  expect(await screen.findByText('ssh injoignable')).toBeTruthy();
  h.respond.set('POST /api/server-agents/sa_1/reconnect', json(202, { id: 'sa_1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reconnecter' }));
  expect(await screen.findByText('Agent relancé sur le serveur')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Reconnecter' })).toBeNull();
});

test('pas de pièce jointe sur un fil distant : ce serait un fichier du daemon (revue R.6)', async () => {
  ouvrir('/serveurs/srv_1/discussions/sd_1');
  await fil();
  await screen.findByPlaceholderText('Écris à claude sur vps-ovh…');
  expect(screen.queryByRole('button', { name: 'Joindre des fichiers' })).toBeNull();
});

function Sonde() {
  return <p data-node="sonde">{JSON.stringify(useLocation().state)}</p>;
}

test('dialogue venu de la barre gauche : Annuler efface l’état de navigation (revue R.6)', async () => {
  setup(
    <>
      {routes}
      <Sonde />
    </>,
    snapshot(),
    '/serveurs/srv_1/discussion',
    {
      'GET /api/servers': json(200, [serveur()]),
      'GET /api/servers/status': json(200, [etat()]),
      'GET /api/servers/srv_1/discussions': json(200, []),
    },
  );
  await waitFor(() => expect(node('nouvelle-discussion')).not.toBeNull());
  expect(node('sonde')?.textContent).toBe('{"creer":"srv_1"}');
  fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  await waitFor(() => expect(node('sonde')?.textContent).toBe('null'));
  expect(node('nouvelle-discussion')).toBeNull();
});

test('chantier 19, S.6 : confirmation modifiée pendant que l’agent tourne — dit au-dessus du fil ; sinon, rien', async () => {
  ouvrir('/serveurs/srv_1/discussions/sd_1', {
    d: discussion({ agents: [agentVue({ staleConfirm: true })] }),
  });
  await waitFor(() =>
    expect(node('discussion.confirmation-perimee')?.textContent).toBe(
      'Confirmation des commandes destructives modifiée sur ce serveur : cet agent garde l’ancien réglage jusqu’à sa prochaine relance.',
    ),
  );
  cleanup();
  ouvrir('/serveurs/srv_1/discussions/sd_1');
  await waitFor(() => expect(node('discussion.titre')?.textContent).toBe('Déploiement'));
  expect(node('discussion.confirmation-perimee')).toBeNull();
});
