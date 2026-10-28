import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { resolvePaths } from '../src/daemon/paths.js';
import { gracefulInterrupt, resumeFromManifest } from '../src/daemon/pty/reprise.js';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

const BIN = join(import.meta.dirname, 'fixtures/bin');
const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };
let c: Ctx | undefined;

afterEach(async () => {
  process.env.PATH = saved.PATH;
  process.env.SHELL = saved.SHELL;
  await c?.t.d.stop();
  c = undefined;
});

async function spawn(kind: 'claude' | 'shell') {
  process.env.PATH = `${BIN}${delimiter}${saved.PATH}`;
  process.env.SHELL = '/bin/sh';
  // D63/A.6 : le défaut est passé à `stream` ; ce fichier vise le chemin PTY (résumé, manifeste).
  c = await setupWorkspace({ config: { agents: { transport: 'pty' } } });
  const topic = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind });
  const live = c.t.d.agents.get(agent.id)!;
  if (kind === 'claude')
    await waitFor(() => live.mirror.screen().some((l) => l.includes('PRÊT')), 5000, 'PRÊT');
  return { agent, live, topic };
}

test('gracefulInterrupt demande un résumé à un agent claude avant de l’arrêter, et le récupère', async () => {
  const { agent, topic } = await spawn('claude');
  const entries = await gracefulInterrupt(c!.t.d.agents, 5000);
  expect(entries).toEqual([
    { topicId: topic.topicId, kind: 'claude', path: `/tmp/aid-reprise-${topic.topicId}.md` },
  ]);
  expect(readFileSync(entries[0]!.path, 'utf8')).toContain('résumé de test');
  expect(c!.t.d.agents.get(agent.id)!.exited).toBe(true);
});

test('gracefulInterrupt arrête un shell directement, sans lui demander de résumé', async () => {
  const { agent } = await spawn('shell');
  const entries = await gracefulInterrupt(c!.t.d.agents, 2000);
  expect(entries).toEqual([]);
  expect(c!.t.d.agents.get(agent.id)!.exited).toBe(true);
});

test('resumeFromManifest relance un sujet et lui injecte le résumé laissé par le cycle précédent', async () => {
  const { agent: previous, topic } = await spawn('claude');
  const paths = resolvePaths(c!.t.home);
  const reprisePath = `/tmp/aid-reprise-${topic.topicId}-test.md`;
  writeFileSync(reprisePath, 'reprendre-le-travail-en-cours\n');
  writeFileSync(
    paths.repriseJson,
    JSON.stringify([{ topicId: topic.topicId, kind: 'claude', path: reprisePath }]),
  );

  await resumeFromManifest(c!.t.d.agents, paths);

  const resumed = await waitFor(
    () =>
      c!.t.d.agents.liveAgents().find((a) => a.topicId === topic.topicId && a.id !== previous.id),
    5000,
    'agent relancé',
  );
  let out = '';
  resumed.subscribe((chunk) => (out += chunk));
  await waitFor(() => out.includes('reprendre-le-travail-en-cours'), 5000, 'contenu repris');
});

// Préparation propre à Swairm : l'ancien helper conversationnel reste inchangé.
async function spawnSwairm() {
  c = await setupWorkspace({
    config: { swairm: { bin: join(import.meta.dirname, 'fixtures/fake-swairm.sh') } },
  });
  const topic = await makeTopic(c);
  const inputLog = join(c.t.home, 'swairm-input.log');
  const previousLog = process.env.FAKE_SWAIRM_INPUT_LOG;
  process.env.FAKE_SWAIRM_INPUT_LOG = inputLog;
  try {
    const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'swairm-cell' });
    const live = c.t.d.agents.get(agent.id)!;
    await waitFor(
      () => live.mirror.screen().some((l) => l.includes('swairm>')),
      5000,
      'invite Swairm',
    );
    return { agent, live, topic, inputLog };
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_SWAIRM_INPUT_LOG;
    else process.env.FAKE_SWAIRM_INPUT_LOG = previousLog;
  }
}

test('gracefulInterrupt : Swairm arrêté avec daemon_stop, sans input ni entrée de manifeste', async () => {
  const { live, inputLog } = await spawnSwairm();
  const { vi } = await import('vitest');
  const input = vi.spyOn(c!.t.d.agents, 'input');
  try {
    expect(await gracefulInterrupt(c!.t.d.agents, 2000)).toEqual([]);
    expect(input).not.toHaveBeenCalled();
    expect(live.exited).toBe(true);
    expect(live.exit).toMatchObject({ reason: 'daemon_stop', exitCode: 0 });
    expect(readFileSync(inputLog, 'utf8')).toBe('');
  } finally {
    input.mockRestore();
  }
});

test('resumeFromManifest : une entrée Swairm fabriquée est ignorée sans spawn ni input', async () => {
  const { agent, topic, inputLog } = await spawnSwairm();
  await c!.t.d.agents.stop(agent.id, 'daemon_stop');
  const paths = resolvePaths(c!.t.home);
  const summary = join(c!.t.home, 'swairm-summary.md');
  writeFileSync(summary, 'ne jamais injecter ce résumé');
  writeFileSync(
    paths.repriseJson,
    JSON.stringify([{ topicId: topic.topicId, kind: 'swairm-cell', path: summary }]),
  );
  const { vi } = await import('vitest');
  const spawnSpy = vi.spyOn(c!.t.d.agents, 'spawn');
  const input = vi.spyOn(c!.t.d.agents, 'input');
  try {
    await resumeFromManifest(c!.t.d.agents, paths);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(c!.t.d.agents.liveAgents()).toEqual([]);
    expect(readFileSync(inputLog, 'utf8')).toBe('');
  } finally {
    spawnSpy.mockRestore();
    input.mockRestore();
  }
});
