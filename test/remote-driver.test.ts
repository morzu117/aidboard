import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ClaudeDriver } from '../src/daemon/conversation/claude.js';
import { CodexDriver } from '../src/daemon/conversation/codex.js';
import type { ConversationDriver, ConversationEvent } from '../src/daemon/conversation/driver.js';
import { LOST_MESSAGE, RECONNECT_DELAYS_MS } from '../src/daemon/remote/child.js';
import { MAX_RESUMES, RemoteDriver } from '../src/daemon/remote/driver.js';
import type { TransportOptions } from '../src/daemon/remote/transport.js';
import { FAKE_SSH, waitFor } from './helpers/daemon.js';

/** Chantier 17 (R.3) : les pilotes claude et codex sur un agent « distant » — faux ssh, faux tmux, faux agents (D79). */
const FAKE_TMUX = resolve(__dirname, 'fixtures/fake-tmux.sh');
const FAKE_CLAUDE = resolve(__dirname, 'fixtures/fake-claude-stream.mjs');
const FAKE_CODEX = resolve(__dirname, 'fixtures/fake-codex-appserver.mjs');
const SERVER = {
  mode: 'ssh_alias' as const,
  target: 'vps',
  sshOptions: null,
  loadProfile: false,
  shell: 'sh',
};
const DELAYS = [50, 100, 150];

const nettoyages: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const n of nettoyages.splice(0).reverse()) await n();
});

function tuer(fichier: string): void {
  try {
    const pid = parseInt(readFileSync(fichier, 'utf8'), 10);
    if (pid > 1) process.kill(pid, 'SIGKILL');
  } catch {
    // déjà mort, ou jamais lancé
  }
}

/** Un « serveur » neuf : HOME distant temporaire, faux tmux en tête du PATH (même montage que remote-relay). */
function serveur(): { home: string; transport: TransportOptions & { env: NodeJS.ProcessEnv } } {
  const home = mkdtempSync(join(tmpdir(), 'aid-rdriver-'));
  const bin = join(home, 'faux-bin');
  mkdirSync(bin);
  symlinkSync(FAKE_TMUX, join(bin, 'tmux'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_SSH_HOME: home,
    FAKE_TMUX_DIR: join(home, 'faux-tmux'),
    PATH: `${bin}:${process.env.PATH}`,
  };
  mkdirSync(env.FAKE_TMUX_DIR!);
  // le shell de connexion relit /etc/profile (path_helper sur macOS) : le profil distant remet le faux tmux devant
  writeFileSync(join(home, '.profile'), `PATH='${bin}':"$PATH"\nexport PATH\n`);
  nettoyages.push(() => {
    for (const f of readdirSync(env.FAKE_TMUX_DIR!)) tuer(join(env.FAKE_TMUX_DIR!, f));
    const agents = join(home, '.aid-remote/agents');
    if (existsSync(agents)) for (const id of readdirSync(agents)) tuer(join(agents, id, 'apid'));
    rmSync(home, { recursive: true, force: true });
  });
  return { home, transport: { ssh: FAKE_SSH, env } };
}

type Kind = 'claude' | 'codex';

function distant(
  transport: TransportOptions,
  relayId: string,
  kind: Kind,
  bin = kind === 'claude' ? FAKE_CLAUDE : FAKE_CODEX,
  resumeBin = bin,
) {
  const events: ConversationEvent[] = [];
  const created: { sessionId: string; resume: boolean }[] = [];
  const driver = new RemoteDriver({
    server: SERVER,
    transport,
    relayId,
    sessionId: kind === 'claude' ? randomUUID() : '',
    resume: false,
    delaysMs: DELAYS,
    create: (o): ConversationDriver => {
      created.push({ sessionId: o.sessionId, resume: o.resume });
      const opts = { bin: o.resume ? resumeBin : bin, cwd: '~', env: {}, ...o };
      return kind === 'claude' ? new ClaudeDriver(opts) : new CodexDriver(opts);
    },
  });
  driver.onEvent((e) => events.push(e));
  driver.start();
  nettoyages.push(() => driver.stop());
  const compte = (pred: (e: ConversationEvent) => boolean) => events.filter(pred).length;
  const attendre = (pred: (e: ConversationEvent) => boolean, quoi: string, n = 1) =>
    waitFor(() => compte(pred) >= n, 15_000, quoi);
  return { driver, events, created, compte, attendre };
}

const message = (text: string) => (e: ConversationEvent) =>
  e.type === 'message' && e.role === 'assistant' && e.text === text;
const type =
  <T extends ConversationEvent['type']>(t: T) =>
  (e: ConversationEvent) =>
    e.type === t;

/** Coupure : le `ssh` de rattachement meurt (groupe entier), l'agent continue sur le serveur. */
function couper(driver: RemoteDriver): void {
  const pid = driver.remoteChild?.attachPid;
  expect(pid).toBeGreaterThan(1);
  process.kill(-pid!, 'SIGKILL');
}

/** Redémarrage du serveur : la session tmux et l'agent disparaissent, exit n'est jamais écrit. */
function redemarrer(home: string, transport: TransportOptions, relayId: string): void {
  execFileSync(FAKE_TMUX, ['kill-session', '-t', `aid-${relayId}`], { env: transport.env });
  tuer(join(home, '.aid-remote/agents', relayId, 'apid'));
}

test('attentes de reconnexion : 1, 2, 5, 10, 30 s', () => {
  expect(RECONNECT_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 10_000, 30_000]);
});

