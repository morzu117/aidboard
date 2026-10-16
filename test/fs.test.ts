import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { listDirectories } from '../src/daemon/routes/fs.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';
import { makeOriginAndClone } from './helpers/git.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-fs-')));
const get = (url: string, headers?: Record<string, string>) =>
  t.d.app.inject({ method: 'GET', url, headers: headers ?? t.headers });

test('liste les dossiers triés, sans fichiers ni dossiers cachés, et repère les dépôts', async () => {
  const root = tmp();
  mkdirSync(join(root, 'zeta'));
  mkdirSync(join(root, 'Alpha'));
  mkdirSync(join(root, '.cache'));
  writeFileSync(join(root, 'notes.txt'), 'x');
  const { clone } = makeOriginAndClone(join(root, 'depots'));
  const l = await listDirectories(root, false);
  expect(l.entries.map((e) => e.name)).toEqual(['Alpha', 'depots', 'zeta']);
  const sub = await listDirectories(join(root, 'depots'), false);
  expect(sub.entries.find((e) => e.path === clone)?.isRepo).toBe(true);
  expect(l.entries.find((e) => e.name === 'zeta')?.isRepo).toBe(false);
});

test('les dossiers cachés n’apparaissent que sur demande', async () => {
  const root = tmp();
  mkdirSync(join(root, '.config'));
  expect((await listDirectories(root, false)).entries).toEqual([]);
  expect((await listDirectories(root, true)).entries.map((e) => e.name)).toEqual(['.config']);
});

test('un worktree lié (.git fichier) n’est pas pris pour un dépôt ; un lien vers un dossier se parcourt', async () => {
  const root = tmp();
  mkdirSync(join(root, 'lie'));
  writeFileSync(join(root, 'lie', '.git'), 'gitdir: /ailleurs');
  const cible = join(root, 'cible');
  mkdirSync(cible);
  symlinkSync(cible, join(root, 'lien'));
  const l = await listDirectories(root, false);
  expect(l.entries.map((e) => [e.name, e.isRepo])).toEqual([
    ['cible', false],
    ['lie', false],
    ['lien', false],
  ]);
});

test('parent : le dossier du dessus, null à la racine du disque', async () => {
  const root = tmp();
  mkdirSync(join(root, 'a'));
  expect((await listDirectories(join(root, 'a'), false)).parent).toBe(root);
  expect((await listDirectories('/', false)).parent).toBeNull();
});

test('sans chemin : le dossier personnel', async () => {
  const home = tmp();
  const l = await listDirectories(undefined, false, home);
  expect(l.path).toBe(home);
  expect(l.home).toBe(home);
});

test('refuse un chemin relatif, absent, ou qui est un fichier', async () => {
  const root = tmp();
  writeFileSync(join(root, 'f'), '');
  await expect(listDirectories('relatif/x', false)).rejects.toMatchObject({ status: 422 });
  await expect(listDirectories(join(root, 'absent'), false)).rejects.toMatchObject({ status: 404 });
  await expect(listDirectories(join(root, 'f'), false)).rejects.toMatchObject({ status: 422 });
});

test('route : authentifiée, répond le listing', async () => {
  t = await startTestDaemon();
  const root = tmp();
  mkdirSync(join(root, 'un'));
  const r = await get(`/api/fs/dirs?path=${encodeURIComponent(root)}`);
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ path: root, entries: [{ name: 'un' }] });
  const bad = await get(`/api/fs/dirs?path=${encodeURIComponent(join(root, 'nope'))}`);
  expect(bad.statusCode).toBe(404);
  const anon = await t.d.app.inject({
    method: 'GET',
    url: '/api/fs/dirs',
    headers: { host: t.headers.host },
  });
  expect(anon.statusCode).toBe(401);
});
