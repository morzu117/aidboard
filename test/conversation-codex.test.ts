import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { buildCodexArgs, CodexDriver, commandOf } from '../src/daemon/conversation/codex.js';
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

test('commande d’une approbation (revue R.5) : enveloppe ouverte, sinon telle quelle, sinon les actions', () => {
  expect(commandOf({ command: "/bin/zsh -lc 'rm -f x'" })).toEqual({ command: 'rm -f x' });
  expect(commandOf({ command: "bash -c 'echo '\\''a'\\'''" })).toEqual({ command: "echo 'a'" });
  // non enveloppée : la commande telle qu'elle s'exécute, les actions ne l'emportent pas
  expect(commandOf({ command: 'rm -f x', commandActions: [{ command: 'ls' }] })).toEqual({
    command: 'rm -f x',
  });
  // sans commande : les actions, jointes, celles sans texte écartées
  expect(
    commandOf({
      commandActions: [
        { command: 'cd a' },
        null,
        { command: '' },
        { command: 3 },
        { command: 'rm b' },
      ],
    }),
  ).toEqual({ command: 'cd a && rm b' });
  // commande vide sans action : rendue telle quelle ; rien du tout : aucune commande
  expect(commandOf({ command: '', commandActions: 'pas une liste' })).toEqual({ command: '' });
  expect(commandOf({ commandActions: [] })).toBeUndefined();
  expect(commandOf(undefined)).toBeUndefined();
});

/** Chantier 22 (A.2, D84) : les skills de `skills/list`, filtrées, et ce que la fausse app-server lit au `turn/start`. */
const SKILLS_ATTENDUES = [
  { name: 'skill-x', description: 'Fait x', source: 'agent' },
  { name: 'courte', description: 'Résumé court', source: 'agent' },
  { name: 'longue-seule', description: 'Seulement la longue', source: 'agent' },
  { name: 'sans-description', description: 'Skill de codex', source: 'agent' },
];
const SKILL_X = { type: 'skill', name: 'skill-x', path: '/skills/skill-x/SKILL.md' };

/** L'`input` reçu par le faux `turn/start`, renvoyé en écho par le fixture (dernier tour d'abord). */
const entreeVue = (events: ConversationEvent[]): unknown[] | undefined => {
  const m = events.findLast((e) => e.type === 'message' && e.text.startsWith('echo: entree ')) as
    Extract<ConversationEvent, { type: 'message' }> | undefined;
  return m ? (JSON.parse(m.text.slice('echo: entree '.length)) as unknown[]) : undefined;
};

async function avecSkills() {
  const r = start({ sessionId: randomUUID() });
  await waitFor(() => r.driver.commands().length > 0, 5000, 'skills de codex');
  return r;
}

async function tour(d: CodexDriver, events: ConversationEvent[], text: string) {
  const before = events.length;
  d.send(text);
  await waitFor(
    () => events.slice(before).some((e) => e.type === 'turn_end'),
    5000,
    `tour « ${text} »`,
  );
  return entreeVue(events.slice(before));
}

test('skills (A.2) : skills/list après la poignée de main, désactivées, doublons et invalides écartés', async () => {
  const { driver: d } = await avecSkills();
  expect(d.commands()).toEqual(SKILLS_ATTENDUES);
  // le chemin, utile au seul `turn/start`, ne sort pas du pilote
  expect(d.commands().some((c) => 'path' in c)).toBe(false);
});

test('skills (A.2) : `/skill-x des arguments` → entrée skill puis texte ; `/skill-x` seul → skill sans texte', async () => {
  const { driver: d, events } = await avecSkills();
  expect(await tour(d, events, '/skill-x des arguments')).toEqual([
    SKILL_X,
    { type: 'text', text: 'des arguments' },
  ]);
  expect(await tour(d, events, '  /skill-x\n  sur deux\nlignes  ')).toEqual([
    SKILL_X,
    { type: 'text', text: 'sur deux\nlignes' },
  ]);
  expect(await tour(d, events, '/skill-x')).toEqual([SKILL_X]);
  expect(await tour(d, events, '/skill-x   ')).toEqual([SKILL_X]);
  expect(await tour(d, events, '/sans-description go')).toEqual([
    { type: 'skill', name: 'sans-description', path: '/skills/sans-description/SKILL.md' },
    { type: 'text', text: 'go' },
  ]);
});

