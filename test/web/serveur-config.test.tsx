// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import type { Server, ServerStatus, ServerTest } from '../../src/shared/model.js';
import { ServeurConfig } from '../../web/src/ecrans/ServeurConfig.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const champ = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const saisir = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

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
  detectedAgents: ['claude'],
  lastTestAt: null,
  rules: [],
  createdAt: 't',
  updatedAt: 't1',
  ...over,
});

const etat: ServerStatus = {
  serverId: 'srv_1',
  state: 'connected',
  latencyMs: 12,
  checkedAt: 't',
  reason: null,
};

const testFini = (over: Partial<ServerTest> = {}): ServerTest => ({
  serverId: 'srv_1',
  startedAt: 't',
  finishedAt: 't2',
  ok: false,
  error: 'tmux absent du serveur : la session ne survivrait pas à une coupure',
  steps: [
    {
      id: 'command',
      label: 'Commande trouvée',
      state: 'ok',
      durationMs: 1,
      detail: '/usr/bin/ssh',
    },
    { id: 'shell', label: 'Shell distant ouvert', state: 'ok', durationMs: 412, detail: '412 ms' },
    {
      id: 'workdir',
      label: 'Répertoire de travail accessible',
      state: 'ok',
      durationMs: 1,
      detail: '/home/debian',
    },
    { id: 'agents', label: 'Agents détectés', state: 'ok', durationMs: 1, detail: 'claude' },
    {
      id: 'session',
      label: 'Session persistante disponible',
      state: 'failed',
      durationMs: 1,
      detail: 'tmux absent',
    },
  ],
  raw: '$ shell\naid-ok\n',
  ...over,
});

/** Ce que rend `POST /test` : le test qui démarre. */
const testLance = (serverId = 'srv_1'): ServerTest => ({
  ...testFini({ serverId, startedAt: 't9', finishedAt: null, ok: null, error: null }),
  steps: [
    { id: 'command', label: 'Commande trouvée', state: 'running', durationMs: null, detail: null },
  ],
  raw: '',
});

const app = (
  <Routes>
    <Route path="/serveurs" element={<p>liste des serveurs</p>} />
    <Route path="/serveurs/nouveau" element={<ServeurConfig />} />
    <Route path="/serveurs/:id/configuration" element={<ServeurConfig />} />
  </Routes>
);

const ouvrir = (route: string, servers: Server[], routes = {}) =>
  setup(app, snapshot(), route, {
    'GET /api/servers': json(200, servers),
    'GET /api/servers/status': json(
      200,
      servers.map((s) => ({ ...etat, serverId: s.id })),
    ),
    'GET /api/servers/srv_1/test': json(404, { error: 'aucun test' }),
    'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
    ...routes,
  });

const enregistrer = () => node('serveur-config.enregistrer') as HTMLButtonElement;

test('création : enregistrer seulement quand nom et cible sont remplis, puis test lancé', async () => {
  const cree = serveur({ id: 'srv_9', name: 'build', target: 'build', detectedAgents: null });
  const h = ouvrir('/serveurs/nouveau', [], {
    'POST /api/servers': json(201, cree),
    'POST /api/servers/srv_9/test': json(202, testLance('srv_9')),
    'GET /api/servers/srv_9/test': json(404, {}),
  });
  await waitFor(() => expect(node('serveur-config.titre')?.textContent).toBe('Ajouter un serveur'));
  expect(enregistrer().disabled).toBe(true);
  saisir(champ('Nom affiché'), 'build');
  expect(enregistrer().disabled).toBe(true);
  expect(node('serveur-config.erreur')?.textContent).toBe('L’alias est obligatoire.');
  saisir(champ('Alias SSH'), 'build');
  expect(enregistrer().disabled).toBe(false);

  h.respond.set('GET /api/servers', json(200, [cree]));
  fireEvent.click(enregistrer());
  await waitFor(() => expect(node('serveur-config.titre')?.textContent).toBe('Configurer build'));
  const post = h.calls.find((c) => c.method === 'POST' && c.url === '/api/servers')!;
  expect(post.body).toMatchObject({
    name: 'build',
    mode: 'ssh_alias',
    target: 'build',
    sshOptions: null,
    workdir: '~',
    shell: 'bash',
    keepSession: true,
    permissionMode: 'default',
    confirmDestructive: true,
    allowedDirs: ['~'],
    groupName: 'Serveurs',
  });
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/servers/srv_9/test')).toBe(
      true,
    ),
  );
});

