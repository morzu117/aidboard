import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { buildCodexArgs, CodexDriver } from '../src/daemon/conversation/codex.js';
import type { ConversationEvent } from '../src/daemon/conversation/driver.js';
import { agentEnv } from '../src/daemon/pty/spawn.js';
import type { AgentSettings } from '../src/shared/agentSettings.js';
import type { PendingRequest } from '../src/shared/model.js';
import { waitFor } from './helpers/daemon.js';

const FAKE_CODEX = join(import.meta.dirname, 'fixtures/fake-codex-appserver.mjs');

function findRequest(events: ConversationEvent[]): PendingRequest {
  const e = events.find(
    (ev): ev is Extract<ConversationEvent, { type: 'request' }> => ev.type === 'request',
  );
  if (!e) throw new Error('aucune requête de permission dans les événements');
  return e.request;
}

let driver: CodexDriver | undefined;

afterEach(async () => {
  await driver?.stop();
  driver = undefined;
});

function start(opts: { sessionId: string; resume?: boolean; settings?: AgentSettings }) {
  const events: ConversationEvent[] = [];
  driver = new CodexDriver({
    bin: FAKE_CODEX,
    cwd: process.cwd(),
    env: agentEnv(process.env, [], {}),
    sessionId: opts.sessionId,
    resume: opts.resume ?? false,
    settings: opts.settings,
  });
  driver.onEvent((e) => events.push(e));
  driver.start();
  return { driver, events };
}

test('poignée de main puis tour simple : session et message normalisés', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('bonjour');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'premier tour');
  expect(events.some((e) => e.type === 'session' && e.sessionId === 'thread-new-fixed')).toBe(true);
  expect(d.sessionId).toBe('thread-new-fixed');
  expect(
    events.some(
      (e) => e.type === 'message' && e.role === 'assistant' && e.text === 'echo: bonjour',
    ),
  ).toBe(true);
  const turnEnd = events.find((e) => e.type === 'turn_end');
  expect(turnEnd).toMatchObject({ ok: true, durationMs: 5 });
});

test('deux tours séquentiels dans le même process', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('bonjour');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'premier tour');

  const before = events.length;
  d.send('encore');
  await waitFor(() => events.slice(before).some((e) => e.type === 'turn_end'), 5000, 'second tour');
  expect(
    events.some((e) => e.type === 'message' && e.role === 'assistant' && e.text === 'echo: encore'),
  ).toBe(true);
});

test('message envoyé pendant un tour actif : mis en file, envoyé après', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('tour long');
  await waitFor(() => events.some((e) => e.type === 'session'), 5000, 'session établie');
  d.send('salut');
  expect(events.some((e) => e.type === 'message' && e.text === 'echo: salut')).toBe(false);

  d.interrupt();
  await waitFor(
    () => events.some((e) => e.type === 'turn_end' && e.ok === false),
    5000,
    'interruption du tour long',
  );
  await waitFor(
    () => events.some((e) => e.type === 'message' && e.text === 'echo: salut'),
    5000,
    'message en file envoyé après le tour long',
  );
});

test('approbation accordée : réponse `accept`, le process reste utilisable', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('demande permission');
  await waitFor(() => events.some((e) => e.type === 'request'), 5000, 'demande d’approbation');
  const toolStart = events.find((e) => e.type === 'tool_start');
  expect(toolStart).toMatchObject({ name: 'command', input: { command: 'echo hi' } });
  const request = findRequest(events);
  expect(request.kind).toBe('permission');

  d.answer(request.id, 'yes');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'fin du tour');
  expect(
    events.some((e) => e.type === 'tool_end' && e.isError === false && e.output === 'hi'),
  ).toBe(true);
  expect(events.some((e) => e.type === 'message' && e.text === 'fait')).toBe(true);
});

test('approbation refusée : réponse `decline`', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('demande permission');
  await waitFor(() => events.some((e) => e.type === 'request'), 5000, 'demande d’approbation');
  const request = findRequest(events);

  d.answer(request.id, 'no');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'fin du tour');
  expect(events.some((e) => e.type === 'tool_end' && e.isError === true)).toBe(true);
  expect(events.some((e) => e.type === 'message' && e.text === 'refusé')).toBe(true);

  expect(() => d.answer('inconnu', 'yes')).toThrow();
});

