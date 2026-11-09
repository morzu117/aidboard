import { mkdtempSync, symlinkSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { MeshService } from '../src/daemon/mesh/service.js';
import { SwarphReader } from '../src/daemon/mesh/lectures.js';
import { meshExec, type MeshExecResult } from '../src/daemon/mesh/exec.js';

const nettoyages: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  nettoyages.splice(0).forEach((f) => f());
});

function lecteur(gateway = 'https://example.com') {
  const home = mkdtempSync(join(tmpdir(), 'aid-swarph-'));
  symlinkSync(join(import.meta.dirname, 'fixtures/fake-swarph.sh'), join(home, 'swarph'));
  vi.stubEnv('PATH', `${home}:${process.env.PATH}`);
  vi.stubEnv('FAKE_SWARPH_BOARD', join(import.meta.dirname, 'fixtures/board'));
  vi.stubEnv('FAKE_SWARPH_LOG', join(home, 'appels'));
  const db = openDb(join(home, 'state.db'));
  const environnements: NodeJS.ProcessEnv[] = [];
  const service = new MeshService({
    config: {
      ...DEFAULT_CONFIG.mesh,
      bin: 'swarph',
      cell: 'peer-a',
      gateway,
      stateRoot: join(home, 'etat'),
    },
    home,
    db,
    store: new EventStore(db),
    log: () => undefined,
    exec: (bin, args, opts) => {
      environnements.push(opts.env);
      return meshExec(bin, args, opts);
    },
  });
  let temps = 0;
  const reader = new SwarphReader({
    mesh: service,
    cell: 'peer-a',
    gateway,
    log: () => undefined,
    now: () => temps,
  });
  nettoyages.push(() => {
    service.dispose();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    reader,
    service,
    environnements,
    tick: (n: number) => {
      temps += n;
    },
    appels: () =>
      existsSync(join(home, 'appels'))
        ? readFileSync(join(home, 'appels'), 'utf8').trim().split('\n')
        : [],
  };
}

test('six argv fermés, identité et environnement mémoire isolé du daemon', async () => {
  vi.stubEnv('GBRAIN_TOKEN', 'synthetique');
  vi.stubEnv('SWARPH_BRAIN_TOKEN', 'synthetique');
  const t = lecteur();
  expect((await t.reader.peers()).ok).toBe(true);
  expect((await t.reader.rights()).ok).toBe(true);
  expect((await t.reader.codegraph('lecture test')).ok).toBe(true);
  expect((await t.reader.memory('test')).ok).toBe(true);
  const page = await t.reader.page('page-test');
  expect(page.page.ok && page.links.ok).toBe(true);
  expect(t.appels().slice(0, 4)).toEqual([
    'mesh peers --as peer-a',
    'rights --json --as peer-a',
    'codegraph --local --json --limit 50 --caller-cell peer-a -- lecture test',
    'memory list --tag test -n 100 --json',
  ]);
  expect(t.appels().slice(4).sort()).toEqual([
    'memory get page-test --json',
    'memory links page-test --direction both --json',
  ]);
  for (const env of t.environnements) {
    expect(env.GBRAIN_TOKEN).toBeUndefined();
    expect(env.SWARPH_BRAIN_TOKEN).toBeUndefined();
    if (t.environnements.indexOf(env) >= 3)
      expect(env.SWARPH_BRAIN_GATEWAY).toBe('https://example.com');
    expect(env.SWARPH_SELF).toBe('peer-a');
  }
  expect(t.environnements[2]!.SWARPH_SELF).toBe('peer-a');
  expect(process.env.GBRAIN_TOKEN).toBe('synthetique');
  expect(t.reader.monitor()).toEqual(t.service.current());
  expect(t.appels()).toHaveLength(6);
});

test('arguments refusés et gateway absent ne lancent rien', async () => {
  const t = lecteur('');
  await expect(t.reader.codegraph('-x')).rejects.toThrow(RangeError);
  await expect(t.reader.memory('!')).rejects.toThrow(RangeError);
  await expect(t.reader.page('../x')).rejects.toThrow(RangeError);
  expect(await t.reader.memory()).toMatchObject({ kind: 'not-configured' });
  expect(await t.reader.memory('', {}, 'note')).toMatchObject({ kind: 'not-configured' });
  expect(await t.reader.memory('test')).toMatchObject({ kind: 'not-configured' });
  expect(await t.reader.page('page-test')).toMatchObject({
    page: { kind: 'not-configured' },
    links: { kind: 'not-configured' },
  });
  expect(t.appels()).toEqual([]);
});

test('cache 5 s, fresh et fusion, y compris fresh pendant une lecture', async () => {
  const t = lecteur();
  const [a, b] = await Promise.all([t.reader.peers(), t.reader.peers({ fresh: true })]);
  expect(a).toEqual(b);
  expect(t.appels()).toHaveLength(1);
  t.tick(4999);
  await t.reader.peers();
  expect(t.appels()).toHaveLength(1);
  t.tick(1);
  await t.reader.peers();
  expect(t.appels()).toHaveLength(2);
  await t.reader.peers({ fresh: true });
  expect(t.appels()).toHaveLength(3);
});

test('no-index et index périmé', async () => {
  const t = lecteur();
  vi.stubEnv('FAKE_SWARPH_CODEGRAPH_MODE', 'no-index');
  expect(await t.reader.codegraph('lecture test')).toMatchObject({ kind: 'no-index' });
  vi.stubEnv('FAKE_SWARPH_CODEGRAPH_MODE', 'stale');
  expect(await t.reader.codegraph('lecture test', { fresh: true })).toMatchObject({
    ok: true,
    data: { perime: true },
  });
});

test('erreurs système et rejet classés sans texte privé dans le résultat', async () => {
  for (const [exec, kind] of [
    [{ spawnErrorCode: 'ENOENT' }, 'absent'],
    [{ timedOut: true }, 'timeout'],
    [{ spawnErrorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'too-large'],
    [{ stdout: 'illisible', ok: true }, 'format'],
    [{ stdout: '42', ok: true }, 'format'],
    [{ exitCode: 2, stderr: 'NO INDEX AVAILABLE' }, 'no-index'],
  ] as const) {
    const t = lecteur();
    vi.spyOn(t.service, 'read').mockResolvedValue({
      ok: false,
      timedOut: false,
      stdout: '',
      stderr: '',
      ...exec,
    } as MeshExecResult);
    expect(await t.reader.codegraph('test')).toMatchObject({ ok: false, kind });
  }
  const t = lecteur();
  vi.spyOn(t.service, 'read').mockRejectedValue(new Error('privé'));
  expect(await t.reader.peers()).toMatchObject({ kind: 'unknown' });
});

test('page et liens démarrent ensemble et gardent leur résultat propre', async () => {
  const t = lecteur();
  const appels: string[] = [];
  let liberer: () => void = () => undefined;
  const porte = new Promise<void>((resolve) => {
    liberer = resolve;
  });
  const original = t.service.read.bind(t.service);
  vi.spyOn(t.service, 'read').mockImplementation(async (args, options) => {
    appels.push(args[1]!);
    await porte;
    return args[1] === 'links'
      ? { ok: false, timedOut: false, stdout: '', stderr: 'gateway 403', exitCode: 1 }
      : original(args, options);
  });
  const page = t.reader.page('page-test');
  expect(appels).toEqual(['get', 'links']);
  liberer();
  expect(await page).toMatchObject({ page: { ok: true }, links: { ok: false, kind: 'forbidden' } });
});

test('liste sans filtre, tag vide et type : argv et cache distincts', async () => {
  const t = lecteur();
  expect((await t.reader.memory()).ok).toBe(true);
  expect((await t.reader.memory('')).ok).toBe(true);
  expect((await t.reader.memory('', {}, 'note')).ok).toBe(true);
  expect(t.appels()).toEqual([
    'memory list -n 100 --json',
    'memory list --type note -n 100 --json',
  ]);
});
