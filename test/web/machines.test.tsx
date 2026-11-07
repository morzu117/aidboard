// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import { agentOptions } from '../../src/shared/agentSettings.js';
import type {
  Fournisseurs,
  MachineLocale,
  MachineServeur,
  Server,
  ServerStatus,
  ServerTest,
} from '../../src/shared/model.js';
import { Machines } from '../../web/src/ecrans/Machines.js';
import { agent, Chemin, cheminCourant, json, setup, snapshot } from './helpers.js';

// Chantier 29 : l'écran Machines, Ton cockpit et les cartes (D151, D152, D157).

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;

const MESURE = '2026-11-06T10:00:00.000Z';

const local = (over: Partial<MachineLocale> = {}): MachineLocale => ({
  agents: [
    { kind: 'claude', trouve: true, version: '2.1.0', options: agentOptions('claude', []) },
    { kind: 'codex', trouve: false, version: null, options: agentOptions('codex', []) },
  ],
  transport: 'stream',
  memoire: { octets: 12.34 * 1024 ** 3, mesureA: MESURE },
  mesureA: MESURE,
  ...over,
});

const serveur = (over: Partial<Server> = {}): Server => ({
  id: 'srv_1',
  name: 'vps',
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
  detectedAgents: null,
  lastTestAt: null,
  rules: [],
  createdAt: 't',
  updatedAt: 't',
  ...over,
});

const etat = (over: Partial<ServerStatus> = {}): ServerStatus => ({
  serverId: 'srv_1',
  state: 'connected',
  latencyMs: 285,
  checkedAt: MESURE,
  reason: null,
  ...over,
});

const essai = (ok: boolean): ServerTest => ({
  serverId: 'srv_1',
  startedAt: MESURE,
  finishedAt: MESURE,
  ok,
  error: ok ? null : 'aucun agent',
  raw: '',
  steps: [
    { id: 'command', label: 'Commande trouvée', state: 'ok', durationMs: 1, detail: null },
    { id: 'shell', label: 'Shell distant ouvert', state: 'ok', durationMs: 1, detail: null },
    {
      id: 'workdir',
      label: 'Répertoire de travail accessible',
      state: 'ok',
      durationMs: 1,
      detail: null,
    },
    {
      id: 'agents',
      label: 'Agents détectés',
      state: ok ? 'ok' : 'failed',
      durationMs: 1,
      detail: ok ? 'claude' : 'aucun agent (claude, codex, cursor) dans le PATH du shell distant',
    },
    {
      id: 'session',
      label: 'Session persistante disponible',
      state: ok ? 'ok' : 'skipped',
      durationMs: 1,
      detail: null,
    },
  ],
});

const jamais = (serverId = 'srv_1'): MachineServeur => ({
  serverId,
  test: null,
  versions: null,
  memoire: null,
  mesureA: null,
});

const FOURNISSEURS: Fournisseurs = { fournisseurs: [], alertes: [] };

const app = (
  <>
    <Routes>
      <Route path="/machines" element={<Machines />} />
      <Route path="*" element={<p>ailleurs</p>} />
    </Routes>
    <Chemin />
  </>
);

const ouvrir = (
  routes: Record<string, (body: unknown) => Response> = {},
  servers: Server[] = [],
  agents = [agent({ id: 'ag_1', kind: 'claude', transport: 'stream', status: 'working' })],
) =>
  setup(app, snapshot({ agents }), '/machines', {
    'GET /api/machines/local': json(200, local()),
    'GET /api/machines/serveurs': json(
      200,
      servers.map((s) => jamais(s.id)),
    ),
    'GET /api/machines/fournisseurs': json(200, FOURNISSEURS),
    'GET /api/servers': json(200, servers),
    'GET /api/servers/status': json(
      200,
      servers.map((s) => etat({ serverId: s.id })),
    ),
    'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
    ...routes,
  });

test('D151 : l’entrée Machines de la barre est active ; Ajouter une machine ouvre la création', async () => {
  ouvrir();
  await waitFor(() => expect(node('machines.entete.titre')?.textContent).toBe('Machines'));
  const lien = document.querySelector('[data-node$=".barre.nav-machines"]');
  expect(lien?.getAttribute('aria-current')).toBe('page');
  expect(lien?.getAttribute('href')).toBe('/machines');
  expect(document.querySelector('[data-node$=".barre.nav-serveurs"]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter une machine' }));
  await waitFor(() => expect(cheminCourant()).toBe('/serveurs/nouveau'));
});

