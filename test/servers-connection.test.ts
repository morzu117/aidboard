import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Server, ServerStatus, ServerTest } from '../src/shared/model.js';
import { FAKE_SSH, startTestDaemon, type TestDaemon, waitFor } from './helpers/daemon.js';

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
});

type Msg = { kind: string; type: string; test?: ServerTest; status?: ServerStatus };

const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  t!.d.app.inject({ method, url, headers: t!.headers, payload: payload as never });

/**
 * Le « serveur » est la machine de test, via le faux ssh (HOME distant = AID_HOME temporaire). Son
 * profil fixe un PATH qui ne contient que `bin/` : ce qu'on y pose est tout ce que le serveur connaît.
 */
function remote(home: string, bins: string[]): void {
  const bin = join(home, 'bin');
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true });
  for (const b of bins) {
    writeFileSync(join(bin, b), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, b), 0o755);
  }
  writeFileSync(join(home, '.bash_profile'), `PATH='${bin}'\n`);
}

function listen(): Msg[] {
  const got: Msg[] = [];
  t!.store.on('ephemeral', (m: Msg) => got.push(structuredClone(m)));
  return got;
}

async function create(body: Record<string, unknown> = {}): Promise<Server> {
  const r = await req('POST', '/api/servers', {
    name: 'vps-ovh',
    mode: 'ssh_alias',
    target: 'vps',
    ...body,
  });
  expect(r.statusCode).toBe(201);
  return r.json<Server>();
}

async function finished(got: Msg[]): Promise<ServerTest> {
  const m = await waitFor(
    () => got.find((x) => x.type === 'server.test' && x.test?.finishedAt),
    10_000,
    'fin du test',
  );
  return m.test!;
}

test('test complet réussi : étapes dans l’ordre, agents enregistrés, état connecté', async () => {
  t = await startTestDaemon();
  remote(t.home, ['claude', 'codex', 'tmux']);
  const s = await create();
  const got = listen();

  const r = await req('POST', `/api/servers/${s.id}/test`);
  expect(r.statusCode).toBe(202);
  expect(r.json<ServerTest>()).toMatchObject({ serverId: s.id, finishedAt: null, ok: null });
  expect(r.json<ServerTest>().steps.map((x) => x.id)).toEqual([
    'command',
    'shell',
    'workdir',
    'agents',
    'session',
  ]);

  const done = await finished(got);
  expect(done).toMatchObject({ ok: true, error: null });
  expect(done.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  expect(done.steps[0]!.detail).toBe(FAKE_SSH);
  expect(done.steps[1]!.detail).toMatch(/^\d+ ms$/);
  expect(done.steps[2]!.detail).toBe(t.home);
  expect(done.steps[3]!.detail).toBe('claude · codex');
  expect(done.raw).toContain('$ agents');

  // progression publiée au fil de l'eau : chaque étape passe par « running » avant son résultat
  const states = got
    .filter((m) => m.type === 'server.test')
    .map((m) => m.test!.steps.find((x) => x.id === 'workdir')!.state);
  expect(states).toContain('running');

  const after = (await req('GET', `/api/servers/${s.id}`)).json<Server>();
  expect(after.detectedAgents).toEqual(['claude', 'codex']);
  expect(after.lastTestAt).toBe(done.finishedAt);
  expect(after.updatedAt).toBe(s.updatedAt);

  const status = got.filter((m) => m.type === 'server.status').at(-1)!.status!;
  expect(status).toMatchObject({ serverId: s.id, state: 'connected', reason: null });
  expect(status.latencyMs).toBeGreaterThanOrEqual(0);
  expect((await req('GET', `/api/servers/${s.id}/test`)).json()).toEqual(done);
});

test('connexion refusée : injoignable, étapes suivantes sautées, agents inchangés', async () => {
  t = await startTestDaemon(undefined, {
    remote: { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_FAIL: '1' } },
  });
  const s = await create();
  const got = listen();
  await req('POST', `/api/servers/${s.id}/test`);
  const done = await finished(got);
  expect(done.ok).toBe(false);
  expect(done.error).toContain('Connection refused');
  expect(done.steps.map((x) => x.state)).toEqual(['ok', 'failed', 'skipped', 'skipped', 'skipped']);
  const status = (await req('GET', '/api/servers/status')).json<ServerStatus[]>()[0]!;
  expect(status).toMatchObject({ state: 'unreachable', latencyMs: null });
  expect(status.reason).toContain('Connection refused');
  const after = (await req('GET', `/api/servers/${s.id}`)).json<Server>();
  expect(after.detectedAgents).toBeNull();
  expect(after.lastTestAt).toBe(done.finishedAt);
});

