import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  c = await setupWorkspace();
  const topic = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind });
  const live = c.t.d.agents.get(agent.id)!;
  if (kind === 'claude')
    await waitFor(() => live.mirror.screen().some((l) => l.includes('PRÊT')), 5000, 'PRÊT');
  return { agent, live, topic };
}

test('gracefulInterrupt demande un résumé à un agent claude avant de l’arrêter, et le récupère', async () => {
  const { agent, topic } = await spawn('claude');
  const entries = await gracefulInterrupt(c!.t.d.agents, resolvePaths(c!.t.home).reprise, 5000);
  expect(entries).toEqual([
    {
      topicId: topic.topicId,
      kind: 'claude',
      path: join(resolvePaths(c!.t.home).reprise, `aid-reprise-${topic.topicId}.md`),
    },
  ]);
  expect(readFileSync(entries[0]!.path, 'utf8')).toContain('résumé de test');
  expect(c!.t.d.agents.get(agent.id)!.exited).toBe(true);
});

test('gracefulInterrupt arrête un shell directement, sans lui demander de résumé', async () => {
  const { agent } = await spawn('shell');
  const entries = await gracefulInterrupt(c!.t.d.agents, resolvePaths(c!.t.home).reprise, 2000);
  expect(entries).toEqual([]);
  expect(c!.t.d.agents.get(agent.id)!.exited).toBe(true);
});

test('resumeFromManifest relance un sujet et lui injecte le résumé laissé par le cycle précédent', async () => {
  const { agent: previous, topic } = await spawn('claude');
  const paths = resolvePaths(c!.t.home);
  const reprisePath = join(paths.reprise, `aid-reprise-${topic.topicId}-test.md`);
  mkdirSync(paths.reprise, { recursive: true });
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

test('resumeFromManifest ignore et ne supprime jamais un chemin hors du dossier de reprise', async () => {
  const { topic } = await spawn('claude');
  const paths = resolvePaths(c!.t.home);
  const autre = join(c!.t.home, 'precieux.md');
  writeFileSync(autre, 'ne pas toucher');
  writeFileSync(
    paths.repriseJson,
    JSON.stringify([{ topicId: topic.topicId, kind: 'claude', path: autre }]),
  );
  const avant = c!.t.d.agents.liveAgents().length;
  await resumeFromManifest(c!.t.d.agents, paths);
  expect(existsSync(autre)).toBe(true);
  expect(c!.t.d.agents.liveAgents()).toHaveLength(avant);
});
