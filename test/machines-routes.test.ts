import { dirname, delimiter, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { resolveOnPath } from '../src/daemon/pty/spawn.js';
import type { MachineLocale } from '../src/shared/model.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

// Chantier 29 : les routes de l'écran Machines. Jamais le vrai claude ni le vrai codex : le PATH ne garde que les
// faux (test/fixtures/bin-stream), git et le système.
const STREAM_BIN = join(import.meta.dirname, 'fixtures/bin-stream');
const saved = { PATH: process.env.PATH };
const SYS = [dirname(resolveOnPath('git', saved.PATH ?? '')!), '/usr/bin', '/bin'].join(delimiter);
let t: TestDaemon | undefined;

afterEach(async () => {
  process.env.PATH = saved.PATH;
  await t?.d.stop();
  t = undefined;
});

const req = (method: 'GET' | 'POST', url: string) =>
  t!.d.app.inject({ method, url, headers: t!.headers });

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