test('claude distant : coupure en plein tour, serveur injoignable un temps, reprise sans perte ni doublon', async () => {
  const { home, transport } = serveur();
  const r = distant(transport, 'sa_c1', 'claude');
  r.driver.send('bonjour');
  await r.attendre(type('turn_end'), 'premier tour');
  expect(r.compte(message('echo: bonjour'))).toBe(1);

  r.driver.send('tour long');
  await r.attendre(message('tour long démarré'), 'tour long');
  // injoignable : les tentatives échouent jusqu'à ce que la connexion revienne
  transport.env!.FAKE_SSH_FAIL = '1';
  couper(r.driver);
  await r.attendre(type('connection_lost'), 'connexion perdue');
  await new Promise((res) => setTimeout(res, 400));
  expect(r.compte(type('connection_resumed'))).toBe(0);
  delete transport.env!.FAKE_SSH_FAIL;
  await r.attendre(type('connection_resumed'), 'connexion rétablie');
  expect(r.events.find((e) => e.type === 'connection_resumed')).toMatchObject({
    sessionFound: true,
  });
  expect(r.compte(type('connection_lost'))).toBe(1);

  // l'interruption passe par le nouveau rattachement ; le tour se ferme, rien n'est rejoué
  r.driver.interrupt();
  await r.attendre(type('turn_end'), 'tour interrompu', 2);
  r.driver.send('encore');
  await r.attendre(message('echo: encore'), 'tour suivant');
  expect(r.compte(message('tour long démarré'))).toBe(1);
  expect(r.compte(message('echo: bonjour'))).toBe(1);
  expect(r.compte(type('exit'))).toBe(0);
  expect(r.created).toHaveLength(1);

  await r.driver.stop();
  expect(r.compte(type('exit'))).toBe(1);
  expect(existsSync(join(home, '.aid-remote/agents/sa_c1'))).toBe(false);
});

test('codex distant : coupure en plein tour, reprise, interruption', async () => {
  const { transport } = serveur();
  const r = distant(transport, 'sa_x1', 'codex');
  r.driver.send('bonjour');
  await r.attendre(type('turn_end'), 'premier tour');
  const tours = r.compte(type('turn_end'));

  r.driver.send('tour long');
  await new Promise((res) => setTimeout(res, 300));
  couper(r.driver);
  await r.attendre(type('connection_resumed'), 'connexion rétablie');
  // la réponse à turn/start a pu arriver par le nouveau rattachement : le pilote doit la connaître
  await new Promise((res) => setTimeout(res, 300));
  r.driver.interrupt();
  await r.attendre(type('turn_end'), 'tour interrompu', tours + 1);
  expect(r.events.filter((e) => e.type === 'turn_end').at(-1)).toMatchObject({
    ok: false,
    error: 'interrompu',
  });
  r.driver.send('encore');
  await r.attendre(type('turn_end'), 'tour suivant', tours + 2);
  expect(r.compte(type('exit'))).toBe(0);
});

test('session disparue : tour en cours fermé, relance par --resume, le fil continue', async () => {
  const { home, transport } = serveur();
  const r = distant(transport, 'sa_c2', 'claude');
  r.driver.send('bonjour');
  await r.attendre(type('turn_end'), 'premier tour');
  const sid = r.driver.sessionId;

  r.driver.send('tour long');
  await r.attendre(message('tour long démarré'), 'tour long');
  redemarrer(home, transport, 'sa_c2');
  await r.attendre(type('connection_resumed'), 'reprise');
  expect(r.events.find((e) => e.type === 'connection_resumed')).toMatchObject({
    sessionFound: false,
  });
  expect(r.events).toContainEqual({ type: 'turn_end', ok: false, error: LOST_MESSAGE });
  expect(r.created).toEqual([
    { sessionId: sid, resume: false },
    { sessionId: sid, resume: true },
  ]);
  // la sortie du nouvel agent repart de zéro : le relancé a bien reçu --resume
  const out = readFileSync(join(home, '.aid-remote/agents/sa_c2/out'), 'utf8');
  expect(out).toContain('"mode":"resume"');
  expect(r.driver.committedOffset).toBeLessThanOrEqual(Buffer.byteLength(out));

  r.driver.send('encore');
  await r.attendre(message('echo: encore'), 'tour après reprise');
  expect(r.compte(type('exit'))).toBe(0);
  expect(r.compte(type('resume_failed'))).toBe(0);
});

