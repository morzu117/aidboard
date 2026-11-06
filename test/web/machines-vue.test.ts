import { expect, test } from 'vitest';
import { agentOptions } from '../../src/shared/agentSettings.js';
import type { MachineLocale, Server, ServerTest } from '../../src/shared/model.js';
import {
  accesDe,
  agentsDeLaCarte,
  blocage,
  combinaisons,
  filtrer,
  libelleMemoire,
  repriseServeur,
} from '../../web/src/ui/machinesVue.js';

// Chantier 29 (D157, D158) : les cases des cartes et la matrice des combinaisons.

const local = (over: Partial<MachineLocale> = {}): MachineLocale => ({
  agents: [
    { kind: 'claude', trouve: true, version: '2.1.0', options: agentOptions('claude', []) },
    { kind: 'codex', trouve: false, version: null, options: agentOptions('codex', []) },
  ],
  transport: 'stream',
  memoire: { octets: 12.34 * 1024 ** 3, mesureA: '2026-11-06T10:00:00.000Z' },
  mesureA: '2026-11-06T10:00:00.000Z',
  ...over,
});

const serveur = (over: Partial<Server> = {}): Server =>
  ({
    id: 'sv_1',
    name: 'vps',
    mode: 'ssh_alias',
    target: 'vps',
    detectedAgents: null,
    ...over,
  }) as Server;

const test5 = (session: ServerTest['steps'][number]['state'], ok: boolean | null): ServerTest => ({
  serverId: 'sv_1',
  startedAt: '',
  finishedAt: '',
  ok,
  error: ok === false ? 'aucun agent' : null,
  raw: '',
  steps: [
    { id: 'shell', label: 'Shell distant ouvert', state: 'ok', durationMs: 1, detail: null },
    {
      id: 'agents',
      label: 'Agents détectés',
      state: ok === false ? 'failed' : 'ok',
      durationMs: 1,
      detail: ok === false ? 'aucun agent' : null,
    },
    { id: 'session', label: 'Session', state: session, durationMs: 1, detail: null },
  ],
});

test('mémoire en Go à une décimale, ou non mesurée', () => {
  expect(libelleMemoire(local().memoire)).toBe('12,3 Go');
  expect(libelleMemoire(null)).toBe('[non mesuré]');
});

test('accès d’un serveur selon son mode', () => {
  expect(accesDe({ mode: 'ssh_alias', target: 'vps' })).toBe('alias SSH vps');
  expect(accesDe({ mode: 'ssh_host', target: 'ovh.example' })).toBe('SSH ovh.example');
});

test('agents d’une carte : jamais diagnostiqué, aucun, ou avec leurs versions', () => {
  expect(agentsDeLaCarte(null, null)).toBe('Jamais diagnostiqué');
  expect(agentsDeLaCarte([], null)).toBe('Aucun agent');
  expect(agentsDeLaCarte(['claude', 'codex'], { claude: '2.1.0', codex: null })).toBe(
    'claude 2.1.0 · codex',
  );
});

test('reprise d’un serveur d’après l’étape session, et où le test bloque', () => {
  expect(repriseServeur(null)).toBe('[non mesuré]');
  expect(repriseServeur(test5('ok', true))).toBe('session persistante');
  expect(repriseServeur(test5('failed', false))).toBe('sans tmux');
  expect(repriseServeur(test5('skipped', true))).toBe('session désactivée');
  expect(repriseServeur(test5('skipped', false))).toBe('[non mesuré]');
  expect(blocage(test5('skipped', false))).toBe('Agents détectés : aucun agent');
  expect(blocage(test5('ok', true))).toBeNull();
});

test('le Mac : claude prêt, codex non détecté', () => {
  const l = combinaisons({ local: local(), serveurs: [], fournisseurs: null });
  expect(l.map((x) => [x.agent, x.machine, x.etat])).toEqual([
    ['claude', 'Mac local', 'Prêt'],
    ['codex', 'Mac local', 'Agent non détecté'],
  ]);
  expect(l[0]!.marques.images).toBe('✓');
  expect(l[0]!.marques.conso).toBe('–');
  expect(Object.values(l[1]!.marques).every((m) => m === '–')).toBe(true);
  expect(l[0]!.fournisseur).toBe('Anthropic');
  expect(l[0]!.acces).toBe('Identifiants gérés par le CLI');
});

test('le Mac en PTY : prêt, limité', () => {
  const l = combinaisons({ local: local({ transport: 'pty' }), serveurs: [], fournisseurs: null });
  expect(l[0]!.etat).toBe('Prêt, limité');
  expect(l[0]!.marques.reprise).toBe('–');
});

test('un serveur jamais diagnostiqué : à tester, en ?', () => {
  const l = combinaisons({
    local: null,
    serveurs: [{ server: serveur(), diagnostic: null }],
    fournisseurs: null,
  });
  expect(l.map((x) => x.etat)).toEqual(['À tester', 'À tester']);
  expect(l[0]!.marques.outils).toBe('?');
  expect(l[0]!.marques.images).toBe('–');
});

test('un serveur diagnostiqué : images absentes, cursor non piloté', () => {
  const s = serveur({ detectedAgents: ['claude', 'cursor'] });
  const l = combinaisons({
    local: null,
    serveurs: [{ server: s, diagnostic: null }],
    fournisseurs: null,
  });
  expect(l.map((x) => [x.agent, x.etat])).toEqual([
    ['claude', 'Prêt, limité'],
    ['codex', 'Agent non détecté'],
    ['cursor', 'Détecté, non piloté par A-I-D'],
  ]);
  expect(l[0]!.marques.distant).toBe('✓');
  expect(l[2]!.modele).toBe('—');
});

test('l’accès vient des fournisseurs, et le filtre par machine', () => {
  const l = combinaisons({
    local: local(),
    serveurs: [{ server: serveur({ detectedAgents: ['claude'] }), diagnostic: null }],
    fournisseurs: {
      alertes: [],
      fournisseurs: [
        {
          id: 'anthropic',
          nom: 'Anthropic',
          agent: 'claude',
          acces: 'Abonnement · claude CLI',
          usage: false,
          secret: 'Identifiants gérés par le CLI',
          alerte: null,
        },
      ],
    },
  });
  expect(l[0]!.acces).toBe('Abonnement · claude CLI');
  expect(filtrer(l, 'toutes')).toHaveLength(4);
  expect(filtrer(l, 'local').map((x) => x.agent)).toEqual(['claude', 'codex']);
  expect(filtrer(l, 'sv_1').map((x) => x.machine)).toEqual(['vps', 'vps']);
});
