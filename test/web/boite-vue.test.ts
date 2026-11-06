import { expect, test } from 'vitest';
import type { MeshDm } from '../../src/shared/model.js';
import {
  agentsDeLaBoite,
  compterNatures,
  decisionsEnAttente,
  natureAgent,
  natureDm,
} from '../../web/src/ui/boiteVue.js';
import { agent, snapshot, topic } from './helpers.js';

const claude = (over: Parameters<typeof agent>[0] = {}) =>
  agent({ kind: 'claude', transport: 'stream', ...over });

const dm = (over: Partial<MeshDm> & { decidedAt?: string | null } = {}) =>
  ({
    id: 1,
    threadId: null,
    from: 'peer',
    to: 'morzu-mac',
    kind: 'question',
    content: 'x',
    createdAt: 't',
    replyTo: null,
    obligationId: null,
    seenAt: null,
    ...over,
  }) as MeshDm;

test.each([
  ['une question en attente', claude({ status: 'needs_input' }), 'decision'],
  [
    'un tour fini sur une question',
    claude({ status: 'idle', statusReason: 'question' }),
    'decision',
  ],
  ['un tour terminé', claude({ status: 'idle' }), 'relire'],
  ['une sortie en erreur', claude({ status: 'error', exitCode: 1 }), 'relire'],
  ['un agent au travail', claude({ status: 'working' }), 'information'],
  ['un agent qui démarre', claude({ status: 'starting' }), 'information'],
  ['une question suspendue', claude({ status: 'needs_input', pausedAt: 't' }), 'information'],
  ['un agent en veille', claude({ status: 'stopped' }), null],
  ['un shell vivant', agent({ status: 'working' }), null],
] as const)('D136 : %s', (_cas, a, nature) => {
  expect(natureAgent(a)).toBe(nature);
});

test('D137 : un DM vu sort, mis en décision il y passe, sinon il informe', () => {
  expect(natureDm(dm())).toBe('information');
  expect(natureDm(dm({ kind: 'fyi' }))).toBe('information');
  expect(natureDm(dm({ decidedAt: 't' }))).toBe('decision');
  expect(natureDm(dm({ decidedAt: 't', seenAt: 't' }))).toBeNull();
});

test('les agents de la Boîte : sujet connu, filtre par projet', () => {
  const state = snapshot({
    topics: [topic(), topic({ id: 'tp_2', workspaceId: 'ws_2' })],
    runs: [
      { id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'active', createdAt: 't' },
      { id: 'run_2', topicId: 'tp_2', mode: 'standard', state: 'active', createdAt: 't' },
    ],
    agents: [
      claude({ id: 'a', status: 'needs_input' }),
      claude({ id: 'b', runId: 'run_2', status: 'idle' }),
      claude({ id: 'c', runId: 'run_perdu', status: 'needs_input' }),
      claude({ id: 'd', status: 'done' }),
    ],
  });
  expect(agentsDeLaBoite(state).map((e) => [e.agent.id, e.nature])).toEqual([
    ['a', 'decision'],
    ['b', 'relire'],
  ]);
  expect(agentsDeLaBoite(state, 'ws_2').map((e) => e.agent.id)).toEqual(['b']);
});

test('compteurs des filtres', () => {
  expect(compterNatures(['decision', 'relire', 'relire', 'information'])).toEqual({
    tout: 4,
    decision: 1,
    relire: 2,
    information: 1,
  });
});

test('D140 : le compteur de la barre compte les agents en attente et les DM mis en décision', () => {
  const state = snapshot({
    topics: [topic()],
    runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'active', createdAt: 't' }],
    agents: [
      claude({ id: 'a', status: 'needs_input' }),
      claude({ id: 'b', status: 'idle', statusReason: 'question' }),
      claude({ id: 'c', status: 'idle' }),
    ],
    mesh: {
      state: {
        connected: true,
        tailscale: 'running',
        monitor: 'running',
        pending: 0,
        since: null,
        cell: 'morzu-mac',
      },
      inbox: [
        dm({ id: 1, decidedAt: 't' }),
        dm({ id: 2 }),
        dm({ id: 3, decidedAt: 't', seenAt: 't' }),
      ],
      tailscaleManage: false,
    },
  });
  expect(decisionsEnAttente(state)).toBe(3);
});
