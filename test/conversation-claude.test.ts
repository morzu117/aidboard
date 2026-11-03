import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { vi } from 'vitest';
import { buildClaudeArgs, ClaudeDriver } from '../src/daemon/conversation/claude.js';
import type { ConversationEvent } from '../src/daemon/conversation/driver.js';
import { agentEnv } from '../src/daemon/pty/spawn.js';
import type { AgentSettings } from '../src/shared/agentSettings.js';
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

function start(opts: { sessionId: string; resume?: boolean; settings?: AgentSettings }) {
  const events: ConversationEvent[] = [];
  driver = new ClaudeDriver({
    bin: FAKE_CLAUDE,
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

test('AskUserQuestion : une demande `question` par question, réponses rendues à claude', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });
  const requests = () => events.flatMap((e) => (e.type === 'request' ? [e.request] : []));

  d.send('demande questions');
  await waitFor(() => requests().length === 1, 5000, 'première question');
  const first = requests()[0]!;
  expect(first).toMatchObject({ kind: 'question', question: '(1/2) Où écrire le graphe ?' });
  expect(first.options.map((o) => o.label)).toEqual(['YAML', 'JSON', 'Répondre en texte']);

  d.answer(first.id, '2');
  await waitFor(() => requests().length === 2, 5000, 'seconde question');
  const second = requests()[1]!;
  expect(second).toMatchObject({ kind: 'question', question: '(2/2) Quel moteur ?' });
  expect(() => d.answer(first.id, '1')).toThrow();

  d.answer(second.id, '3');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'fin du tour');
  expect(
    events.some(
      (e) =>
        e.type === 'message' &&
        e.text === 'réponses {"Où écrire le graphe ?":"JSON","Quel moteur ?":"C"}',
    ),
  ).toBe(true);
});

test('AskUserQuestion : « Répondre en texte » refuse l’outil avec une consigne', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('demande questions');
  await waitFor(() => events.some((e) => e.type === 'request'), 5000, 'question');
  d.answer(findRequest(events).id, 'no');
  await waitFor(() => events.some((e) => e.type === 'turn_end'), 5000, 'fin du tour');
  expect(events.some((e) => e.type === 'message' && e.text.startsWith('refusé'))).toBe(true);
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

const reglagesVus = (events: ConversationEvent[]) => {
  const m = events.findLast(
    (e) => e.type === 'message' && e.role === 'assistant' && e.text.startsWith('echo: reglages '),
  ) as Extract<ConversationEvent, { type: 'message' }> | undefined;
  return m ? JSON.parse(m.text.slice('echo: reglages '.length)) : undefined;
};

test('buildClaudeArgs (D67) : mode, modèle, effort et dossier des pièces jointes au lancement', () => {
  const base = { bin: 'claude', cwd: '/w', env: {}, sessionId: 's1', resume: false };
  expect(buildClaudeArgs(base)).not.toContain('--permission-mode');
  // correctif autonomie : systématique, pour qu'un changement à chaud vers Auto puisse ensuite passer en bypass
  expect(buildClaudeArgs(base)).toContain('--allow-dangerously-skip-permissions');
  expect(
    buildClaudeArgs({ ...base, settings: { mode: 'default', model: null, effort: null } }),
  ).not.toContain('--permission-mode');
  const args = buildClaudeArgs({
    ...base,
    settings: { mode: 'auto', model: 'opus', effort: 'high' },
    attachmentsDir: '/aid/attachments/ag_1',
  });
  // correctif autonomie : le mode A-I-D `auto` lance claude en `bypassPermissions`, jamais en `auto` (D66 révisée)
  expect(args.join(' ')).toContain(
    '--permission-mode bypassPermissions --model opus --effort high --add-dir /aid/attachments/ag_1',
  );
});

test('réglages à chaud (D68) : configure() change mode, modèle et effort sans relancer', async () => {
  const { driver: d, events } = start({
    sessionId: randomUUID(),
    settings: { mode: 'auto', model: 'opus', effort: null },
  });
  d.send('reglages');
  await waitFor(() => reglagesVus(events) !== undefined, 5000, 'réglages du lancement');
  expect(reglagesVus(events)).toEqual({ mode: 'bypassPermissions', model: 'opus', effort: null });

  d.configure({ mode: 'plan', model: null, effort: 'max' });
  const before = events.length;
  d.send('reglages');
  await waitFor(
    () => events.length > before && reglagesVus(events.slice(before)) !== undefined,
    5000,
    'réglages changés',
  );
  expect(reglagesVus(events.slice(before))).toEqual({ mode: 'plan', model: null, effort: 'max' });
});

test('correctif autonomie : claude default → auto → default, bypassPermissions au contrôle à chaud puis retour', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });
  d.send('reglages');
  await waitFor(() => reglagesVus(events) !== undefined, 5000, 'réglages par défaut');
  expect(reglagesVus(events)).toEqual({ mode: 'default', model: null, effort: null });

  d.configure({ mode: 'auto', model: null, effort: null });
  let before = events.length;
  d.send('reglages');
  await waitFor(
    () => events.length > before && reglagesVus(events.slice(before)) !== undefined,
    5000,
    'passage en auto',
  );
  expect(reglagesVus(events.slice(before))).toEqual({
    mode: 'bypassPermissions',
    model: null,
    effort: null,
  });

  d.configure({ mode: 'default', model: null, effort: null });
  before = events.length;
  d.send('reglages');
  await waitFor(
    () => events.length > before && reglagesVus(events.slice(before)) !== undefined,
    5000,
    'retour au défaut',
  );
  expect(reglagesVus(events.slice(before))).toEqual({
    mode: 'default',
    model: null,
    effort: null,
  });
});

