import { delimiter, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { estimate, lastLine, promptDetected } from '../src/daemon/pty/heuristic.js';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

const BIN = join(import.meta.dirname, 'fixtures/bin');
const saved = { PATH: process.env.PATH };
let c: Ctx | undefined;
afterEach(async () => {
  process.env.PATH = saved.PATH;
  await c?.t.d.stop();
  c = undefined;
});

const ASK = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', ''];

test('estimation : sortie récente, silence, invite', () => {
  expect(estimate(1000, ['● Write a.ts'], null)).toEqual({
    status: 'working',
    promptDetected: false,
    lastLine: '● Write a.ts',
  });
  // pas de changement : rien à émettre
  expect(estimate(1000, ['x'], 'working')).toBeNull();
  // entre 5 et 30 s sans invite : on ne sait pas, on garde
  expect(estimate(12_000, ['x'], 'working')).toBeNull();
  expect(estimate(30_000, ['x', '$ '], 'working')).toMatchObject({ status: 'idle', lastLine: '$' });
  // une invite affichée depuis 3 s : attend une réponse
  expect(estimate(2000, ASK, 'working')).toBeNull();
  expect(estimate(3500, ASK, 'working')).toMatchObject({
    status: 'needs_input',
    promptDetected: true,
  });
  expect(estimate(60_000, ASK, 'needs_input')).toBeNull();
});

test('motifs d’invite reconnus, et pas sur une ligne ordinaire', () => {
  for (const l of [
    'Continuer ? (y/n)',
    'Overwrite? [Y/n]',
    '  ❯ 1. Yes',
    '› 1. Approve',
    'Do you want to make this edit to a.ts?',
  ])
    expect(promptDetected([l]), l).toBe(true);
  for (const l of ['1. Ajouter le test', 'Pourquoi ?', '> npm test'])
    expect(promptDetected([l]), l).toBe(false);
  expect(lastLine(['a', '  b  ', '', ''])).toBe('b');
});

async function spawnFakeClaude() {
  process.env.PATH = `${BIN}${delimiter}${saved.PATH}`;
  c = await setupWorkspace();
  const topic = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'claude' });
  const live = c.t.d.agents.get(agent.id)!;
  await waitFor(() => live.mirror.screen().some((l) => l.includes('PRÊT')), 5000, 'PRÊT');
  const estimates = () =>
    c!.t.store.since(null).filter((e) => e.type === 'agent.status' && e.agentId === agent.id);
  const status = () =>
    c!.t.db.prepare('SELECT status, status_source FROM agents WHERE id = ?').get(agent.id) as {
      status: string;
      status_source: string;
    };
  return { agent, live, estimates, status };
}

test('un claude sans hooks : en cours, puis inactif, puis attend, estimés et seulement aux transitions', async () => {
  const { live, estimates, status } = await spawnFakeClaude();
  const t0 = live.lastOutputAt;
  c!.t.d.agents.tickHeuristic(t0 + 1000);
  c!.t.d.agents.tickHeuristic(t0 + 1500);
  expect(estimates()).toHaveLength(1);
  expect(status()).toEqual({ status: 'working', status_source: 'heuristic' });

  c!.t.d.agents.tickHeuristic(t0 + 31_000);
  expect(estimates().at(-1)!.data).toMatchObject({
    status: 'idle',
    silenceMs: 31_000,
    lastLine: 'PRÊT',
    promptDetected: false,
  });

  live.pty.write('ask\r');
  await waitFor(() => live.mirror.screen().some((l) => l.includes('1. Yes')), 5000, 'invite');
  c!.t.d.agents.tickHeuristic(live.lastOutputAt + 3500);
  expect(status().status).toBe('needs_input');
  expect(estimates().at(-1)!.data).toMatchObject({ reason: 'question', promptDetected: true });
});

test('dès qu’un hook parle, l’heuristique se tait ; un agent en pause n’est pas estimé', async () => {
  const { agent, live, estimates } = await spawnFakeClaude();
  c!.t.store.append({
    source: 'daemon',
    type: 'agent.status',
    agentId: agent.id,
    data: { paused: true },
  });
  c!.t.d.agents.tickHeuristic(live.lastOutputAt + 60_000);
  expect(estimates().filter((e) => e.source === 'heuristic')).toHaveLength(0);
  c!.t.store.append({
    source: 'daemon',
    type: 'agent.status',
    agentId: agent.id,
    data: { paused: false },
  });
  c!.t.store.append({
    source: 'hook:claude',
    type: 'agent.status',
    agentId: agent.id,
    data: { status: 'working' },
  });
  c!.t.d.agents.tickHeuristic(live.lastOutputAt + 60_000);
  expect(estimates().filter((e) => e.source === 'heuristic')).toHaveLength(0);
});

test('un shell n’est jamais estimé', async () => {
  c = await setupWorkspace();
  const topic = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'shell' });
  c.t.d.agents.tickHeuristic(Date.now() + 60_000);
  expect(
    c.t.store.since(null).filter((e) => e.type === 'agent.status' && e.agentId === agent.id),
  ).toHaveLength(0);
});
