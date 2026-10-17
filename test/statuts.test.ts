import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDb } from '../src/daemon/db.js';
import { isSubSession, sanitizePending } from '../src/daemon/events/status.js';
import { EventStore } from '../src/daemon/events/store.js';
import { buildSnapshot } from '../src/daemon/state/snapshot.js';
import { StructuralService } from '../src/daemon/structural/service.js';
import type { EventSource } from '../src/shared/events.js';

function setup() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'aid-st-')), 'state.db'));
  db.prepare(
    "INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at) VALUES ('ws_1','a','/a','main','/w','t0')",
  ).run();
  db.prepare(
    "INSERT INTO topics (id, workspace_id, slug, title, type, branch, base, worktree, state, phase, index_state, created_at, updated_at) VALUES ('tp_1','ws_1','s','T','feat','feat/s','main','/w/s','active',NULL,'disabled','t0','t0')",
  ).run();
  db.prepare("INSERT INTO runs VALUES ('run_1','tp_1','standard','open','t0')").run();
  db.prepare(
    "INSERT INTO agents (id, run_id, kind, role, transport, status, cwd, command, pid, exit_code, issue, created_at, updated_at) VALUES ('ag_1','run_1','claude','free','pty','starting','/w/s','[]',4242,NULL,NULL,'t0','t0')",
  ).run();
  const store = new EventStore(db);
  const status = (source: EventSource, data: Record<string, unknown>) =>
    store.append({ source, type: 'agent.status', agentId: 'ag_1', data });
  // hors sujet ici (pas de worktree valable) : le moteur reste off, l'index n'est pas testé par ce fichier.
  const engine = new StructuralService({ engine: 'off' });
  const agent = async () => (await buildSnapshot(db, engine)).agents[0]!;
  return { db, store, status, agent };
}

const permission = {
  id: 'tu_1',
  kind: 'permission',
  question: 'autoriser Bash(npm test) ?',
  options: [
    { label: 'Autoriser une fois', answer: 'yes' },
    { label: 'Refuser', answer: 'no' },
  ],
};

test('un hook needs_input : statut, raison, message et demande arrivent dans l’instantané', async () => {
  const { status, agent } = setup();
  status('hook:claude', {
    status: 'needs_input',
    reason: 'permission',
    message: 'Claude needs your permission',
    pending: permission,
  });
  expect(await agent()).toMatchObject({
    status: 'needs_input',
    statusReason: 'permission',
    statusMessage: 'Claude needs your permission',
    statusSource: 'hook',
    pending: permission,
  });
  status('hook:claude', { status: 'working' });
  expect(await agent()).toMatchObject({ status: 'working', statusReason: null, pending: null });
});

test('l’heuristique se tait dès qu’un hook a parlé, et porte son détail sinon', async () => {
  const { status, agent } = setup();
  status('heuristic', { status: 'idle', silenceMs: 31_000, lastLine: '$ ', promptDetected: false });
  expect(await agent()).toMatchObject({
    status: 'idle',
    statusSource: 'heuristic',
    statusDetail: { silenceMs: 31_000, lastLine: '$ ', promptDetected: false },
  });
  status('hook:claude', { status: 'working' });
  status('heuristic', { status: 'idle', silenceMs: 60_000 });
  expect(await agent()).toMatchObject({
    status: 'working',
    statusSource: 'hook',
    statusDetail: null,
  });
});

test('une sous-session (claude -p lancé par l’agent) ne change pas le statut', async () => {
  const { status, agent } = setup();
  status('hook:claude', { status: 'working' });
  status('hook:claude', {
    status: 'idle',
    chain: [
      { pid: 10, comm: 'sh' },
      { pid: 11, comm: 'claude' },
      { pid: 12, comm: 'bash' },
      { pid: 4242, comm: 'claude' },
    ],
  });
  expect((await agent()).status).toBe('working');
  // la session de l'agent lui-même : seuls des shells entre le hook et lui
  status('hook:claude', {
    status: 'idle',
    chain: [
      { pid: 10, comm: '/bin/sh' },
      { pid: 4242, comm: 'claude' },
    ],
  });
  expect((await agent()).status).toBe('idle');
});