const turnEnds = (events: ConversationEvent[]) =>
  events.filter(
    (e): e is Extract<ConversationEvent, { type: 'turn_end' }> => e.type === 'turn_end',
  );

test('connexion expirée (constat du 2026-11-02) : le texte reste au fil, fin de tour en erreur authentication_failed', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('connexion expiree');
  await waitFor(() => turnEnds(events).length === 1, 5000, 'fin du tour');
  expect(events).toContainEqual({
    type: 'message',
    role: 'assistant',
    text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  });
  expect(turnEnds(events)[0]).toMatchObject({ ok: false, error: 'authentication_failed' });
  // le message précède la fin du tour
  const iMessage = events.findIndex((e) => e.type === 'message' && e.role === 'assistant');
  const iFin = events.findIndex((e) => e.type === 'turn_end');
  expect(iMessage).toBeLessThan(iFin);
});

test('result success avec is_error: true sans error préalable : ok false, error = subtype', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('is_error seul');
  await waitFor(() => turnEnds(events).length === 1, 5000, 'fin du tour');
  expect(turnEnds(events)[0]).toMatchObject({ ok: false, error: 'success' });
});

test('non-régression : un success normal reste ok, et l’erreur d’un tour ne déborde pas sur le suivant', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('connexion expiree');
  await waitFor(() => turnEnds(events).length === 1, 5000, 'tour en erreur');
  expect(turnEnds(events)[0]).toMatchObject({ ok: false, error: 'authentication_failed' });

  d.send('bonjour');
  await waitFor(() => turnEnds(events).length === 2, 5000, 'tour normal');
  expect(turnEnds(events)[1]).toMatchObject({ ok: true, error: undefined });

  // is_error sans error préalable juste après : l'erreur mémorisée du premier tour ne revient pas
  d.send('connexion expiree');
  await waitFor(() => turnEnds(events).length === 3, 5000, 'second tour en erreur');
  d.send('is_error seul');
  await waitFor(() => turnEnds(events).length === 4, 5000, 'is_error seul');
  expect(turnEnds(events)[3]).toMatchObject({ ok: false, error: 'success' });
});

test('is_error avec un texte result et sans error préalable : error = ce texte, sans les espaces aux extrémités', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('is_error texte');
  await waitFor(() => turnEnds(events).length === 1, 5000, 'fin du tour');
  expect(turnEnds(events)[0]).toMatchObject({ ok: false, error: 'Credit balance is too low' });
});

test('is_error avec un result vide, fait d’espaces ou qui n’est pas une chaîne : error = subtype', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('is_error vide');
  await waitFor(() => turnEnds(events).length === 1, 5000, 'result vide');
  d.send('is_error espaces');
  await waitFor(() => turnEnds(events).length === 2, 5000, 'result fait d’espaces');
  d.send('is_error non texte');
  await waitFor(() => turnEnds(events).length === 3, 5000, 'result pas une chaîne');
  for (const fin of turnEnds(events)) expect(fin).toMatchObject({ ok: false, error: 'success' });
});

test('subtype d’échec sans is_error ni result : error = subtype, comme avant', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('max turns');
  await waitFor(() => turnEnds(events).length === 1, 5000, 'fin du tour');
  expect(turnEnds(events)[0]).toMatchObject({ ok: false, error: 'error_max_turns' });
});