test('changer de mode garde la saisie de chaque mode ; options ssh seulement en Hôte SSH', async () => {
  const h = ouvrir('/serveurs/nouveau', [], {
    'POST /api/servers': json(400, { error: 'refusé' }),
  });
  await waitFor(() => expect(node('serveur-config.titre')).not.toBeNull());
  saisir(champ('Nom affiché'), 'x');
  saisir(champ('Alias SSH'), 'vps');
  fireEvent.click(node('serveur-config.mode-command')!);
  expect(node('serveur-config.mode-command')?.getAttribute('aria-pressed')).toBe('true');
  expect(champ('Commande de connexion').value).toBe('');
  saisir(champ('Commande de connexion'), 'ssh vps');
  fireEvent.click(node('serveur-config.mode-ssh_host')!);
  saisir(champ('Hôte'), 'vps.exemple.fr');
  saisir(champ('Port'), '70000');
  expect(node('serveur-config.erreur')?.textContent).toBe('Le port doit être entre 1 et 65535.');
  expect(enregistrer().disabled).toBe(true);
  saisir(champ('Port'), '2222');
  saisir(champ('Utilisateur'), 'debian');
  fireEvent.click(node('serveur-config.mode-ssh_alias')!);
  expect(champ('Alias SSH').value).toBe('vps');
  fireEvent.click(node('serveur-config.mode-ssh_host')!);
  expect(champ('Hôte').value).toBe('vps.exemple.fr');

  fireEvent.click(enregistrer());
  await waitFor(() => expect(node('serveur-config.erreur')?.textContent).toContain('refusé'));
  expect(h.calls.find((c) => c.method === 'POST')!.body).toMatchObject({
    mode: 'ssh_host',
    target: 'vps.exemple.fr',
    sshOptions: { port: 2222, user: 'debian', identityFile: null, jump: null },
  });
});

test('modification : PATCH des seuls réglages, test relancé ; Annuler demande confirmation', async () => {
  const h = ouvrir('/serveurs/srv_1/configuration', [serveur()], {
    'PATCH /api/servers/srv_1': json(200, serveur({ workdir: '~/src', updatedAt: 't2' })),
    'POST /api/servers/srv_1/test': json(202, testLance()),
  });
  await waitFor(() => expect(node('serveur-config.titre')?.textContent).toBe('Configurer vps-ovh'));
  expect(champ('Alias SSH').value).toBe('vps');
  expect(enregistrer().disabled).toBe(true);

  saisir(champ('Répertoire de travail'), '~/src');
  expect(enregistrer().disabled).toBe(false);
  fireEvent.click(node('serveur-config.annuler')!);
  const dialogue = await screen.findByRole('dialog', { name: 'Abandonner les modifications ?' });
  fireEvent.click(within(dialogue).getByRole('button', { name: 'Continuer la saisie' }));
  expect(champ('Répertoire de travail').value).toBe('~/src');

  h.respond.set('GET /api/servers', json(200, [serveur({ workdir: '~/src', updatedAt: 't2' })]));
  fireEvent.click(enregistrer());
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/servers/srv_1/test')).toBe(
      true,
    ),
  );
  expect(h.calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ workdir: '~/src' });
  // le formulaire repart de la version enregistrée : plus rien à enregistrer
  await waitFor(() => expect(enregistrer().disabled).toBe(true));
  fireEvent.click(node('serveur-config.annuler')!);
  await screen.findByText('liste des serveurs');
});

