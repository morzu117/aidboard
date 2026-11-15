import { injecterEnvFauxSwarph } from './helpers/env-faux-swarph.js';
import { mkdtempSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';

injecterEnvFauxSwarph();

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
  vi.unstubAllEnvs();
});
const urls = [
  'cells',
  'federation?q=lecture%20test',
  'memory?tag=test',
  'memory/page?slug=page-test',
  'reglages',
];
const get = (url: string) => t!.d.app.inject({ url: `/api/swarph/${url}`, headers: t!.headers });
async function boot(gateway = 'https://example.com') {
  const home = mkdtempSync(join(tmpdir(), 'aid-swarph-r-'));
  symlinkSync(join(import.meta.dirname, 'fixtures/fake-swarph.sh'), join(home, 'swarph'));
  vi.stubEnv('PATH', `${home}:${process.env.PATH}`);
  vi.stubEnv('FAKE_SWARPH_BOARD', join(import.meta.dirname, 'fixtures/board'));
  const journal = join(home, 'appels');
  writeFileSync(journal, '');
  vi.stubEnv('FAKE_SWARPH_LOG', journal);
  t = await startTestDaemon(home, {
    config: {
      mesh: {
        ...DEFAULT_CONFIG.mesh,
        bin: 'swarph',
        cell: 'peer-a',
        gateway,
        stateRoot: join(home, 'etat'),
        tailscale: { manage: false, bin: join(import.meta.dirname, 'fixtures/fake-tailscale.sh') },
      },
    },
  });
  await waitFor(() => readFileSync(journal, 'utf8').includes('monitor status'));
  return () => readFileSync(journal, 'utf8');
}
function resultats(json: Record<string, unknown>, url: string): unknown[] {
  if (url === 'cells') return [json.peers];
  if (url === 'reglages') return [json.rights];
  if (url.startsWith('memory/page')) return [json.page, json.links];
  return [json];
}

test('chaque route nominale et monitor sans nouvelle commande', async () => {
  const journal = await boot();
  const avant = journal()
    .split('\n')
    .filter((l) => l.startsWith('monitor')).length;
  for (const url of urls) {
    const r = await get(url);
    expect(r.statusCode).toBe(200);
    for (const resultat of resultats(r.json(), url)) expect(resultat).toMatchObject({ ok: true });
  }
  expect(
    journal()
      .split('\n')
      .filter((l) => l.startsWith('monitor')),
  ).toHaveLength(avant);
  await get('cells');
  expect(journal().match(/mesh peers/g)).toHaveLength(1);
  await get('cells?fresh=1');
  expect(journal().match(/mesh peers/g)).toHaveLength(2);
});

test('chaque route classe les erreurs swarph en 200', async () => {
  await boot();
  for (const [mode, kind] of [
    ['forbidden', 'forbidden'],
    ['unreachable', 'unreachable'],
    ['credential', 'credential'],
    ['other', 'unknown'],
    ['too-old', 'too-old'],
  ] as const) {
    vi.stubEnv('FAKE_SWARPH_BOARD_ERROR', mode);
    for (const url of urls) {
      const r = await get(`${url}${url.includes('?') ? '&' : '?'}fresh=1`);
      expect(r.statusCode).toBe(200);
      for (const resultat of resultats(r.json(), url))
        expect(resultat).toMatchObject({ ok: false, kind });
    }
  }
});

test('arguments invalides en 400 sans lancement ; slug avec / en query', async () => {
  const journal = await boot();
  const avant = journal();
  for (const url of [
    'federation?q=-x',
    'federation',
    'federation?q=%00',
    'memory?tag=!',
    'memory?tag=test&type=note',
    'memory?type=Note',
    'memory?type=!',
    'memory/page?slug=..%2Fx',
    'memory/page',
  ])
    expect((await get(url)).statusCode).toBe(400);
  expect(journal()).toBe(avant);
  const r = await get('memory/page?slug=lesson/test');
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ page: { kind: 'not-found' }, links: { kind: 'not-found' } });
});

test('mesh absent : chaque route en 404', async () => {
  t = await startTestDaemon();
  for (const url of urls) expect((await get(url)).statusCode).toBe(404);
});

test('memory sans gateway, no-index et perime', async () => {
  const journal = await boot('');
  const avant = journal();
  expect((await get('memory?tag=test')).json()).toMatchObject({ kind: 'not-configured' });
  expect((await get('memory/page?slug=page-test')).json()).toMatchObject({
    page: { kind: 'not-configured' },
    links: { kind: 'not-configured' },
  });
  expect(journal()).toBe(avant);
  vi.stubEnv('FAKE_SWARPH_CODEGRAPH_MODE', 'no-index');
  expect((await get('federation?q=test')).json()).toMatchObject({ kind: 'no-index' });
  vi.stubEnv('FAKE_SWARPH_CODEGRAPH_MODE', 'stale');
  expect((await get('federation?q=lecture%20test')).json()).toMatchObject({
    ok: true,
    data: { perime: true },
  });
});

test('chaque route rend aussi les erreurs système, format et not-found en 200', async () => {
  await boot();
  const lecture = vi.spyOn(t!.d.mesh!, 'read');
  for (const [details, kind] of [
    [{ spawnErrorCode: 'ENOENT' }, 'absent'],
    [{ timedOut: true }, 'timeout'],
    [{ spawnErrorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'too-large'],
    [{ ok: true, stdout: '?' }, 'format'],
    [{ stderr: 'gateway 404', exitCode: 1 }, 'not-found'],
  ] as const) {
    lecture.mockResolvedValue({ ok: false, timedOut: false, stdout: '', stderr: '', ...details });
    for (const url of urls) {
      const r = await get(`${url}${url.includes('?') ? '&' : '?'}fresh=1`);
      expect(r.statusCode).toBe(200);
      for (const resultat of resultats(r.json(), url))
        expect(resultat).toMatchObject({ ok: false, kind });
    }
  }
});

test('liste sans filtre, tag vide et type', async () => {
  const journal = await boot();
  for (const url of ['memory', 'memory?tag=', 'memory?type=note', 'memory?tag=&type=note']) {
    const r = await get(url);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, data: [{ slug: 'page-sans-tag' }] });
  }
  expect(journal()).toContain('memory list -n 100 --json');
  expect(journal()).toContain('memory list --type note -n 100 --json');
});