test('après la fin, un statut rejoué en retard ne ressuscite pas l’agent', async () => {
  const { store, status, agent } = setup();
  store.append({
    source: 'daemon',
    type: 'agent.exited',
    agentId: 'ag_1',
    data: { exitCode: 0, reason: 'exit' },
  });
  status('hook:claude', { status: 'working' });
  store.append({
    source: 'hook:claude',
    type: 'agent.tool',
    agentId: 'ag_1',
    data: { label: 'x' },
  });
  expect(await agent()).toMatchObject({ status: 'done', lastTool: null });
});

test('un agent ne peut ni se dire terminé, ni se mettre en pause ; le daemon, si', async () => {
  const { status, agent } = setup();
  status('hook:claude', { status: 'done' });
  status('hook:claude', { paused: true });
  expect(await agent()).toMatchObject({ status: 'starting', pausedAt: null });
  status('daemon', { paused: true });
  expect((await agent()).pausedAt).not.toBeNull();
  expect((await agent()).status).toBe('starting');
  status('daemon', { paused: false });
  expect((await agent()).pausedAt).toBeNull();
});

test('approval.resolved ne vide que la demande qu’il nomme', async () => {
  const { store, status, agent } = setup();
  status('hook:claude', { status: 'needs_input', reason: 'permission', pending: permission });
  const resolve = (pendingId: string) =>
    store.append({
      source: 'daemon',
      type: 'approval.resolved',
      agentId: 'ag_1',
      data: { pendingId, option: 'yes', by: 'human' },
    });
  resolve('autre');
  expect((await agent()).pending?.id).toBe('tu_1');
  expect((await agent()).status).toBe('needs_input');
  resolve('tu_1');
  expect((await agent()).pending).toBeNull();
});

test('une demande résolue ne laisse pas l’agent « en attente » : répondue il repart, refusée la main revient', async () => {
  const { store, status, agent } = setup();
  const resolve = (option: string) =>
    store.append({
      source: 'daemon',
      type: 'approval.resolved',
      agentId: 'ag_1',
      data: { pendingId: 'tu_1', option, by: 'human' },
    });
  status('hook:claude', { status: 'needs_input', reason: 'permission', pending: permission });
  resolve('yes');
  expect(await agent()).toMatchObject({
    status: 'working',
    statusReason: null,
    statusSource: 'hook',
  });
  status('hook:claude', { status: 'needs_input', reason: 'permission', pending: permission });
  resolve('no');
  expect(await agent()).toMatchObject({ status: 'idle', pending: null });
  // une résolution en retard, l'agent déjà reparti : rien ne bouge
  status('hook:claude', { status: 'working' });
  resolve('no');
  expect((await agent()).status).toBe('working');
});

test('la sortie de l’agent efface la demande et la pause', async () => {
  const { store, status, agent } = setup();
  status('hook:claude', { status: 'needs_input', reason: 'permission', pending: permission });
  status('daemon', { paused: true });
  store.append({
    source: 'daemon',
    type: 'agent.exited',
    agentId: 'ag_1',
    data: { exitCode: 1, reason: 'exit' },
  });
  expect(await agent()).toMatchObject({ status: 'error', pending: null, pausedAt: null });
});

test('une demande est assainie : jamais de touche fournie par l’agent, tailles bornées', () => {
  const p = sanitizePending({
    id: 'x',
    kind: 'question',
    question: 'q'.repeat(900),
    options: [
      { label: 'Point-virgule', answer: '1' },
      { label: 'Piège', answer: '\u001b[201~rm -rf /\r' },
      { label: 'Virgule', answer: '2', key: 'y' },
    ],
  });
  expect(p).toEqual({
    id: 'x',
    kind: 'question',
    question: 'q'.repeat(500),
    options: [
      { label: 'Point-virgule', answer: '1' },
      { label: 'Virgule', answer: '2' },
    ],
  });
  expect(sanitizePending({ id: 'x', kind: 'autre', question: 'q' })).toBeNull();
});

test('lignée inconnue ou agent absent de la lignée : l’événement compte', () => {
  expect(isSubSession(undefined, 1)).toBe(false);
  expect(isSubSession([{ pid: 2, comm: 'claude' }], 1)).toBe(false);
  expect(isSubSession([{ pid: 1, comm: 'claude' }], null)).toBe(false);
  expect(
    isSubSession(
      [
        { pid: 3, comm: '-zsh' },
        { pid: 1, comm: 'claude' },
      ],
      1,
    ),
  ).toBe(false);
});