test('reprise impossible : resume_failed puis fin, avec la raison', async () => {
  const { home, transport } = serveur();
  const r = distant(transport, 'sa_c3', 'claude');
  r.driver.send('bonjour');
  await r.attendre(type('turn_end'), 'premier tour');
  transport.env!.FAKE_TMUX_FAIL = '1';
  redemarrer(home, transport, 'sa_c3');
  await r.attendre(type('exit'), 'fin');
  const echec = r.events.find((e) => e.type === 'resume_failed');
  expect(echec).toMatchObject({ reason: expect.stringContaining('tmux new-session a échoué') });
  expect(r.events.indexOf(echec!)).toBeLessThan(r.events.findIndex((e) => e.type === 'exit'));
});

test('serveur injoignable au lancement : fin immédiate avec le message de ssh', async () => {
  const { transport } = serveur();
  transport.env!.FAKE_SSH_FAIL = '1';
  const r = distant(transport, 'sa_c4', 'claude');
  await r.attendre(type('exit'), 'fin');
  expect(r.events.find((e) => e.type === 'exit')).toMatchObject({
    message: expect.stringContaining('Connection refused'),
  });
  expect(r.compte(type('connection_lost'))).toBe(0);
});

test('agent introuvable sur le serveur : code et fin de la sortie d’erreur dans le exit', async () => {
  const { transport } = serveur();
  const r = distant(transport, 'sa_c5', 'claude', '/nulle/part/claude');
  await r.attendre(type('exit'), 'fin');
  const exit = r.events.find((e) => e.type === 'exit');
  expect(exit).toMatchObject({ code: 127, message: expect.stringContaining('/nulle/part/claude') });
});

test('reprise refusée par l’agent après la connexion : resume_failed avec sa sortie d’erreur', async () => {
  const { home, transport } = serveur();
  const r = distant(transport, 'sa_c6', 'claude', FAKE_CLAUDE, '/nulle/part/claude');
  r.driver.send('bonjour');
  await r.attendre(type('turn_end'), 'premier tour');
  redemarrer(home, transport, 'sa_c6');
  await r.attendre(type('exit'), 'fin');
  expect(r.events.find((e) => e.type === 'resume_failed')).toMatchObject({
    reason: expect.stringContaining('/nulle/part/claude'),
  });
});

test(`session perdue ${MAX_RESUMES + 1} fois sans un tour réussi : plus de reprise`, async () => {
  const { home, transport } = serveur();
  const r = distant(transport, 'sa_c7', 'claude');
  r.driver.send('bonjour');
  await r.attendre(type('turn_end'), 'premier tour');
  for (let n = 1; n <= MAX_RESUMES; n++) {
    redemarrer(home, transport, 'sa_c7');
    await r.attendre(type('connection_resumed'), `reprise ${n}`, n);
    await waitFor(
      () => existsSync(join(home, '.aid-remote/agents/sa_c7/apid')),
      10_000,
      `relance ${n}`,
    );
  }
  redemarrer(home, transport, 'sa_c7');
  await r.attendre(type('exit'), 'fin');
  expect(r.created).toHaveLength(MAX_RESUMES + 1);
  expect(r.events.find((e) => e.type === 'resume_failed')).toMatchObject({
    reason: expect.stringContaining('fois de suite'),
  });
});

test('arrêt du daemon : detach laisse l’agent au serveur, stop rend la main sans attendre', async () => {
  const { transport } = serveur();
  const r = distant(transport, 'sa_c8', 'claude');
  r.driver.send('bonjour');
  await r.attendre(type('turn_end'), 'premier tour');
  r.driver.detach();
  await r.driver.stop();
  expect(r.compte(type('exit'))).toBe(0);
  const alive = execFileSync(FAKE_SSH, ['vps', 'sh ~/.aid-remote/aid-relay alive sa_c8'], {
    env: transport.env,
    encoding: 'utf8',
  });
  expect(alive.trim()).toBe('vivant');
});

