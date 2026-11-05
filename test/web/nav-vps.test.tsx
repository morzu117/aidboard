// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import type {
  Server,
  ServerAgentsSummary,
  ServerStatus,
  ServerTest,
} from '../../src/shared/model.js';
import { etatVps, NavVps } from '../../web/src/ui/NavVps.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

// Chantier 25 (D106) : le bloc VPS de la barre par état, une carte par serveur.

afterEach(cleanup);

const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const n = (rest: string) => `1-1.barre-gauche.${rest}`;
const carte = (id: string, rest = '') => node(n(`vps.serveur-${id}${rest}`));

const serveur = (id: string, over: Partial<Server> = {}): Server => ({
  id,
  name: `vps-${id}`,
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
  color: '#a78bfa',
  detectedAgents: ['claude'],
  lastTestAt: null,
  rules: [],
  createdAt: 't',
  updatedAt: 't',
  ...over,
});

const agents = (over: Partial<ServerAgentsSummary> = {}): ServerAgentsSummary => ({
  vivants: 0,
  suiviCoupe: 0,
  repriseEchouee: 0,
  dernierEvenement: null,
  discussion: null,
  ...over,
});

const statut = (serverId: string, over: Partial<ServerStatus> = {}): ServerStatus => ({
  serverId,
  state: 'connected',
  latencyMs: 12,
  checkedAt: 't',
  reason: null,
  ...over,
});

const open = (servers: Server[], statuses: ServerStatus[]) =>
  setup(<NavVps n={n} />, snapshot(), '/', {
    'GET /api/servers': json(200, servers),
    'GET /api/servers/status': json(200, statuses),
  });

test('D106 : le serveur prime sur ses agents, l’échec de reprise sur le suivi coupé', () => {
  const s = (over: Partial<ServerStatus>) => etatVps(statut('x', over));
  expect(s({})).toBe('connecte');
  expect(s({ state: 'unknown' })).toBe('inconnu');
  expect(s({ state: 'connecting', agents: agents({ suiviCoupe: 1 }) })).toBe('reconnexion');
  expect(s({ state: 'unreachable', agents: agents({ repriseEchouee: 1 }) })).toBe('injoignable');
  expect(s({ state: 'error' })).toBe('injoignable');
  expect(s({ agents: agents({ suiviCoupe: 2, repriseEchouee: 1 }) })).toBe('session-perdue');
  expect(s({ agents: agents({ suiviCoupe: 1 }) })).toBe('suivi-coupe');
});

test('une carte par serveur : connecté, suivi coupé, session perdue, chacun avec son action', async () => {
  open(
    [serveur('a'), serveur('b', { keepSession: false }), serveur('c'), serveur('d')],
    [
      statut('a', { agents: agents({ vivants: 2 }) }),
      statut('b', { latencyMs: null, agents: agents({ vivants: 1 }) }),
      statut('c', { agents: agents({ vivants: 1, suiviCoupe: 1, discussion: 'sd_7' }) }),
      statut('d', { agents: agents({ repriseEchouee: 1, discussion: 'sd_9' }) }),
    ],
  );
  await waitFor(() => expect(carte('a', '.etat')?.textContent).toBe('Connecté'));
  expect(carte('a', '.detail')!.textContent).toBe('12 ms · 2 agents actifs · session persistante');
  expect(carte('b', '.detail')!.textContent).toBe('1 agent actif');
  expect(carte('a', '.action')).toBeNull();
  expect(carte('c', '.etat')!.textContent).toBe('Suivi coupé');
  expect(carte('c', '.detail')!.textContent).toContain('ne le suit plus');
  expect(carte('c', '.action')!.textContent).toBe('Reconnecter');
  expect(carte('c', '.action')!.getAttribute('href')).toBe('/serveurs/c/discussions/sd_7');
  expect(carte('d', '.etat')!.textContent).toBe('Session perdue');
  expect(carte('d', '.action')!.textContent).toBe('Reprendre…');
  expect(carte('d', '.action')!.getAttribute('href')).toBe('/serveurs/d/discussions/sd_9');
  // la carte entière ouvre la discussion du serveur
  expect(carte('a', '.ouvrir')!.getAttribute('href')).toBe('/serveurs/a/discussion');
  expect(screen.getByRole('link', { name: 'VPS' }).getAttribute('href')).toBe('/serveurs');
});

test('injoignable : l’étape du dernier test, « Diagnostiquer » relance le test ; l’éphémère met la carte à jour', async () => {
  const h = open(
    [serveur('a')],
    [statut('a', { state: 'unreachable', latencyMs: null, reason: 'timeout' })],
  );
  await waitFor(() => expect(carte('a', '.etat')?.textContent).toBe('Injoignable'));
  expect(carte('a', '.detail')!.textContent).toBe('timeout');
  await userEvent.click(carte('a', '.action')!);
  expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/servers/a/test')).toBe(true);
  const test: ServerTest = {
    serverId: 'a',
    startedAt: 't',
    finishedAt: 't2',
    ok: false,
    error: 'Connection refused',
    steps: [
      { id: 'ssh', label: 'SSH', state: 'failed', durationMs: 10, detail: 'Connection refused' },
    ],
    raw: '',
  } as unknown as ServerTest;
  act(() => {
    FakeSocket.all.at(-1)!.push({ kind: 'ephemeral', type: 'server.test', test });
  });
  await waitFor(() => expect(carte('a', '.detail')!.textContent).toBe('SSH : Connection refused'));
  act(() => {
    FakeSocket.all.at(-1)!.push({
      kind: 'ephemeral',
      type: 'server.status',
      status: statut('a', { agents: agents({ vivants: 1 }) }),
    });
  });
  await waitFor(() => expect(carte('a', '.etat')!.textContent).toBe('Connecté'));
});

test('aucun serveur : le bloc reste, avec l’ajout', async () => {
  open([], []);
  await waitFor(() => expect(node(n('vps.vide'))?.textContent).toBe('Aucun serveur'));
  expect(node(n('vps.ajouter'))!.getAttribute('href')).toBe('/serveurs/nouveau');
});