test('répertoire absent, aucun agent, tmux absent : l’étape en échec dit pourquoi', async () => {
  t = await startTestDaemon();
  remote(t.home, ['claude']);
  const missingDir = await create({ workdir: '~/nulle-part' });
  let got = listen();
  await req('POST', `/api/servers/${missingDir.id}/test`);
  let done = await finished(got);
  expect(done.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'failed', 'skipped', 'skipped']);
  expect(done.error).toContain('~/nulle-part inaccessible');

  const noTmux = await create({ name: 'sans-tmux' });
  got = listen();
  await req('POST', `/api/servers/${noTmux.id}/test`);
  done = await finished(got);
  expect(done.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'failed']);
  expect(done.error).toContain('tmux absent');
  // agents trouvés avant l'échec : gardés
  expect((await req('GET', `/api/servers/${noTmux.id}`)).json<Server>().detectedAgents).toEqual([
    'claude',
  ]);

  // session persistante non demandée : étape sautée, test réussi
  const sansSession = await create({ name: 'sans-session', keepSession: false });
  got = listen();
  await req('POST', `/api/servers/${sansSession.id}/test`);
  done = await finished(got);
  expect(done.ok).toBe(true);
  expect(done.steps.at(-1)).toMatchObject({ state: 'skipped', detail: 'désactivée' });

  remote(t.home, []);
  const aucun = await create({ name: 'aucun-agent' });
  got = listen();
  await req('POST', `/api/servers/${aucun.id}/test`);
  done = await finished(got);
  expect(done.steps.find((x) => x.id === 'agents')!.state).toBe('failed');
  expect((await req('GET', `/api/servers/${aucun.id}`)).json<Server>().detectedAgents).toEqual([]);
});

test('ssh introuvable : la première étape échoue sans rien lancer', async () => {
  t = await startTestDaemon(undefined, { remote: { ssh: '/nonexistent/ssh' } });
  const s = await create();
  const got = listen();
  await req('POST', `/api/servers/${s.id}/test`);
  const done = await finished(got);
  expect(done.steps.map((x) => x.state)).toEqual([
    'failed',
    'skipped',
    'skipped',
    'skipped',
    'skipped',
  ]);
  expect(done.error).toContain('/nonexistent/ssh introuvable');
});

test('un seul test à la fois par serveur ; 404 avant le premier', async () => {
  t = await startTestDaemon(undefined, {
    remote: { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_DELAY: '0.3' } },
  });
  const s = await create();
  expect((await req('GET', `/api/servers/${s.id}/test`)).statusCode).toBe(404);
  const got = listen();
  const a = (await req('POST', `/api/servers/${s.id}/test`)).json<ServerTest>();
  const b = (await req('POST', `/api/servers/${s.id}/test`)).json<ServerTest>();
  expect(b.startedAt).toBe(a.startedAt);
  await finished(got);
  expect((await req('POST', '/api/servers/srv_nope/test')).statusCode).toBe(404);
});

test('état : inconnu puis contrôlé à la lecture, ping attendu, oublié à la suppression', async () => {
  t = await startTestDaemon();
  const s = await create();
  const first = (await req('GET', '/api/servers/status')).json<ServerStatus[]>();
  // jamais contrôlé : la lecture lance le contrôle et rend l'état du moment
  expect(['unknown', 'connecting']).toContain(first[0]!.state);

  const ping = await req('POST', `/api/servers/${s.id}/ping`);
  expect(ping.json<ServerStatus>()).toMatchObject({ serverId: s.id, state: 'connected' });
  const again = (await req('GET', '/api/servers/status')).json<ServerStatus[]>();
  expect(again[0]).toMatchObject({ state: 'connected' });
  expect(again[0]!.checkedAt).toBe(ping.json<ServerStatus>().checkedAt);

  await req('DELETE', `/api/servers/${s.id}`);
  expect((await req('GET', '/api/servers/status')).json()).toEqual([]);
  expect((await req('POST', `/api/servers/${s.id}/ping`)).statusCode).toBe(404);
});