test('authentication_failed reste prioritaire sur le texte result, et un texte ne déborde pas sur le tour suivant', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('is_error texte');
  await waitFor(() => turnEnds(events).length === 1, 5000, 'texte result');
  d.send('connexion expiree');
  await waitFor(() => turnEnds(events).length === 2, 5000, 'connexion expirée');
  expect(turnEnds(events)[1]).toMatchObject({ ok: false, error: 'authentication_failed' });
  d.send('is_error seul');
  await waitFor(() => turnEnds(events).length === 3, 5000, 'is_error seul');
  expect(turnEnds(events)[2]).toMatchObject({ ok: false, error: 'success' });
});

test('success sans is_error, même avec un texte result : ok, sans erreur', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });

  d.send('success avec texte');
  await waitFor(() => turnEnds(events).length === 1, 5000, 'fin du tour');
  expect(turnEnds(events)[0]).toMatchObject({ ok: true, error: undefined });
});

// ---- Chantier 23 (A.1, D87-D89) : remote-control par le `control_request` `remote_control`

/** Lancé avec des options du faux claude, retirées de l'environnement du test aussitôt copiées. */
function startRc(env: Record<string, string> = {}) {
  Object.assign(process.env, env);
  try {
    return start({ sessionId: randomUUID() });
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
}

/** Ce que le faux claude a reçu à la dernière demande de remote-control (tour « remote-control »). */
async function demandeVue(d: ClaudeDriver, events: ConversationEvent[]): Promise<unknown> {
  const prefix = 'echo: remote-control ';
  const avant = events.length;
  d.send('remote-control');
  const m = await waitFor(
    () =>
      events
        .slice(avant)
        .find(
          (e): e is Extract<ConversationEvent, { type: 'message' }> =>
            e.type === 'message' && e.role === 'assistant' && e.text.startsWith(prefix),
        ),
    5000,
    'demande vue par claude',
  );
  return JSON.parse(m.text.slice(prefix.length));
}

async function tour(d: ClaudeDriver, events: ConversationEvent[], text: string): Promise<void> {
  const avant = events.length;
  d.send(text);
  await waitFor(
    () => events.slice(avant).some((e) => e.type === 'turn_end'),
    5000,
    `tour « ${text} »`,
  );
}

const URL1 = 'https://claude.ai/code/session_fake1';

test('remote-control : éteint au départ ; activé → url et connexion, puis connecté ; le nom est envoyé', async () => {
  const { driver: d, events } = startRc();
  expect(d.remoteControlState()).toEqual({ status: 'off' });

  const r = await d.remoteControl(true, 'A-I-D · Mon sujet');
  // `bridge_state ready` est arrivé avant la réponse, `connected` après : la réponse rend « connexion »
  expect(r).toEqual({ status: 'connecting', url: URL1 });
  await waitFor(() => d.remoteControlState().status === 'connected', 5000, 'connecté');
  expect(d.remoteControlState()).toEqual({ status: 'connected', url: URL1 });
  expect(await demandeVue(d, events)).toEqual({ enabled: true, name: 'A-I-D · Mon sujet' });

  // un autre état du pont que connected/failed : « connexion », l'url gardée
  await tour(d, events, 'bridge_state reconnecting');
  expect(d.remoteControlState()).toEqual({ status: 'connecting', url: URL1 });
});

test('remote-control : désactivé → off sans nom envoyé ; un bridge_state ensuite est ignoré', async () => {
  const { driver: d, events } = startRc();
  await d.remoteControl(true, 'A-I-D · S');
  await waitFor(() => d.remoteControlState().status === 'connected', 5000, 'connecté');

  expect(await d.remoteControl(false, 'A-I-D · S')).toEqual({ status: 'off' });
  expect(d.remoteControlState()).toEqual({ status: 'off' });
  expect(await demandeVue(d, events)).toEqual({ enabled: false });

  await tour(d, events, 'bridge_state connected');
  await tour(d, events, 'bridge_state failed');
  expect(d.remoteControlState()).toEqual({ status: 'off' });
});

test('remote-control : refusé par claude → rejet avec son message, état en erreur', async () => {
  const refus = 'Remote Control is not enabled for this account';
  const { driver: d } = startRc({ FAKE_CLAUDE_RC_REFUSE: refus });
  await expect(d.remoteControl(true, 'A-I-D · S')).rejects.toThrow(refus);
  expect(d.remoteControlState()).toEqual({ status: 'error', error: refus });
});

test('remote-control : désactivation refusée → rejet, l’état d’avant est gardé', async () => {
  const refus = 'désactivation impossible';
  const { driver: d } = startRc({ FAKE_CLAUDE_RC_REFUSE: refus });
  await expect(d.remoteControl(false, 'A-I-D · S')).rejects.toThrow(refus);
  expect(d.remoteControlState()).toEqual({ status: 'off' });
});

test('remote-control : sans réponse de claude → rejet après 30 s, état en erreur', async () => {
  const { driver: d, events } = startRc({ FAKE_CLAUDE_RC_SILENT: '1' });
  const realSetTimeout = globalThis.setTimeout;
  const attendre = async (check: () => boolean, what: string) => {
    const t0 = Date.now();
    while (!check()) {
      if (Date.now() - t0 > 5000) throw new Error(`délai dépassé : ${what}`);
      await new Promise((r) => realSetTimeout(r, 25));
    }
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let issue: string | undefined;
    d.remoteControl(true, 'A-I-D · S').then(
      () => (issue = 'résolu'),
      (e: Error) => (issue = e.message),
    );
    expect(d.remoteControlState()).toEqual({ status: 'connecting' });
    // un tour passé après la demande : claude l'a lue et n'y a pas répondu
    d.send('bonjour');
    await attendre(() => events.some((e) => e.type === 'turn_end'), 'tour après la demande');
    vi.advanceTimersByTime(29_999);
    await Promise.resolve();
    expect(issue).toBeUndefined();
    expect(d.remoteControlState()).toEqual({ status: 'connecting' });
    vi.advanceTimersByTime(1);
    await attendre(() => issue !== undefined, 'rejet');
    expect(issue).toBe('claude n’a pas répondu à la demande de remote-control');
    expect(d.remoteControlState()).toEqual({ status: 'error', error: 'claude n’a pas répondu' });
  } finally {
    vi.useRealTimers();
  }
});

test('remote-control : bridge_state failed une fois connecté → erreur avec son detail, l’url gardée', async () => {
  const detail = 'session expirée côté claude.ai';
  const { driver: d } = startRc({ FAKE_CLAUDE_RC_FAIL: detail });
  await d.remoteControl(true, 'A-I-D · S');
  await waitFor(() => d.remoteControlState().status === 'error', 5000, 'échec du pont');
  expect(d.remoteControlState()).toEqual({ status: 'error', url: URL1, error: detail });
});

test('remote-control : bridge_state failed sans detail → message par défaut', async () => {
  const { driver: d, events } = startRc();
  await d.remoteControl(true, 'A-I-D · S');
  await waitFor(() => d.remoteControlState().status === 'connected', 5000, 'connecté');
  await tour(d, events, 'bridge_state failed');
  expect(d.remoteControlState()).toEqual({
    status: 'error',
    url: URL1,
    error: 'remote-control déconnecté',
  });
});

test('remote-control : le process sort pendant une demande → rejet, état éteint', async () => {
  const { driver: d, events } = startRc({ FAKE_CLAUDE_RC_SILENT: '1' });
  const demande = d.remoteControl(true, 'A-I-D · S');
  const issue = demande.then(
    () => 'résolu',
    (e: Error) => e.message,
  );
  d.send('crash');
  await waitFor(() => events.some((e) => e.type === 'exit'), 5000, 'sortie');
  expect(await issue).toBe('agent arrêté');
  expect(d.remoteControlState()).toEqual({ status: 'off' });
  await expect(d.remoteControl(true, 'A-I-D · S')).rejects.toThrow('agent arrêté');
});

test('remote-control : le process sort une fois connecté → état éteint', async () => {
  const { driver: d, events } = startRc();
  await d.remoteControl(true, 'A-I-D · S');
  await waitFor(() => d.remoteControlState().status === 'connected', 5000, 'connecté');
  d.send('crash');
  await waitFor(() => events.some((e) => e.type === 'exit'), 5000, 'sortie');
  expect(d.remoteControlState()).toEqual({ status: 'off' });
});

test('remote-control : une control_response inattendue est ignorée, la demande en cours attend toujours', async () => {
  const { driver: d, events } = startRc({ FAKE_CLAUDE_RC_SILENT: '1' });
  let issue: string | undefined;
  const demande = d.remoteControl(true, 'A-I-D · S');
  demande.then(
    () => (issue = 'résolu'),
    (e: Error) => (issue = e.message),
  );
  // les réglages répondent aussi par control_response, à d'autres request_id
  d.configure({ mode: 'plan', model: 'opus', effort: 'high' });
  await tour(d, events, 'control_response inconnue');
  expect(issue).toBeUndefined();
  expect(d.remoteControlState()).toEqual({ status: 'connecting' });
  expect(events.some((e) => e.type === 'exit')).toBe(false);
});