test('skills (A.2, D85) : `/inconnu foo`, une skill désactivée ou un `/` seul partent en texte tel quel', async () => {
  const { driver: d, events } = await avecSkills();
  expect(await tour(d, events, '/inconnu foo')).toEqual([{ type: 'text', text: '/inconnu foo' }]);
  expect(await tour(d, events, '/desactivee bar')).toEqual([
    { type: 'text', text: '/desactivee bar' },
  ]);
  expect(await tour(d, events, '/ skill-x')).toEqual([{ type: 'text', text: '/ skill-x' }]);
  // le nom au milieu du texte n'est pas une commande
  expect(await tour(d, events, 'voir /skill-x')).toBeUndefined();
  expect(events.some((e) => e.type === 'message' && e.text === 'echo: voir /skill-x')).toBe(true);
});

test('skills (A.2) : les pièces jointes suivent l’entrée skill — chemins dans le texte, images en localImage', async () => {
  const { driver: d, events } = await avecSkills();
  const files = [
    { path: '/tmp/a.png', name: 'a.png', type: 'image/png' },
    { path: '/tmp/b.pdf', name: 'b.pdf', type: 'application/pdf' },
  ];
  const before = events.length;
  d.send('/skill-x lis', files);
  await waitFor(() => events.slice(before).some((e) => e.type === 'turn_end'), 5000, 'tour');
  expect(entreeVue(events.slice(before))).toEqual([
    SKILL_X,
    { type: 'text', text: 'lis\n\nPièces jointes (à lire à ces chemins) :\n- /tmp/b.pdf' },
    { type: 'localImage', path: '/tmp/a.png' },
  ]);
});

test('skills (A.2) : un `/skill-x` envoyé pendant un tour part au tour suivant, en entrée skill', async () => {
  const { driver: d, events } = await avecSkills();
  d.send('tour long');
  await waitFor(() => events.some((e) => e.type === 'session'), 5000, 'session établie');
  d.send('/skill-x en file');
  expect(entreeVue(events)).toBeUndefined();

  d.interrupt();
  await waitFor(
    () => entreeVue(events) !== undefined,
    5000,
    'skill en file envoyée après le tour long',
  );
  expect(entreeVue(events)).toEqual([SKILL_X, { type: 'text', text: 'en file' }]);
  const fin = events.findIndex((e) => e.type === 'turn_end' && e.ok === false);
  const echo = events.findIndex((e) => e.type === 'message' && e.text.startsWith('echo: entree '));
  expect(fin).toBeGreaterThanOrEqual(0);
  expect(echo).toBeGreaterThan(fin);
});

test('skills (A.2) : `skills/list` en erreur (vieille version) → aucune skill, le pilote continue', async () => {
  const events: ConversationEvent[] = [];
  driver = new CodexDriver({
    bin: FAKE_CODEX,
    cwd: process.cwd(),
    env: { ...agentEnv(process.env, [], {}), FAKE_CODEX_FAIL_SKILLS_LIST: '1' },
    sessionId: randomUUID(),
    resume: false,
  });
  driver.onEvent((e) => events.push(e));
  driver.start();
  // la réponse en erreur précède celle du premier `turn/start` : à la fin du tour, elle est arrivée
  expect(await tour(driver, events, '/skill-x des arguments')).toEqual([
    { type: 'text', text: '/skill-x des arguments' },
  ]);
  expect(driver.commands()).toEqual([]);
  expect(events.some((e) => e.type === 'exit')).toBe(false);
  await waitFor(() => driver!.catalog().length > 0, 5000, 'catalogue malgré l’erreur');
  const before = events.length;
  driver.send('bonjour');
  await waitFor(
    () => events.slice(before).some((e) => e.type === 'turn_end'),
    5000,
    'tour suivant',
  );
  expect(events.some((e) => e.type === 'message' && e.text === 'echo: bonjour')).toBe(true);
});

