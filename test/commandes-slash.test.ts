import { delimiter, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  AID_COMMANDS,
  type AgentCommand,
  agentOptions,
  withAidCommands,
} from '../src/shared/agentSettings.js';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

/** Chantier 22 (A.1) : le contrat des commandes `/` et les commandes de claude exposées dans `options`. */
const STREAM_BIN = join(import.meta.dirname, 'fixtures/bin-stream');
const saved = { PATH: process.env.PATH };
let c: Ctx | undefined;

afterEach(async () => {
  process.env.PATH = saved.PATH;
  await c?.t.d.stop();
  c = undefined;
});

const agentCmd = (name: string): AgentCommand => ({
  name,
  description: 'Commande de claude',
  source: 'agent',
});

/** Ce que le faux claude annonce au tour `commandes`, une fois filtré (D83) et fusionné (D82). */
const CLAUDE_ATTENDUES: AgentCommand[] = [
  { name: 'context', description: 'Commande de claude', source: 'agent' },
  { name: 'deep-research', description: 'Skill de claude', source: 'agent' },
  { name: 'databricks:doctor', description: 'Commande de claude', source: 'agent' },
];

test('withAidCommands : celles d’A-I-D d’abord, noms d’A-I-D écartés, doublons retirés, ordre conservé', () => {
  expect(withAidCommands([])).toEqual(AID_COMMANDS);
  const r = withAidCommands([
    agentCmd('zeta'),
    agentCmd('model'),
    agentCmd('alpha'),
    agentCmd('compact'),
    agentCmd('zeta'),
    agentCmd('stop'),
    agentCmd('beta'),
  ]);
  expect(r.slice(0, AID_COMMANDS.length)).toEqual(AID_COMMANDS);
  expect(r.slice(AID_COMMANDS.length)).toEqual([
    agentCmd('zeta'),
    agentCmd('alpha'),
    agentCmd('beta'),
  ]);
  expect(r.filter((x) => x.source === 'agent').map((x) => x.name)).toEqual([
    'zeta',
    'alpha',
    'beta',
  ]);
  // AID_COMMANDS n'est pas modifié au passage
  expect(AID_COMMANDS.map((x) => x.name)).toEqual([
    'model',
    'effort',
    'mode',
    'compact',
    'stop',
    'aide',
  ]);
});

test('agentOptions : sans 3e argument, les seules commandes d’A-I-D ; avec, fusionnées', () => {
  expect(agentOptions('claude', []).commands).toEqual(AID_COMMANDS);
  expect(agentOptions('codex', []).commands).toEqual(AID_COMMANDS);
  expect(agentOptions('claude', [], undefined).commands).toEqual(AID_COMMANDS);
  expect(agentOptions('claude', [], [agentCmd('context'), agentCmd('mode')]).commands).toEqual([
    ...AID_COMMANDS,
    agentCmd('context'),
  ]);
});

async function spawnClaude() {
  process.env.PATH = `${STREAM_BIN}${delimiter}${saved.PATH}`;
  c = await setupWorkspace({ config: { agents: { transport: 'stream' } } });
  const topic = await makeTopic(c);
  const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'claude' });
  await waitFor(
    () =>
      (
        c!.t.db.prepare('SELECT session_id FROM agents WHERE id = ?').get(agent.id) as {
          session_id: string | null;
        }
      ).session_id === agent.sessionId,
    5000,
    'session claude',
  );
  return agent;
}

async function commandsOf(agentId: string): Promise<AgentCommand[]> {
  const r = await c!.t.d.app.inject({
    method: 'GET',
    url: `/api/agents/${agentId}/options`,
    headers: c!.t.headers,
  });
  expect(r.statusCode).toBe(200);
  return r.json<{ commands: AgentCommand[] }>().commands;
}

function assistantDit(agentId: string, text: string): boolean {
  return (
    c!.t.db
      .prepare("SELECT payload FROM agent_messages WHERE agent_id = ? AND kind = 'message'")
      .all(agentId) as Array<{ payload: string }>
  ).some((m) => (JSON.parse(m.payload) as { text?: string }).text === text);
}

async function tourCommandes(agentId: string): Promise<void> {
  c!.t.d.agents.input(agentId, 'commandes');
  await waitFor(() => assistantDit(agentId, 'commandes annoncées'), 5000, 'tour commandes');
}

test('options (A.1) : avant tout tour, les commandes d’A-I-D ; après system/init, celles de claude filtrées', async () => {
  const agent = await spawnClaude();
  expect(await commandsOf(agent.id)).toEqual(AID_COMMANDS);

  await tourCommandes(agent.id);
  const commands = await commandsOf(agent.id);
  expect(commands).toEqual([...AID_COMMANDS, ...CLAUDE_ATTENDUES]);
  const deClaude = commands.filter((x) => x.source === 'agent').map((x) => x.name);
  for (const exclu of [
    'model',
    'compact',
    'login',
    'logout',
    'doctor',
    'color',
    '__remote-workflow',
  ])
    expect(deClaude).not.toContain(exclu);
  expect(new Set(commands.map((x) => x.name)).size).toBe(commands.length);

  // un tour sans `slash_commands` dans son init ne vide pas la liste
  c!.t.d.agents.input(agent.id, 'bonjour');
  await waitFor(() => assistantDit(agent.id, 'echo: bonjour'), 5000, 'tour suivant');
  expect(await commandsOf(agent.id)).toEqual([...AID_COMMANDS, ...CLAUDE_ATTENDUES]);
});

test('options (A.1) : un agent arrêté n’a plus que les commandes d’A-I-D', async () => {
  const agent = await spawnClaude();
  await tourCommandes(agent.id);
  expect(await commandsOf(agent.id)).toEqual([...AID_COMMANDS, ...CLAUDE_ATTENDUES]);

  await c!.t.d.agents.stop(agent.id, 'user');
  expect(c!.t.d.agents.getStream(agent.id)?.exited).toBe(true);
  expect(await commandsOf(agent.id)).toEqual(AID_COMMANDS);
});

test('options (A.1) : un agent dont le pilote est sorti n’a plus que les commandes d’A-I-D', async () => {
  const agent = await spawnClaude();
  await tourCommandes(agent.id);
  expect(await commandsOf(agent.id)).toEqual([...AID_COMMANDS, ...CLAUDE_ATTENDUES]);

  c!.t.d.agents.input(agent.id, 'crash');
  await waitFor(() => c!.t.d.agents.getStream(agent.id)?.exited === true, 5000, 'sortie');
  expect(await commandsOf(agent.id)).toEqual(AID_COMMANDS);
});
