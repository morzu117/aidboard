import { delimiter, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { estimate, lastLine, promptDetected } from '../src/daemon/pty/heuristic.js';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';
import { vi } from 'vitest';
import type { IPty } from 'node-pty';
import { getPty } from '../src/daemon/pty/native.js';
import type { LiveAgent } from '../src/daemon/pty/manager.js';

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
  // D63/A.6 : le défaut est passé à `stream` ; ce fichier vise l'heuristique sur le miroir PTY.
  c = await setupWorkspace({ config: { agents: { transport: 'pty' } } });
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

// 14.3 : sorties PTY déterministes, sans lancer le CLI Swairm.
async function spawnHeuristicCell() {
  c = await setupWorkspace({
    config: { swairm: { bin: join(import.meta.dirname, 'fixtures/fake-swairm.sh') } },
  });
  c.t.d.agents.dispose(); // les ticks sont explicitement horodatés dans ces tests
  const topic = await makeTopic(c);
  let output!: (chunk: string) => void;
  let exit!: (event: { exitCode: number }) => void;
  const fakePty = {
    pid: 424242,
    onData(cb: typeof output) {
      output = cb;
      return { dispose() {} };
    },
    onExit(cb: typeof exit) {
      exit = cb;
      return { dispose() {} };
    },
  } as unknown as IPty;
  const spawn = vi.spyOn(getPty(), 'spawn').mockReturnValue(fakePty);
  let agent;
  try {
    agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'swairm-cell' });
  } finally {
    spawn.mockRestore();
  }
  const live = c.t.d.agents.get(agent.id)!;
  const finish = () => {
    if (!live.exited) exit({ exitCode: 0 });
  };
  const emit = async (chunk: string, now: number) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      output(chunk);
    } finally {
      clock.mockRestore();
    }
    // Vider la file d'écriture xterm avant de lire l'écran ou d'estimer.
    await new Promise<void>((resolve) => live.mirror.snapshotThen(() => resolve()));
    expect(live.lastOutputAt).toBe(now);
  };
  const events = () =>
    c!.t.store.since(null).filter((e) => e.type === 'agent.status' && e.agentId === agent.id);
  const tick = (now: number) => c!.t.d.agents.tickHeuristic(now);
  const status = () =>
    c!.t.db.prepare('SELECT status, status_source FROM agents WHERE id = ?').get(agent.id);
  return { agent, live, finish, emit, events, tick, status };
}

test('swairm> : invite ordinaire, seuils inchangés et motif résiduel sur huit lignes non vides', () => {
  const screen = ['swairm> '];
  expect(promptDetected(screen)).toBe(false);
  expect(estimate(0, screen, null)).toEqual({
    status: 'working',
    promptDetected: false,
    lastLine: 'swairm>',
  });
  for (const silence of [5000, 12_000, 29_999])
    expect(estimate(silence, screen, 'working')).toBeNull();
  expect(estimate(30_000, screen, 'working')).toEqual({
    status: 'idle',
    promptDetected: false,
    lastLine: 'swairm>',
  });
  const residual = ['Continuer ? (y/n)', '', ...Array<string>(6).fill('information'), ...screen];
  expect(promptDetected(residual)).toBe(true);
  expect(estimate(30_000, residual, 'working')).toMatchObject({ status: 'needs_input' });
  expect(promptDetected([...residual, 'information'])).toBe(false);
});