test('colonne de test : dernier test lu, étapes, conclusion, sortie brute ; progression en direct', async () => {
  const h = ouvrir('/serveurs/srv_1/configuration', [serveur()], {
    'GET /api/servers/srv_1/test': json(200, testFini()),
    'POST /api/servers/srv_1/test': json(202, testLance()),
  });
  await waitFor(() => expect(node('serveur-config.test.conclusion')).not.toBeNull());
  expect(node('serveur-config.test.conclusion')?.textContent).toContain('tmux absent');
  expect(node('serveur-config.test.session')?.getAttribute('data-etat')).toBe('failed');
  expect(node('serveur-config.test.shell')?.textContent).toContain('412 ms');
  expect(node('serveur-config.test.brut')?.textContent).toContain('aid-ok');

  fireEvent.click(node('serveur-config.tester')!);
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/servers/srv_1/test')).toBe(
      true,
    ),
  );
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  const enCours = testFini({ finishedAt: null, ok: null, error: null });
  enCours.steps = enCours.steps.map((s, i) => ({ ...s, state: i === 0 ? 'running' : 'pending' }));
  act(() => FakeSocket.all.at(-1)!.push({ kind: 'ephemeral', type: 'server.test', test: enCours }));
  expect(node('serveur-config.test.command')?.getAttribute('data-etat')).toBe('running');
  expect(node('serveur-config.test.conclusion')).toBeNull();
  expect((node('serveur-config.tester') as HTMLButtonElement).disabled).toBe(true);
});

test('agents détectés, dossiers autorisés, règles révocables', async () => {
  const h = ouvrir(
    '/serveurs/srv_1/configuration',
    [
      serveur({
        rules: [{ id: 'rule_1', pattern: 'Bash(systemctl restart nginx)', createdAt: 't' }],
      }),
    ],
    { 'DELETE /api/servers/srv_1/rules/rule_1': json(200, serveur()) },
  );
  await waitFor(() => expect(node('serveur-config.agents')).not.toBeNull());
  expect(node('serveur-config.agent-claude')?.textContent).toContain('détecté');
  expect(node('serveur-config.agent-codex')?.textContent).toContain('non détecté');

  saisir(node('serveur-config.dossier')!, '/srv');
  fireEvent.click(node('serveur-config.dossier-ajouter')!);
  expect(node('serveur-config.dossiers')?.textContent).toContain('/srv');
  fireEvent.click(screen.getByRole('button', { name: 'Retirer ~' }));
  expect(enregistrer().disabled).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: 'Révoquer Bash(systemctl restart nginx)' }));
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/rules/rule_1'))).toBe(
      true,
    ),
  );
});

test('aperçu de la barre gauche suit le nom, le groupe et la couleur', async () => {
  ouvrir('/serveurs/srv_1/configuration', [serveur()]);
  await waitFor(() => expect(node('serveur-config.apercu.nom')?.textContent).toBe('vps-ovh'));
  saisir(champ('Nom affiché'), 'prod');
  saisir(champ('Groupe dans la barre gauche'), 'Clients');
  fireEvent.click(screen.getByRole('button', { name: 'Violet' }));
  expect(node('serveur-config.apercu.nom')?.textContent).toBe('prod');
  expect(node('serveur-config.apercu.groupe')?.textContent).toBe('Clients');
  expect(screen.getByRole('button', { name: 'Violet' }).getAttribute('aria-pressed')).toBe('true');
});

test('supprimer après confirmation ramène à la liste ; serveur inconnu signalé', async () => {
  const h = ouvrir('/serveurs/srv_1/configuration', [serveur()], {
    'DELETE /api/servers/srv_1': json(204, {}),
  });
  await waitFor(() => expect(node('serveur-config.supprimer')).not.toBeNull());
  fireEvent.click(node('serveur-config.supprimer')!);
  fireEvent.click(node('serveur-config.supprimer.confirmer')!);
  await screen.findByText('liste des serveurs');
  expect(h.calls.some((c) => c.method === 'DELETE' && c.url === '/api/servers/srv_1')).toBe(true);

  cleanup();
  ouvrir('/serveurs/srv_404/configuration', [serveur()]);
  await waitFor(() => expect(node('serveur-config.introuvable')).not.toBeNull());
});