/** Chantier 22 (A.3, D81) : chaque `thread/compact/start` reçu par la fausse app-server, lu par son tour `compactions`. */
type Compaction = { threadId: string | null; pendantTour: boolean };
const COMPACTEE: Compaction = { threadId: 'thread-new-fixed', pendantTour: false };

async function compactionsVues(d: CodexDriver, events: ConversationEvent[]): Promise<Compaction[]> {
  const before = events.length;
  await tour(d, events, 'compactions');
  const m = events
    .slice(before)
    .find((e) => e.type === 'message' && e.text.startsWith('echo: compactions ')) as
    Extract<ConversationEvent, { type: 'message' }> | undefined;
  if (!m) throw new Error('aucun écho des compactions');
  return JSON.parse(m.text.slice('echo: compactions '.length)) as Compaction[];
}

const finsDeTour = (events: ConversationEvent[]) =>
  events.filter(
    (e): e is Extract<ConversationEvent, { type: 'turn_end' }> => e.type === 'turn_end',
  );

function startAvec(env: Record<string, string>) {
  const events: ConversationEvent[] = [];
  driver = new CodexDriver({
    bin: FAKE_CODEX,
    cwd: process.cwd(),
    env: { ...agentEnv(process.env, [], {}), ...env },
    sessionId: randomUUID(),
    resume: false,
  });
  driver.onEvent((e) => events.push(e));
  driver.start();
  return { driver, events };
}

test('compact (A.3, D81) : `/compact` sur un codex prêt → thread/compact/start sur son thread, jamais en texte ; fin ok, le tour suivant part', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });
  await tour(d, events, 'bonjour');

  const before = events.length;
  d.send('/compact');
  await waitFor(
    () => events.slice(before).some((e) => e.type === 'turn_end'),
    5000,
    'fin de la compaction',
  );
  const compaction = events.slice(before);
  expect(finsDeTour(compaction)).toHaveLength(1);
  expect(finsDeTour(compaction)[0]).toMatchObject({ ok: true });
  expect(finsDeTour(compaction)[0]!.error).toBeUndefined();
  // codex ne dit rien d'une compaction : aucun message, aucun outil
  expect(compaction.filter((e) => e.type !== 'turn_end')).toEqual([]);

  // revenu prêt : le message suivant part tout de suite, en texte normal
  expect(await tour(d, events, 'encore')).toBeUndefined();
  expect(events.some((e) => e.type === 'message' && e.text === 'echo: encore')).toBe(true);
  expect(await compactionsVues(d, events)).toEqual([COMPACTEE]);
  // aucun `turn/start` n'a porté `/compact` (le faux renverrait son entrée en écho)
  expect(events.some((e) => e.type === 'message' && e.text.startsWith('echo: entree '))).toBe(
    false,
  );
  expect(events.some((e) => e.type === 'exit')).toBe(false);
});

test('compact (A.3) : un `/compact` envoyé pendant un tour attend sa fin, puis la file continue', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });
  d.send('tour long');
  await waitFor(() => events.some((e) => e.type === 'session'), 5000, 'session établie');
  d.send('  /compact\n');
  d.send('après');
  expect(finsDeTour(events)).toEqual([]);

  d.interrupt();
  await waitFor(
    () => events.some((e) => e.type === 'message' && e.text === 'echo: après'),
    5000,
    'file vidée après le tour long',
  );
  // le tour long interrompu, la compaction, puis `après`
  expect(finsDeTour(events).map((e) => e.ok)).toEqual([false, true, true]);
  expect(await compactionsVues(d, events)).toEqual([COMPACTEE]);
});

