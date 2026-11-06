import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, delimiter, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { resolveOnPath } from '../src/daemon/pty/spawn.js';
import type { Fournisseurs, MachineLocale, MachineServeur, Server } from '../src/shared/model.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

// Chantier 29 : les routes de l'écran Machines. Jamais le vrai claude ni le vrai codex : le PATH ne garde que les
// faux (test/fixtures/bin-stream), git et le système.
const STREAM_BIN = join(import.meta.dirname, 'fixtures/bin-stream');
const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
const SYS = [dirname(resolveOnPath('git', saved.PATH ?? '')!), '/usr/bin', '/bin'].join(delimiter);
let t: TestDaemon | undefined;

afterEach(async () => {
  process.env.PATH = saved.PATH;
  if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.CODEX_HOME;
  await t?.d.stop();
  t = undefined;
});

const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  t!.d.app.inject({ method, url, headers: t!.headers, payload: payload as never });

/**
 * Le « serveur » est la machine de test, par le faux ssh (HOME distant = AID_HOME temporaire). Son profil fixe un
 * PATH : `bin/` (les faux agents posés ici), puis le système pour `head`, `grep` et `vm_stat`.
 */
function remote(home: string, bins: Record<string, string>): void {
  const bin = join(home, 'bin');
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true });
  for (const [b, corps] of Object.entries(bins)) {
    writeFileSync(join(bin, b), `#!/bin/sh\n${corps}\n`);
    chmodSync(join(bin, b), 0o755);
  }
  writeFileSync(join(home, '.bash_profile'), `PATH='${bin}:/usr/bin:/bin'\n`);
}

async function create(body: Record<string, unknown> = {}): Promise<Server> {
  const r = await req('POST', '/api/servers', {
    name: 'vps',
    mode: 'ssh_alias',
    target: 'vps',
    ...body,
  });
  expect(r.statusCode).toBe(201);
  return r.json<Server>();
}

const diagnostiquer = async (id: string) => {
  const r = await req('POST', `/api/machines/serveurs/${id}/diagnostic`);
  expect(r.statusCode).toBe(200);
  return r.json<MachineServeur>();
};

test('D154 : le Mac, ses agents et versions, le transport et la mémoire', async () => {
  t = await startTestDaemon(undefined, { config: { agents: { transport: 'stream' } } });
  process.env.PATH = `${STREAM_BIN}${delimiter}${SYS}`;
  const r = await req('GET', '/api/machines/local');
  expect(r.statusCode).toBe(200);
  const m = r.json<MachineLocale>();
  expect(m.agents.map((a) => [a.kind, a.trouve, a.version])).toEqual([
    ['claude', true, '2.1.0'],
    ['codex', true, expect.any(String)],
  ]);
  expect(m.transport).toBe('stream');
  expect(Number.isNaN(Date.parse(m.mesureA))).toBe(false);
  if (process.platform === 'darwin' || process.platform === 'linux') {
    expect(m.memoire?.octets).toBeGreaterThan(0);
    expect(m.memoire?.mesureA).toBe(m.mesureA);
  }
});

test('D154 : sans agent dans le PATH, rien de trouvé ; le transport PTY est dit', async () => {
  t = await startTestDaemon(undefined, { config: { agents: { transport: 'pty' } } });
  process.env.PATH = SYS;
  const m = (await req('GET', '/api/machines/local')).json<MachineLocale>();
  expect(m.agents.map((a) => a.trouve)).toEqual([false, false]);
  expect(m.transport).toBe('pty');
});

test('D155 : diagnostic complet, test de connexion, versions et mémoire, relus ensuite', async () => {
  t = await startTestDaemon();
  remote(t.home, {
    claude: 'echo "2.1.0 (Claude Code)"',
    codex: 'echo "codex-cli 0.50.0"',
    tmux: 'exit 0',
  });
  const s = await create();
  const d = await diagnostiquer(s.id);
  expect(d.test?.ok).toBe(true);
  expect(d.test?.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  expect(d.versions).toEqual({ claude: '2.1.0', codex: '0.50.0' });
  if (process.platform === 'darwin' || process.platform === 'linux')
    expect(d.memoire?.octets).toBeGreaterThan(0);
  expect(d.mesureA).not.toBeNull();

  const liste = (await req('GET', '/api/machines/serveurs')).json<MachineServeur[]>();
  expect(liste).toHaveLength(1);
  expect(liste[0]!.versions).toEqual(d.versions);
  const server = (await req('GET', `/api/servers/${s.id}`)).json<Server>();
  expect(server.detectedAgents).toEqual(['claude', 'codex']);
});

test('D155 : un agent qui ne dit pas sa version reste trouvé, sans version', async () => {
  t = await startTestDaemon();
  remote(t.home, { claude: 'exit 1', tmux: 'exit 0' });
  const d = await diagnostiquer((await create()).id);
  expect(d.versions).toEqual({ claude: null });
});

test('D155 : le test échoue avant le shell, ni versions ni mémoire', async () => {
  t = await startTestDaemon();
  const s = await create({ mode: 'command', target: 'aid-absent-xyz vps', loadProfile: false });
  const d = await diagnostiquer(s.id);
  expect(d.test?.ok).toBe(false);
  expect(d.test?.steps[0]!.state).toBe('failed');
  expect(d.versions).toBeNull();
  expect(d.memoire).toBeNull();
});

test('D155 : jamais diagnostiqué, inconnu, puis supprimé avec le serveur', async () => {
  t = await startTestDaemon();
  remote(t.home, { claude: 'echo 2.1.0' });
  const s = await create();
  expect((await req('GET', '/api/machines/serveurs')).json<MachineServeur[]>()).toEqual([
    { serverId: s.id, test: null, versions: null, memoire: null, mesureA: null },
  ]);
  expect((await req('POST', '/api/machines/serveurs/sv_absent/diagnostic')).statusCode).toBe(404);
  await diagnostiquer(s.id);
  expect((await req('DELETE', `/api/servers/${s.id}`)).statusCode).toBe(204);
  expect((await req('GET', '/api/machines/serveurs')).json<MachineServeur[]>()).toEqual([]);
  expect(t.db.prepare('SELECT count(*) AS n FROM server_diagnostics').get()).toEqual({ n: 0 });
});

test('D159 : les fournisseurs, sans valeur de secret ; le dossier de codex vient de CODEX_HOME', async () => {
  t = await startTestDaemon();
  process.env.CODEX_HOME = join(t.home, 'codex');
  mkdirSync(process.env.CODEX_HOME);
  writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), '{"token":"synthetique-0000"}');
  const r = await req('GET', '/api/machines/fournisseurs');
  expect(r.statusCode).toBe(200);
  const f = r.json<Fournisseurs>();
  // la recherche mémoire du daemon de test est coupée : pas d'Ollama
  expect(f.fournisseurs.map((x) => x.id)).toEqual(['anthropic', 'openai']);
  expect(f.alertes.map((a) => a.id)).toContain('codex:auth.json');
  expect(r.body).not.toContain('synthetique-0000');
});