test('D152 : Ton cockpit, mode host inactif, le Mac seul et aucun bouton d’appareil (31.9 : l’interrupteur seul)', async () => {
  ouvrir();
  await waitFor(() => expect(node('machines.cockpit.mode')?.textContent).toBe('Mode host inactif'));
  expect(node('machines.cockpit.phrase')?.textContent).toContain('127.0.0.1');
  expect(node('machines.cockpit.appareils')?.querySelectorAll('li')).toHaveLength(1);
  expect(node('machines.cockpit.appareil-local')?.textContent).toContain('Héberge le cockpit');
  expect(
    [...(node('machines.cockpit')?.querySelectorAll('button') ?? [])].map((b) => b.dataset.node),
  ).toEqual(['host.interrupteur']);
});

test('D157 : la carte du Mac, agents et versions, reprise, mémoire, sessions actives', async () => {
  ouvrir(
    {},
    [],
    [
      agent({ id: 'ag_1', kind: 'claude', transport: 'stream', status: 'working' }),
      agent({ id: 'ag_2', kind: 'shell', status: 'working' }),
      agent({ id: 'ag_3', kind: 'codex', transport: 'stream', status: 'stopped' }),
    ],
  );
  await waitFor(() =>
    expect(node('machines.machine-local.agents')?.textContent).toContain('claude 2.1.0'),
  );
  expect(node('machines.machine-local.agents')?.textContent).not.toContain('codex');
  expect(node('machines.machine-local.etat')?.textContent).toBe('Disponible');
  expect(node('machines.machine-local.sessions')?.textContent).toBe('1 session active');
  expect(node('machines.machine-local.acces')?.textContent).toContain('daemon local');
  expect(node('machines.machine-local.reprise')?.textContent).toContain('session persistante');
  expect(node('machines.machine-local.memoire')?.textContent).toContain('12,3 Go · mesurée à');
});

test('D157 : un Mac en PTY, sans mesure de mémoire', async () => {
  ouvrir({ 'GET /api/machines/local': json(200, local({ transport: 'pty', memoire: null })) });
  await waitFor(() =>
    expect(node('machines.machine-local.reprise')?.textContent).toBe(
      'Reprisesans reprise (terminal)',
    ),
  );
  expect(node('machines.machine-local.memoire')?.textContent).toBe('Mémoire libre[non mesuré]');
});

test('D157 : un serveur jamais diagnostiqué ; Diagnostiquer, puis versions, mémoire et liste relue', async () => {
  const h = ouvrir({}, [serveur()]);
  const id = 'machines.machine-srv_1';
  await waitFor(() => expect(node(`${id}.agents`)?.textContent).toContain('Jamais diagnostiqué'));
  expect(node(`${id}.latence`)?.textContent).toBe('285 ms');
  expect(node(`${id}.acces`)?.textContent).toContain('alias SSH vps');
  expect(node(`${id}.memoire`)?.textContent).toContain('[non mesuré]');

  h.respond.set(
    'POST /api/machines/serveurs/srv_1/diagnostic',
    () =>
      new Response(
        JSON.stringify({
          serverId: 'srv_1',
          test: essai(true),
          versions: { claude: '2.0.9' },
          memoire: { octets: 3 * 1024 ** 3, mesureA: MESURE },
          mesureA: MESURE,
        } satisfies MachineServeur),
      ),
  );
  h.respond.set('GET /api/servers', json(200, [serveur({ detectedAgents: ['claude'] })]));
  const lectures = () => h.calls.filter((c) => c.url === '/api/servers').length;
  const avant = lectures();
  fireEvent.click(node(`${id}.diagnostiquer`)!);
  await waitFor(() => expect(node(`${id}.agents`)?.textContent).toContain('claude 2.0.9'));
  expect(lectures()).toBeGreaterThan(avant);
  expect(node(`${id}.memoire`)?.textContent).toContain('3,0 Go');
  expect(node(`${id}.reprise`)?.textContent).toContain('session persistante');
  expect(node(`${id}.blocage`)).toBeNull();
});

test('D157 : un diagnostic en échec dit où il bloque', async () => {
  ouvrir(
    {
      'GET /api/machines/serveurs': json(200, [{ ...jamais(), test: essai(false) }]),
    },
    [serveur({ detectedAgents: [] })],
  );
  await waitFor(() =>
    expect(node('machines.machine-srv_1.blocage')?.textContent).toBe(
      'Agents détectés : aucun agent (claude, codex, cursor) dans le PATH du shell distant',
    ),
  );
  expect(node('machines.machine-srv_1.agents')?.textContent).toContain('Aucun agent');
});

test('Configurer et Ouvrir une discussion mènent aux écrans du serveur', async () => {
  ouvrir({}, [serveur()]);
  await waitFor(() => expect(node('machines.machine-srv_1.configurer')).not.toBeNull());
  fireEvent.click(node('machines.machine-srv_1.configurer')!);
  await waitFor(() => expect(cheminCourant()).toBe('/serveurs/srv_1/configuration'));
});