test('« always » se traduit en `acceptForSession`, distinct de `accept`', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('demande permission');
  await waitFor(() => events.some((e) => e.type === 'request'), 5000, 'demande d’approbation');
  const request = findRequest(events);

  d.answer(request.id, 'always');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'fin du tour');
  expect(events.some((e) => e.type === 'message' && e.text === 'fait toujours')).toBe(true);
});

test('interruption puis tour suivant réussi dans le même process', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('tour long');
  await waitFor(() => events.some((e) => e.type === 'session'), 5000, 'session établie');
  d.interrupt();
  await waitFor(
    () => events.some((e) => e.type === 'turn_end' && e.ok === false),
    5000,
    'interruption',
  );
  const interrupted = events.find((e) => e.type === 'turn_end' && e.ok === false);
  expect(interrupted).toMatchObject({ ok: false, error: 'interrompu' });

  const before = events.length;
  d.send('salut');
  await waitFor(
    () => events.slice(before).some((e) => e.type === 'turn_end' && e.ok === true),
    5000,
    'tour suivant',
  );
  expect(events.some((e) => e.type === 'message' && e.text === 'echo: salut')).toBe(true);
});

test('resume: true envoie thread/resume avec l’id fourni, retrouvé dans l’événement session', async () => {
  const sid = randomUUID();
  const { driver: d, events } = start({ sessionId: sid, resume: true });

  d.send('bonjour');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'tour après reprise');
  expect(events).toContainEqual({ type: 'session', sessionId: sid });
  expect(d.sessionId).toBe(sid);
});

test('item fileChange : tool_start/tool_end normalisés avec changes et diff (review A.2)', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('modification fichier');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'fin du tour');

  const toolStart = events.find((e) => e.type === 'tool_start');
  expect(toolStart).toMatchObject({
    name: 'file_change',
    input: {
      changes: [
        { path: 'src/a.ts', kind: 'update' },
        { path: 'src/b.ts', kind: 'add' },
      ],
    },
  });
  const toolEnd = events.find((e) => e.type === 'tool_end');
  expect(toolEnd).toMatchObject({ isError: false });
  const output = (toolEnd as Extract<ConversationEvent, { type: 'tool_end' }>).output;
  expect(output).toContain('--- a');
  expect(output).toContain('--- /dev/null');
});

test('serverRequest/resolved : approbation purgée via request_cancelled sans réponse du client', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('demande annulee par serveur');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'fin du tour');

  expect(events.some((e) => e.type === 'request')).toBe(true);
  expect(events.some((e) => e.type === 'request_cancelled')).toBe(true);
  expect(events.some((e) => e.type === 'message' && e.text === 'annule par le serveur')).toBe(true);
});

test('interrupt() appelé avant la réponse à turn/start : honoré dès que activeTurnId est connu', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('bonjour');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'premier tour');

  // `send` ici déclenche `startTurn` de façon synchrone (phase déjà `ready`) : `interrupt()`
  // s'exécute donc avant tout aller-retour avec le process, quand `activeTurnId` est encore null.
  d.send('tour long');
  d.interrupt();
  await waitFor(
    () => events.some((e) => e.type === 'turn_end' && e.ok === false),
    5000,
    'interruption honorée malgré l’absence de activeTurnId au moment de l’appel',
  );
  const interrupted = events.find((e) => e.type === 'turn_end' && e.ok === false);
  expect(interrupted).toMatchObject({ ok: false, error: 'interrompu' });
});

test('erreur JSON-RPC au handshake (thread/start) : exit émis, process réellement tué (review A.2, bloquant)', async () => {
  const events: ConversationEvent[] = [];
  driver = new CodexDriver({
    bin: FAKE_CODEX,
    cwd: process.cwd(),
    env: { ...agentEnv(process.env, [], {}), FAKE_CODEX_FAIL_THREAD_START: '1' },
    sessionId: randomUUID(),
    resume: false,
  });
  driver.onEvent((e) => events.push(e));
  driver.start();
  await waitFor(
    () => events.some((e) => e.type === 'exit'),
    5000,
    'exit après erreur de handshake',
  );

  const exit = events.find((e) => e.type === 'exit') as Extract<
    ConversationEvent,
    { type: 'exit' }
  >;
  const match = /pid=(\d+)/.exec(exit.message ?? '');
  if (!match) throw new Error('pid introuvable dans le message d’exit');
  const pid = Number(match[1]);

  await driver.stop();

  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    5000,
    'process réellement terminé après échec de handshake',
  );
});