test('cell Swairm : transitions estimées, silence, nouvel octet et question à 3 s', async () => {
  const a = await spawnHeuristicCell();
  try {
    const t0 = Date.now();
    await a.emit('swairm> ', t0);
    a.tick(t0);
    expect(a.events()).toHaveLength(1);
    expect(a.events()[0]).toMatchObject({
      source: 'heuristic',
      agentId: a.agent.id,
      data: { status: 'working', silenceMs: 0, lastLine: 'swairm>', promptDetected: false },
    });
    expect(a.status()).toEqual({ status: 'working', status_source: 'heuristic' });
    for (const silence of [1000, 5000, 12_000, 29_999]) a.tick(t0 + silence);
    expect(a.events()).toHaveLength(1);
    a.tick(t0 + 30_000);
    expect(a.events().at(-1)).toMatchObject({
      source: 'heuristic',
      data: { status: 'idle', silenceMs: 30_000, lastLine: 'swairm>', promptDetected: false },
    });
    expect(a.status()).toEqual({ status: 'idle', status_source: 'heuristic' });
    a.tick(t0 + 60_000);
    expect(a.events()).toHaveLength(2);
    await a.emit('x', t0 + 61_000);
    a.tick(t0 + 61_000);
    expect(a.status()).toEqual({ status: 'working', status_source: 'heuristic' });
    expect(a.events()).toHaveLength(3);
    await a.emit('\r\nDo you want to proceed?', t0 + 62_000);
    a.tick(t0 + 64_999);
    expect(a.events()).toHaveLength(3);
    a.tick(t0 + 65_000);
    expect(a.events().at(-1)).toMatchObject({
      source: 'heuristic',
      data: {
        status: 'needs_input',
        reason: 'question',
        silenceMs: 3000,
        lastLine: 'Do you want to proceed?',
        promptDetected: true,
      },
    });
    expect(a.status()).toEqual({ status: 'needs_input', status_source: 'heuristic' });
    a.tick(t0 + 100_000);
    expect(a.events()).toHaveLength(4);
  } finally {
    a.finish();
  }
});

test('cell Swairm : le redessin réinitialise le silence, le motif résiduel prime sur idle', async () => {
  const a = await spawnHeuristicCell();
  try {
    const t0 = Date.now();
    await a.emit('swairm> ', t0);
    a.tick(t0);
    await a.emit('\r\x1b[2Kswairm> ', t0 + 29_000);
    a.tick(t0 + 30_000);
    a.tick(t0 + 58_999);
    expect(a.events()).toHaveLength(1);
    a.tick(t0 + 59_000);
    expect(a.events().at(-1)!.data).toMatchObject({ status: 'idle', silenceMs: 30_000 });
    await a.emit('\r\nContinuer ? (y/n)\r\n\r\ninformation\r\nswairm> ', t0 + 60_000);
    a.tick(t0 + 60_000);
    a.tick(t0 + 90_000);
    expect(a.events().at(-1)!.data).toMatchObject({
      status: 'needs_input',
      silenceMs: 30_000,
      lastLine: 'swairm>',
      promptDetected: true,
    });
  } finally {
    a.finish();
  }
});

test('heuristique : seuls Claude, Codex et la cell Swairm sont admis ; pause, hooks et sortie exclus', async () => {
  const a = await spawnHeuristicCell();
  try {
    const t0 = Date.now();
    await a.emit('swairm> ', t0);
    for (const kind of ['shell', 'swarph-cell', 'swairm-drone', 'swairm-queen']) {
      // Les genres distants ne sont pas lançables en PTY : éprouver la garde défensivement.
      a.live.kind = kind as LiveAgent['kind'];
      a.tick(t0 + 30_000);
      expect(a.events(), kind).toHaveLength(0);
    }
    a.live.kind = 'swairm-cell';
    for (const source of ['daemon', 'hook:claude', 'codex:json'] as const) {
      c!.t.store.append({
        source,
        type: 'agent.status',
        agentId: a.agent.id,
        data: source === 'daemon' ? { paused: true } : { status: 'working' },
      });
      a.tick(t0 + 30_000);
      expect(a.events().filter((e) => e.source === 'heuristic')).toHaveLength(0);
      a.live.paused = false;
      a.live.hooked = false;
    }
    for (const kind of ['claude', 'codex', 'swairm-cell'] as const) {
      a.live.kind = kind;
      a.live.estimated = null;
      a.tick(t0 + 30_000);
      expect(a.events().at(-1)).toMatchObject({ source: 'heuristic', data: { status: 'idle' } });
    }
    expect(a.events().filter((e) => e.source === 'heuristic')).toHaveLength(3);
    a.finish();
    a.tick(t0);
    expect(a.events().filter((e) => e.source === 'heuristic')).toHaveLength(3);
  } finally {
    a.finish();
  }
});