test('Abandonner quitte sans enregistrer ; le fil d’Ariane demande aussi confirmation', async () => {
  const h = ouvrir('/serveurs/srv_1/configuration', [serveur()]);
  await waitFor(() => expect(node('serveur-config.titre')).not.toBeNull());
  saisir(champ('Nom affiché'), 'autre');
  const fil = screen.getByRole('navigation', { name: 'Fil d’Ariane' });
  fireEvent.click(within(fil).getByRole('link', { name: 'Serveurs' }));
  const dialogue = await screen.findByRole('dialog', { name: 'Abandonner les modifications ?' });
  fireEvent.click(within(dialogue).getByRole('button', { name: 'Abandonner' }));
  await screen.findByText('liste des serveurs');
  expect(h.calls.some((c) => c.method === 'PATCH')).toBe(false);
});

test('un double clic sur Enregistrer ne crée qu’un serveur ; mode commande sans options ssh', async () => {
  const cree = serveur({ id: 'srv_9', mode: 'command', target: 'ssh vps' });
  const h = ouvrir('/serveurs/nouveau', [], {
    'POST /api/servers': json(201, cree),
    'POST /api/servers/srv_9/test': json(202, testLance('srv_9')),
    'GET /api/servers/srv_9/test': json(404, {}),
  });
  await waitFor(() => expect(node('serveur-config.titre')).not.toBeNull());
  saisir(champ('Nom affiché'), 'x');
  fireEvent.click(node('serveur-config.mode-command')!);
  saisir(champ('Commande de connexion'), 'ssh vps');
  h.respond.set('GET /api/servers', json(200, [cree]));
  fireEvent.click(enregistrer());
  fireEvent.click(enregistrer());
  await waitFor(() => expect(node('serveur-config.titre')?.textContent).toBe('Configurer vps-ovh'));
  const posts = h.calls.filter((c) => c.method === 'POST' && c.url === '/api/servers');
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toMatchObject({ mode: 'command', target: 'ssh vps', sshOptions: null });
});

test('l’échec du lancement du test reste affiché après l’enregistrement ; une saisie efface l’erreur', async () => {
  const h = ouvrir('/serveurs/srv_1/configuration', [serveur()], {
    'PATCH /api/servers/srv_1': json(200, serveur({ workdir: '~/src', updatedAt: 't2' })),
    'POST /api/servers/srv_1/test': json(409, { error: 'test déjà en cours' }),
  });
  await waitFor(() => expect(node('serveur-config.titre')).not.toBeNull());
  saisir(champ('Répertoire de travail'), '~/src');
  h.respond.set('GET /api/servers', json(200, [serveur({ workdir: '~/src', updatedAt: 't2' })]));
  fireEvent.click(enregistrer());
  await waitFor(() =>
    expect(node('serveur-config.erreur')?.textContent).toContain('test déjà en cours'),
  );
  expect(champ('Répertoire de travail').value).toBe('~/src');
  saisir(champ('Shell distant'), 'zsh');
  expect(node('serveur-config.erreur')).toBeNull();
});

test('un dossier tapé sans « Ajouter » part à l’enregistrement ; révoquer une règle garde le brouillon', async () => {
  const h = ouvrir(
    '/serveurs/srv_1/configuration',
    [serveur({ rules: [{ id: 'rule_1', pattern: 'Bash(ls)', createdAt: 't' }] })],
    {
      'DELETE /api/servers/srv_1/rules/rule_1': json(200, serveur()),
      'PATCH /api/servers/srv_1': json(200, serveur()),
      'POST /api/servers/srv_1/test': json(202, testLance()),
    },
  );
  await waitFor(() => expect(node('serveur-config.titre')).not.toBeNull());
  saisir(node('serveur-config.dossier')!, '/srv');
  expect(enregistrer().disabled).toBe(false);
  saisir(champ('Répertoire de travail'), '~/src');
  h.respond.set('GET /api/servers', json(200, [serveur({ updatedAt: 't3' })]));
  fireEvent.click(screen.getByRole('button', { name: 'Révoquer Bash(ls)' }));
  await waitFor(() => expect(node('serveur-config.regles')).toBeNull());
  expect(champ('Répertoire de travail').value).toBe('~/src');
  fireEvent.click(enregistrer());
  await waitFor(() => expect(h.calls.some((c) => c.method === 'PATCH')).toBe(true));
  expect(h.calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({
    workdir: '~/src',
    allowedDirs: ['~', '/srv'],
  });
});