test('Ouvrir une discussion ouvre la discussion du serveur', async () => {
  ouvrir({}, [serveur()]);
  await waitFor(() => expect(node('machines.machine-srv_1.discussion')).not.toBeNull());
  fireEvent.click(node('machines.machine-srv_1.discussion')!);
  await waitFor(() => expect(cheminCourant()).toBe('/serveurs/srv_1/discussion'));
});

// Chantier 29.6 : la matrice des combinaisons (D158) et les fournisseurs (D159).

const ligne = (id: string) => `machines.combinaisons.ligne-${id}`;

test('D158 : une ligne par agent piloté et par machine, marques et état, filtre par machine', async () => {
  ouvrir({}, [serveur({ detectedAgents: ['claude', 'cursor'] })]);
  await waitFor(() => expect(node(`${ligne('local:claude')}.etat`)?.textContent).toBe('Prêt'));
  expect(node(`${ligne('local:claude')}.images`)?.textContent).toBe('✓');
  expect(node(`${ligne('local:claude')}.distant`)?.textContent).toBe('✓');
  expect(node(`${ligne('local:claude')}.conso`)?.textContent).toBe('–');
  expect(node(`${ligne('local:codex')}.etat`)?.textContent).toBe('Agent non détecté');
  expect(node(`${ligne('srv_1:claude')}.images`)?.textContent).toBe('–');
  expect(node(`${ligne('srv_1:claude')}.etat`)?.textContent).toBe('Prêt, limité');
  expect(node(`${ligne('srv_1:cursor')}.etat`)?.textContent).toBe('Détecté, non piloté par A-I-D');
  expect(node('machines.combinaisons.table')?.querySelectorAll('tbody tr')).toHaveLength(5);

  fireEvent.click(node('machines.combinaisons.filtre-srv_1')!);
  expect(node('machines.combinaisons.filtre-srv_1')?.getAttribute('aria-pressed')).toBe('true');
  expect(node('machines.combinaisons.table')?.querySelectorAll('tbody tr')).toHaveLength(3);
  expect(node(ligne('local:claude'))).toBeNull();
  fireEvent.click(node('machines.combinaisons.filtre-local')!);
  expect(node('machines.combinaisons.table')?.querySelectorAll('tbody tr')).toHaveLength(2);
});

test('D158 : un serveur jamais diagnostiqué est à tester, en ?', async () => {
  ouvrir({}, [serveur()]);
  await waitFor(() => expect(node(`${ligne('srv_1:codex')}.etat`)?.textContent).toBe('À tester'));
  expect(node(`${ligne('srv_1:codex')}.outils`)?.textContent).toBe('?');
  expect(node(`${ligne('srv_1:codex')}.distant`)?.textContent).toBe('–');
});

test('D159 : les fournisseurs, l’accès à l’usage en ambre, l’alerte et sa marche à suivre', async () => {
  const f: Fournisseurs = {
    fournisseurs: [
      {
        id: 'anthropic',
        nom: 'Anthropic',
        agent: 'claude',
        acces: "Clé API · facturation à l'usage",
        usage: true,
        secret: "Clé en clair dans l'environnement",
        alerte: 'env:ANTHROPIC_API_KEY',
      },
      {
        id: 'ollama',
        nom: 'Ollama',
        agent: null,
        acces: 'Endpoint local · sans clé · recherche de la mémoire',
        usage: false,
        secret: 'Aucun secret',
        alerte: null,
      },
    ],
    alertes: [
      {
        id: 'env:ANTHROPIC_API_KEY',
        titre: "ANTHROPIC_API_KEY dans l'environnement du daemon",
        etapes: ['Retire la ligne.', 'Relance le daemon.'],
      },
    ],
  };
  ouvrir({ 'GET /api/machines/fournisseurs': json(200, f) });
  const acces = 'machines.fournisseur-anthropic.acces';
  await waitFor(() => expect(node(acces)?.getAttribute('data-usage')).toBe('true'));
  expect(node('machines.fournisseur-ollama.secret')?.textContent).toBe('Aucun secret');
  // l'accès du fournisseur passe dans la matrice
  expect(node(ligne('local:claude'))?.textContent).toContain("Clé API · facturation à l'usage");
  const alerte = 'machines.alerte-env:ANTHROPIC_API_KEY';
  expect(node(alerte)?.textContent).toContain("ANTHROPIC_API_KEY dans l'environnement du daemon");
  expect(node(`${alerte}.etapes`)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Comment la déplacer' }));
  expect(node(`${alerte}.etapes`)?.querySelectorAll('li')).toHaveLength(2);
});
