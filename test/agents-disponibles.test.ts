import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { resolveOnPath } from '../src/daemon/pty/spawn.js';
import type { AgentsDisponibles } from '../src/shared/model.js';
import { commitFile, sh } from './helpers/git.js';
import { type Ctx, setupWorkspace } from './helpers/topics.js';

// Chantier 28 (D143) : ce que l'écran Nouveau sujet vérifie à l'instant. Jamais le vrai claude ni le vrai codex :
// le PATH ne garde que les faux, git et le système.
const STREAM_BIN = join(import.meta.dirname, 'fixtures/bin-stream');
const saved = { PATH: process.env.PATH };
// les faux sont des scripts bash : /usr/bin et /bin restent, sans claude ni codex
const SYS = [dirname(resolveOnPath('git', saved.PATH ?? '')!), '/usr/bin', '/bin'].join(delimiter);
let c: Ctx | undefined;

afterEach(async () => {
  process.env.PATH = saved.PATH;
  await c?.t.d.stop();
  c = undefined;
});

const lire = async (query = '') => {
  const r = await c!.t.d.app.inject({
    method: 'GET',
    url: `/api/agents/disponibles${query}`,
    headers: c!.t.headers,
  });
  return { status: r.statusCode, body: r.json<AgentsDisponibles>() };
};

test('trouvés : version synthétique, options du composer ; sans projet, pas de retard', async () => {
  c = await setupWorkspace();
  process.env.PATH = `${STREAM_BIN}${delimiter}${SYS}`;
  const { status, body } = await lire();
  expect(status).toBe(200);
  expect(body.baseEnRetard).toBeNull();
  expect(body.agents.map((a) => [a.kind, a.trouve, a.version])).toEqual([
    ['claude', true, '2.1.0'],
    ['codex', true, '0.50.0'],
  ]);
  expect(body.agents[0]!.options.modes.length).toBeGreaterThan(0);
});

test('introuvable, et version en échec : trouvé mais sans version', async () => {
  c = await setupWorkspace();
  const bin = mkdtempSync(join(tmpdir(), 'aid-dispo-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "refusé" >&2\nexit 3\n');
  chmodSync(join(bin, 'claude'), 0o755);
  process.env.PATH = `${bin}${delimiter}${SYS}`;
  const { body } = await lire();
  expect(body.agents.map((a) => [a.kind, a.trouve, a.version])).toEqual([
    ['claude', true, null],
    ['codex', false, null],
  ]);
});

test('base en retard sur origin, sans fetch ; origin inconnu : null ; projet inconnu : 404', async () => {
  c = await setupWorkspace();
  process.env.PATH = `${STREAM_BIN}${delimiter}${SYS}`;
  expect((await lire(`?workspaceId=${c.ws.id}`)).body.baseEnRetard).toBe(0);
  // deux commits poussés, puis la main locale revient en arrière : main a deux commits de retard
  commitFile(c.clone, 'a.txt', 'a\n', 'a');
  commitFile(c.clone, 'b.txt', 'b\n', 'b');
  sh(c.clone, 'push', '-q', 'origin', 'main');
  sh(c.clone, 'reset', '-q', '--hard', 'HEAD~2');
  expect((await lire(`?workspaceId=${c.ws.id}`)).body.baseEnRetard).toBe(2);
  expect((await lire('?workspaceId=ws_inconnu')).status).toBe(404);
  await c.t.d.stop();
  c = await setupWorkspace({ local: true });
  expect((await lire(`?workspaceId=${c.ws.id}`)).body.baseEnRetard).toBeNull();
});