test('arrêt pendant que le serveur est injoignable : le exit dit que l’agent tourne peut-être encore', async () => {
  const { transport } = serveur();
  const r = distant(transport, 'sa_c9', 'claude');
  r.driver.send('bonjour');
  await r.attendre(type('turn_end'), 'premier tour');
  transport.env!.FAKE_SSH_FAIL = '1';
  couper(r.driver);
  await r.attendre(type('connection_lost'), 'connexion perdue');
  await r.driver.stop();
  expect(r.events.find((e) => e.type === 'exit')).toMatchObject({
    message: expect.stringContaining('tourne peut-être encore'),
  });
  // décision D.2 : l'arrêt n'est pas confirmé, une suppression le saura
  expect(r.driver.remoteChild?.stoppedOnServer).toBe(false);
  delete transport.env!.FAKE_SSH_FAIL;
});

test('session disparue avec une demande ouverte : la carte est annulée avant la reprise (review complète, déjà tenu par les pilotes)', async () => {
  const { home, transport } = serveur();
  const r = distant(transport, 'sa_c9', 'claude');
  r.driver.send('demande permission');
  await r.attendre(type('request'), 'demande');
  const demande = r.events.find((e) => e.type === 'request');
  const id = demande?.type === 'request' ? demande.request.id : '';
  redemarrer(home, transport, 'sa_c9');
  await r.attendre(type('connection_resumed'), 'reprise');
  const annulee = r.events.findIndex((e) => e.type === 'request_cancelled' && e.requestId === id);
  expect(annulee).toBeGreaterThanOrEqual(0);
  expect(annulee).toBeLessThan(r.events.findIndex((e) => e.type === 'connection_resumed'));
  expect(r.compte(type('request_cancelled'))).toBe(1);
});

test('demande répondue puis session disparue : rien à annuler', async () => {
  const { home, transport } = serveur();
  const r = distant(transport, 'sa_c10', 'claude');
  r.driver.send('demande permission');
  await r.attendre(type('request'), 'demande');
  const demande = r.events.find((e) => e.type === 'request');
  r.driver.answer(demande?.type === 'request' ? demande.request.id : '', 'yes');
  await r.attendre(type('turn_end'), 'fin du tour');
  redemarrer(home, transport, 'sa_c10');
  await r.attendre(type('connection_resumed'), 'reprise');
  expect(r.compte(type('request_cancelled'))).toBe(0);
});

test('kill du process distant (délai du pilote) : arrêt sur le serveur, confirmé (décision D.2)', async () => {
  const { transport } = serveur();
  const r = distant(transport, 'sa_c11', 'claude');
  r.driver.send('bonjour');
  await r.attendre(type('turn_end'), 'premier tour');
  const child = r.driver.remoteChild!;
  expect(child.stoppedOnServer).toBeNull();
  expect(child.kill('SIGKILL')).toBe(true);
  // un second signal pendant l'arrêt ne relance rien
  expect(child.kill()).toBe(true);
  await r.attendre(type('exit'), 'fin');
  expect(r.compte(type('exit'))).toBe(1);
  expect(child.stoppedOnServer).toBe(true);
  const alive = execFileSync(FAKE_SSH, ['vps', 'sh ~/.aid-remote/aid-relay alive sa_c11'], {
    env: transport.env,
    encoding: 'utf8',
  });
  expect(alive.trim()).toBe('inconnu');
});

test('agent effacé du serveur pendant une coupure : au retour du lien, fin « agent inconnu », sans relance', async () => {
  const { home, transport } = serveur();
  const r = distant(transport, 'sa_c12', 'claude');
  r.driver.send('bonjour');
  await r.attendre(type('turn_end'), 'premier tour');
  transport.env!.FAKE_SSH_FAIL = '1';
  couper(r.driver);
  await r.attendre(type('connection_lost'), 'connexion perdue');
  // arrêté et effacé par ailleurs (nettoyage manuel du serveur) pendant que le lien est coupé
  redemarrer(home, transport, 'sa_c12');
  rmSync(join(home, '.aid-remote/agents/sa_c12'), { recursive: true, force: true });
  delete transport.env!.FAKE_SSH_FAIL;
  await r.attendre(type('exit'), 'fin');
  expect(r.events.find((e) => e.type === 'exit')).toMatchObject({
    message: expect.stringContaining('agent inconnu sur le serveur'),
  });
  // rien n'a été relancé : ni reprise, ni nouveau dossier d'agent
  expect(r.created).toHaveLength(1);
  expect(existsSync(join(home, '.aid-remote/agents/sa_c12'))).toBe(false);
});