test('requête serveur de méthode inconnue : réponse d’erreur, pas de blocage', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('requete inconnue');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'fin du tour');
  expect(events.some((e) => e.type === 'message' && e.text === 'erreur recue')).toBe(true);
});

test('arrêt propre : événement exit', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });
  d.send('bonjour');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'premier tour');
  await d.stop();
  expect(events.some((e) => e.type === 'exit' && e.code === 0)).toBe(true);
});

test('binaire inexistant : événement exit avec message, aucun crash', async () => {
  const events: ConversationEvent[] = [];
  driver = new CodexDriver({
    bin: join(import.meta.dirname, 'fixtures/does-not-exist.mjs'),
    cwd: process.cwd(),
    env: agentEnv(process.env, [], {}),
    sessionId: randomUUID(),
    resume: false,
  });
  driver.onEvent((e) => events.push(e));
  driver.start();
  await waitFor(() => events.some((e) => e.type === 'exit'), 5000, 'exit après échec de spawn');
  const exit = events.find((e) => e.type === 'exit');
  expect(exit).toMatchObject({ code: null, signal: null });
  expect((exit as Extract<ConversationEvent, { type: 'exit' }>).message).toBeTruthy();
});

test('stop() après sortie par signal se résout', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });
  d.send('crash');
  await waitFor(() => events.some((e) => e.type === 'exit'), 5000, 'sortie par signal après crash');
  const exit = events.find((e) => e.type === 'exit');
  expect(exit).toMatchObject({ code: null, signal: 'SIGKILL' });
  await d.stop();
});

test('double start() lève une erreur', () => {
  const { driver: d } = start({ sessionId: randomUUID() });
  expect(() => d.start()).toThrow();
});

test('écriture après mort du process : aucune exception', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });
  d.send('bonjour');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'premier tour');
  await d.stop();
  expect(() => d.send('trop tard')).not.toThrow();
});

test('buildCodexArgs : `app-server` puis les extraArgs', () => {
  const args = buildCodexArgs({
    bin: FAKE_CODEX,
    cwd: process.cwd(),
    env: process.env,
    sessionId: randomUUID(),
    resume: false,
    extraArgs: ['--foo'],
  });
  expect(args).toEqual(['app-server', '--foo']);
});

const reglagesVus = (events: ConversationEvent[]) => {
  const m = events.findLast((e) => e.type === 'message' && e.text.startsWith('echo: reglages ')) as
    Extract<ConversationEvent, { type: 'message' }> | undefined;
  return m ? JSON.parse(m.text.slice('echo: reglages '.length)) : undefined;
};

test('réglages (D66, D68) : turn/start porte approvalPolicy, modèle et effort du réglage courant', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });
  d.send('reglages');
  await waitFor(() => reglagesVus(events) !== undefined, 5000, 'réglages par défaut');
  expect(reglagesVus(events)).toEqual({ approvalPolicy: 'on-request' });

  d.configure({ mode: 'auto', model: 'gpt-fake', effort: 'high' });
  const before = events.length;
  d.send('reglages');
  await waitFor(
    () => events.length > before && reglagesVus(events.slice(before)) !== undefined,
    5000,
    'réglages changés',
  );
  expect(reglagesVus(events.slice(before))).toEqual({
    approvalPolicy: 'never',
    model: 'gpt-fake',
    effort: 'high',
  });
});

test('catalogue (D71) : model/list après la poignée de main, modèles cachés écartés', async () => {
  const { driver: d } = start({ sessionId: randomUUID() });
  await waitFor(() => (d.catalog?.() ?? []).length > 0, 5000, 'catalogue codex');
  expect(d.catalog()).toEqual([{ id: 'gpt-fake', label: 'GPT-FAKE', efforts: ['low', 'high'] }]);
});
