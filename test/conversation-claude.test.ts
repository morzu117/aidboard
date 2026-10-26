import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { buildClaudeArgs, ClaudeDriver } from '../src/daemon/conversation/claude.js';
import type { ConversationEvent } from '../src/daemon/conversation/driver.js';
import { agentEnv } from '../src/daemon/pty/spawn.js';
import type { PendingRequest } from '../src/shared/model.js';
import { waitFor } from './helpers/daemon.js';

const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures/fake-claude-stream.mjs');

function findRequest(events: ConversationEvent[]): PendingRequest {
  const e = events.find(
    (ev): ev is Extract<ConversationEvent, { type: 'request' }> => ev.type === 'request',
  );
  if (!e) throw new Error('aucune requête de permission dans les événements');
  return e.request;
}

let driver: ClaudeDriver | undefined;

afterEach(async () => {
  await driver?.stop();
  driver = undefined;
});

function start(opts: { sessionId: string; resume?: boolean }) {
  const events: ConversationEvent[] = [];
  driver = new ClaudeDriver({
    bin: FAKE_CLAUDE,
    cwd: process.cwd(),
    env: agentEnv(process.env, [], {}),
    sessionId: opts.sessionId,
    resume: opts.resume ?? false,
  });
  driver.onEvent((e) => events.push(e));
  driver.start();
  return { driver, events };
}

test('deux tours dans le même process, normalisation du texte et de la session', async () => {
  const sid = randomUUID();
  const { driver: d, events } = start({ sessionId: sid });

  d.send('bonjour');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'premier tour');
  expect(events).toContainEqual({ type: 'session', sessionId: sid });
  expect(
    events.some(
      (e) => e.type === 'message' && e.role === 'assistant' && e.text === 'echo: bonjour',
    ),
  ).toBe(true);
  const firstTurnEnd = events.find((e) => e.type === 'turn_end');
  expect(firstTurnEnd).toMatchObject({ ok: true, costUsd: 0.001, durationMs: 5 });

  const before = events.length;
  d.send('encore');
  await waitFor(
    () => events.length > before && events.some((e) => e.type === 'turn_end'),
    5000,
    'second tour',
  );
  expect(
    events.some((e) => e.type === 'message' && e.role === 'assistant' && e.text === 'echo: encore'),
  ).toBe(true);
});

test('permission accordée : control_response allow avec l’entrée d’origine', async () => {
  const sid = randomUUID();
  const { driver: d, events } = start({ sessionId: sid });

  d.send('demande permission');
  await waitFor(() => events.some((e) => e.type === 'request'), 5000, 'demande de permission');
  expect(events.some((e) => e.type === 'thinking')).toBe(true);
  const toolStart = events.find((e) => e.type === 'tool_start');
  expect(toolStart).toMatchObject({ name: 'Bash', input: { command: 'echo hi' } });
  const request = findRequest(events);
  expect(request).toMatchObject({ kind: 'permission', question: 'Bash : echo hi' });

  d.answer(request.id, 'yes');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'fin du tour');
  expect(
    events.some((e) => e.type === 'tool_end' && e.isError === false && e.output === 'hi'),
  ).toBe(true);
  expect(events.some((e) => e.type === 'message' && e.text === 'fait')).toBe(true);
});

test('permission refusée : control_response deny, le process reste utilisable', async () => {
  const sid = randomUUID();
  const { driver: d, events } = start({ sessionId: sid });

  d.send('demande permission');
  await waitFor(() => events.some((e) => e.type === 'request'), 5000, 'demande de permission');
  const request = findRequest(events);

  d.answer(request.id, 'no');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'fin du tour');
  expect(events.some((e) => e.type === 'tool_end' && e.isError === true)).toBe(true);
  expect(events.some((e) => e.type === 'message' && e.text === 'refusé')).toBe(true);

  expect(() => d.answer('inconnu', 'yes')).toThrow();
});

test('interruption puis tour suivant réussi dans le même process', async () => {
  const sid = randomUUID();
  const { driver: d, events } = start({ sessionId: sid });

  d.send('tour long');
  await waitFor(
    () => events.filter((e) => e.type === 'session').length >= 1,
    5000,
    'init du tour long',
  );
  d.interrupt();
  await waitFor(
    () => events.some((e) => e.type === 'turn_end' && e.ok === false),
    5000,
    'interruption',
  );
  const interrupted = events.find((e) => e.type === 'turn_end' && e.ok === false);
  expect(interrupted).toMatchObject({ ok: false, error: 'error_during_execution' });

  const before = events.length;
  d.send('salut');
  await waitFor(
    () => events.slice(before).some((e) => e.type === 'turn_end' && e.ok === true),
    5000,
    'tour suivant',
  );
  expect(events.some((e) => e.type === 'message' && e.text === 'echo: salut')).toBe(true);
});

test('resume: true passe --resume <id> au process', () => {
  const sid = randomUUID();
  const args = buildClaudeArgs({
    bin: FAKE_CLAUDE,
    cwd: process.cwd(),
    env: process.env,
    sessionId: sid,
    resume: true,
  });
  expect(args).toContain('--resume');
  expect(args).not.toContain('--session-id');
  expect(args[args.indexOf('--resume') + 1]).toBe(sid);

  const result = spawnSync(FAKE_CLAUDE, args, { encoding: 'utf8', input: '' });
  const firstLine = result.stdout.split('\n')[0] ?? '';
  expect(JSON.parse(firstLine)).toMatchObject({
    type: 'system',
    subtype: 'fake_args',
    mode: 'resume',
    session_id: sid,
  });
});

test('arrêt propre : événement exit', async () => {
  const sid = randomUUID();
  const { driver: d, events } = start({ sessionId: sid });
  d.send('bonjour');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'premier tour');
  await d.stop();
  expect(events.some((e) => e.type === 'exit' && e.code === 0)).toBe(true);
});

test('binaire inexistant : événement exit avec message, aucun crash', async () => {
  const sid = randomUUID();
  const events: ConversationEvent[] = [];
  driver = new ClaudeDriver({
    bin: join(import.meta.dirname, 'fixtures/does-not-exist.mjs'),
    cwd: process.cwd(),
    env: agentEnv(process.env, [], {}),
    sessionId: sid,
    resume: false,
  });
  driver.onEvent((e) => events.push(e));
  driver.start();
  await waitFor(() => events.some((e) => e.type === 'exit'), 5000, 'exit après échec de spawn');
  const exit = events.find((e) => e.type === 'exit');
  expect(exit).toMatchObject({ code: null, signal: null });
  expect((exit as Extract<ConversationEvent, { type: 'exit' }>).message).toBeTruthy();
});

test('écriture après mort du process : aucune exception', async () => {
  const sid = randomUUID();
  const { driver: d, events } = start({ sessionId: sid });
  d.send('bonjour');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'premier tour');
  await d.stop();
  expect(() => d.send('trop tard')).not.toThrow();
});

test('stop() après sortie par signal se résout', async () => {
  const sid = randomUUID();
  const { driver: d, events } = start({ sessionId: sid });
  d.send('crash');
  await waitFor(() => events.some((e) => e.type === 'exit'), 5000, 'sortie par signal après crash');
  const exit = events.find((e) => e.type === 'exit');
  expect(exit).toMatchObject({ code: null, signal: 'SIGKILL' });
  await d.stop();
});

test('double start() lève une erreur', () => {
  const sid = randomUUID();
  const { driver: d } = start({ sessionId: sid });
  expect(() => d.start()).toThrow();
});
