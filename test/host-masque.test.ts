import { expect, test } from 'vitest';
import { etatPourAppareil, raisonAppareil } from '../src/daemon/host/masque.js';
import type { StateSnapshot } from '../src/shared/state.js';

// Chantier 31 (D175) : l'état d'un appareil, par liste d'autorisation. Chaque champ texte du
// snapshot porte un marqueur ; ceux des champs interdits ne doivent jamais sortir.

const M = (champ: string) => `marqueur-${champ}-7f3a`;

function snapshot(): StateSnapshot {
  return {
    lastEventId: 'ev_1',
    workspaces: [
      {
        id: 'ws_1',
        name: 'Projet',
        root: M('root'),
        remote: M('remote'),
        baseBranch: M('baseBranch'),
        worktreesDir: M('worktreesDir'),
        namespace: M('namespace'),
        createdAt: 't0',
      },
    ],
    topics: [
      {
        id: 'tp_1',
        workspaceId: 'ws_1',
        slug: 'sujet',
        title: 'Titre de Julien',
        type: 'feat',
        branch: 'feat/sujet',
        base: M('base'),
        worktree: M('worktree'),
        state: 'active',
        phase: 'dev',
        indexState: 'ready',
        index: { engine: 'codegraph', state: 'ready', detail: M('index') } as never,
        worktreeMissing: false,
        prNumber: 12,
        prUrl: M('prUrl'),
        stashRef: M('stashRef'),
        createdAt: 't0',
        updatedAt: 't1',
      },
    ],
    runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't0' }],
    agents: [
      {
        id: 'ag_1',
        runId: 'run_1',
        kind: 'claude',
        role: 'dev',
        transport: 'stream',
        status: 'needs_input',
        cwd: M('cwd'),
        command: [M('command')],
        pid: 4242,
        sessionId: M('sessionId'),
        exitCode: null,
        issue: null,
        statusReason: M('statusReason'),
        statusMessage: M('statusMessage'),
        statusSource: 'hook',
        statusAt: 't2',
        statusDetail: { lastLine: M('statusDetail') } as never,
        lastTool: M('lastTool'),
        pending: { id: 'p', kind: 'question', question: M('pending') } as never,
        pausedAt: null,
        permissionMode: 'default',
        model: M('model'),
        effort: M('effort'),
        createdAt: 't0',
        updatedAt: 't2',
      },
    ],
    actions: [
      {
        id: 'ac_1',
        topicId: 'tp_1',
        workspaceId: 'ws_1',
        action: M('action'),
        state: 'succeeded',
        exitCode: 0,
        result: { sortie: M('result') },
        startedAt: 't0',
        finishedAt: 't1',
      },
    ],
    agentTransport: 'stream',
    swairm: { enabled: true },
    mesh: {
      state: {
        connected: true,
        tailscale: 'running',
        monitor: 'running',
        pending: 1,
        since: 't0',
        cell: 'cellule',
      },
      inbox: [
        {
          id: 91000,
          threadId: M('threadId'),
          from: 'pair',
          to: M('to'),
          kind: 'question',
          content: M('content'),
          createdAt: 't0',
          replyTo: 1,
          obligationId: M('obligationId'),
          seenAt: null,
          decidedAt: 't1',
        },
      ],
      tailscaleManage: false,
      checkedAt: 't0',
    },
  };
}

test('31.7 (D175) : aucun marqueur d’un champ interdit ne sort', () => {
  const sortie = JSON.stringify(etatPourAppareil(snapshot()));
  expect(sortie).not.toContain('marqueur-');
  expect(sortie).not.toContain('4242');
});

test('31.7 (D175) : les clés de sortie sont exactement celles de la liste', () => {
  const e = etatPourAppareil(snapshot());
  expect(Object.keys(e).sort()).toEqual([
    'actions',
    'agents',
    'lastEventId',
    'mesh',
    'runs',
    'topics',
    'workspaces',
  ]);
  expect(Object.keys(e.workspaces[0]!).sort()).toEqual(['id', 'name']);
  expect(Object.keys(e.topics[0]!).sort()).toEqual([
    'branch',
    'createdAt',
    'id',
    'phase',
    'prNumber',
    'slug',
    'state',
    'title',
    'type',
    'updatedAt',
    'workspaceId',
  ]);
  expect(Object.keys(e.runs[0]!).sort()).toEqual(['createdAt', 'id', 'state', 'topicId']);
  expect(Object.keys(e.actions[0]!).sort()).toEqual([
    'finishedAt',
    'id',
    'startedAt',
    'state',
    'topicId',
  ]);
  expect(Object.keys(e.agents[0]!).sort()).toEqual([
    'attend',
    'createdAt',
    'id',
    'kind',
    'pausedAt',
    'role',
    'runId',
    'status',
    'statusAt',
    'statusReason',
    'transport',
    'updatedAt',
  ]);
  expect(Object.keys(e.mesh!).sort()).toEqual(['inbox', 'state']);
  expect(Object.keys(e.mesh!.state).sort()).toEqual([
    'cell',
    'connected',
    'monitor',
    'pending',
    'since',
    'tailscale',
  ]);
  expect(Object.keys(e.mesh!.inbox[0]!).sort()).toEqual([
    'createdAt',
    'from',
    'id',
    'kind',
    'seenAt',
  ]);
});

test('31.7 (D175) : attend remplace pending ; les valeurs gardées sont celles du snapshot', () => {
  const e = etatPourAppareil(snapshot());
  expect(e.agents[0]).toMatchObject({ status: 'needs_input', attend: true, statusReason: 'autre' });
  expect(e.topics[0]).toMatchObject({
    title: 'Titre de Julien',
    branch: 'feat/sujet',
    prNumber: 12,
  });
  const sans = snapshot();
  sans.agents[0]!.pending = null;
  delete sans.mesh;
  const e2 = etatPourAppareil(sans);
  expect(e2.agents[0]!.attend).toBe(false);
  expect('mesh' in e2).toBe(false);
});

test('31.7 (D175) : statusReason ramené à permission, question, sinon autre', () => {
  expect(raisonAppareil('permission')).toBe('permission');
  expect(raisonAppareil('question')).toBe('question');
  expect(raisonAppareil(null)).toBeNull();
  for (const r of ['', 'Permission', 'question ', 'lis /etc/passwd', 'permission_prompt']) {
    expect(raisonAppareil(r), r).toBe('autre');
  }
});

test('31.7 (D175) : un champ ajouté plus tard au snapshot ne sort pas', () => {
  const s = snapshot() as StateSnapshot & { nouveau: string };
  s.nouveau = M('nouveau');
  (s.agents[0] as unknown as Record<string, unknown>).nouveauChamp = M('nouveauChamp');
  (s.topics[0] as unknown as Record<string, unknown>).nouveauChamp = M('nouveauChamp');
  expect(JSON.stringify(etatPourAppareil(s))).not.toContain('marqueur-');
});