test('compact (A.3) : `/compact` avec une pièce jointe, avec des arguments ou au milieu du texte part en texte', async () => {
  const { driver: d, events } = start({ sessionId: randomUUID() });
  expect(await tour(d, events, '/compact maintenant')).toEqual([
    { type: 'text', text: '/compact maintenant' },
  ]);
  expect(await tour(d, events, '/compactage')).toEqual([{ type: 'text', text: '/compactage' }]);

  let before = events.length;
  d.send('/compact', [{ path: '/tmp/b.pdf', name: 'b.pdf', type: 'application/pdf' }]);
  await waitFor(() => events.slice(before).some((e) => e.type === 'turn_end'), 5000, 'tour pdf');
  expect(entreeVue(events.slice(before))).toEqual([
    { type: 'text', text: '/compact\n\nPièces jointes (à lire à ces chemins) :\n- /tmp/b.pdf' },
  ]);

  before = events.length;
  d.send('/compact', [{ path: '/tmp/a.png', name: 'a.png', type: 'image/png' }]);
  await waitFor(() => events.slice(before).some((e) => e.type === 'turn_end'), 5000, 'tour image');
  expect(entreeVue(events.slice(before))).toEqual([
    { type: 'text', text: '/compact' },
    { type: 'localImage', path: '/tmp/a.png' },
  ]);

  expect(await tour(d, events, 'voir /compact')).toBeUndefined();
  expect(events.some((e) => e.type === 'message' && e.text === 'echo: voir /compact')).toBe(true);
  expect(await compactionsVues(d, events)).toEqual([]);
});

test('compact (A.3) : `thread/compact/start` refusé → fin de tour en erreur avec le message, la file avance, pas de sortie', async () => {
  const { driver: d, events } = startAvec({ FAKE_CODEX_FAIL_COMPACT: '1' });
  // tous deux en file pendant la poignée de main : le refus doit libérer le second
  d.send('/compact');
  d.send('bonjour');
  await waitFor(
    () => events.some((e) => e.type === 'message' && e.text === 'echo: bonjour'),
    5000,
    'message en file après le refus',
  );
  const fins = finsDeTour(events);
  expect(fins).toHaveLength(2);
  expect(fins[0]).toMatchObject({ ok: false, error: 'échec simulé thread/compact/start' });
  expect(fins[1]).toMatchObject({ ok: true });

  // depuis un pilote prêt : même refus, et il reste prêt
  const before = events.length;
  d.send('/compact');
  await waitFor(() => events.slice(before).some((e) => e.type === 'turn_end'), 5000, 'refus');
  expect(finsDeTour(events.slice(before))[0]).toMatchObject({
    ok: false,
    error: 'échec simulé thread/compact/start',
  });
  expect(await compactionsVues(d, events)).toEqual([]);
  expect(events.some((e) => e.type === 'exit')).toBe(false);
});

test('compact (A.3, D81) : une skill de codex nommée `compact` ne masque pas la commande d’A-I-D', async () => {
  const { driver: d, events } = startAvec({ FAKE_CODEX_SKILL_COMPACT: '1' });
  await waitFor(() => d.commands().some((c) => c.name === 'compact'), 5000, 'skill compact');

  expect(await tour(d, events, '/compact')).toBeUndefined();
  expect(await compactionsVues(d, events)).toEqual([COMPACTEE]);
  // avec des arguments, ce n'est plus la commande d'A-I-D : la skill homonyme reçoit l'appel
  expect(await tour(d, events, '/compact maintenant')).toEqual([
    { type: 'skill', name: 'compact', path: '/skills/compact/SKILL.md' },
    { type: 'text', text: 'maintenant' },
  ]);
  expect(await compactionsVues(d, events)).toEqual([COMPACTEE]);
});
