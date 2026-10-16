import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { wslWarnings } from '../src/daemon/routes/workspaces.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';
import { makeOriginAndClone, sh } from './helpers/git.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-ws-')));
const register = (payload: unknown) =>
  t.d.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: t.headers,
    payload: payload as never,
  });

test('enregistre un dépôt : base détectée, nom dérivé, dossier de worktrees sous ~/.aid', async () => {
  t = await startTestDaemon();
  const { clone } = makeOriginAndClone(tmp());
  const r = await register({ path: clone });
  expect(r.statusCode).toBe(201);
  expect(r.json()).toMatchObject({
    name: 'mon-depot',
    root: clone,
    baseBranch: 'main',
    worktreesDir: join(t.home, 'worktrees', 'mon-depot'),
    warnings: [],
  });
  expect(t.db.prepare('SELECT count(*) c FROM workspaces').get()).toEqual({ c: 1 });
});

test('détecte master comme base', async () => {
  t = await startTestDaemon();
  const { clone } = makeOriginAndClone(tmp(), { base: 'master' });
  expect((await register({ path: clone })).json().baseBranch).toBe('master');
});

test('refuse un chemin qui n’est pas un dépôt', async () => {
  t = await startTestDaemon();
  const r = await register({ path: tmp() });
  expect(r.statusCode).toBe(422);
  expect(r.json().error).toContain("n'est pas un dépôt git");
});

test('refuse un chemin inexistant', async () => {
  t = await startTestDaemon();
  expect((await register({ path: join(tmp(), 'absent') })).statusCode).toBe(422);
});

test('refuse un sous-dossier : il faut la racine', async () => {
  t = await startTestDaemon();
  const { clone } = makeOriginAndClone(tmp());
  mkdirSync(join(clone, 'src'));
  const r = await register({ path: join(clone, 'src') });
  expect(r.statusCode).toBe(422);
  expect(r.json().error).toContain('racine');
});

test('refuse un worktree lié', async () => {
  t = await startTestDaemon();
  const dir = tmp();
  const { clone } = makeOriginAndClone(dir);
  const wt = join(dir, 'lie');
  sh(clone, 'worktree', 'add', '-q', '-b', 'autre', wt);
  const r = await register({ path: wt });
  expect(r.statusCode).toBe(422);
  expect(r.json().error).toContain('worktree lié');
});

test('un dépôt sans origin est accepté : base = branche courante, remote nul, avertissement', async () => {
  t = await startTestDaemon();
  const { clone } = makeOriginAndClone(tmp(), { local: true });
  sh(clone, 'checkout', '-q', '-b', 'dev');
  const r = await register({ path: clone });
  expect(r.statusCode).toBe(201);
  expect(r.json()).toMatchObject({ remote: null, baseBranch: 'dev' });
  expect(r.json().warnings.join('\n')).toContain('sans remote origin');
  const state = (
    await t.d.app.inject({ method: 'GET', url: '/api/state', headers: t.headers })
  ).json<{ workspaces: Array<{ remote: string | null }> }>();
  expect(state.workspaces[0]!.remote).toBeNull();
});

test('un dépôt sans origin : une base précisée doit exister en local', async () => {
  t = await startTestDaemon();
  const { clone } = makeOriginAndClone(tmp(), { local: true });
  const absente = await register({ path: clone, baseBranch: 'nexiste-pas' });
  expect(absente.statusCode).toBe(422);
  expect(absente.json().error).toContain('nexiste-pas');
});

test('un dépôt avec origin garde le remote « origin »', async () => {
  t = await startTestDaemon();
  const { clone } = makeOriginAndClone(tmp());
  expect((await register({ path: clone })).json()).toMatchObject({ remote: 'origin' });
});

test('base non détectable : à préciser ; précisée mais absente : refus ; précisée et présente : ok', async () => {
  t = await startTestDaemon();
  const { clone } = makeOriginAndClone(tmp(), { setHead: false });
  sh(clone, 'remote', 'set-head', 'origin', '--delete');
  const sans = await register({ path: clone });
  expect(sans.statusCode).toBe(422);
  expect(sans.json().error).toContain('la préciser');
  const absente = await register({ path: clone, baseBranch: 'nexiste-pas' });
  expect(absente.statusCode).toBe(422);
  expect(absente.json().error).toContain('origin/nexiste-pas');
  expect((await register({ path: clone, baseBranch: 'main' })).statusCode).toBe(201);
});

test('un même dépôt deux fois : 409', async () => {
  t = await startTestDaemon();
  const { clone } = makeOriginAndClone(tmp());
  expect((await register({ path: clone })).statusCode).toBe(201);
  expect((await register({ path: clone })).statusCode).toBe(409);
});

test('deux dépôts de même nom : suffixe -2', async () => {
  t = await startTestDaemon();
  const a = makeOriginAndClone(tmp());
  const b = makeOriginAndClone(tmp());
  expect((await register({ path: a.clone })).json().name).toBe('mon-depot');
  expect((await register({ path: b.clone })).json().name).toBe('mon-depot-2');
});

test('payload invalide : 400', async () => {
  t = await startTestDaemon();
  expect((await register({})).statusCode).toBe(400);
  expect((await register({ path: '/x', autre: 1 })).statusCode).toBe(400);
});

test('avertissement WSL2 seulement pour un repo sous /mnt', () => {
  const wsl = 'Linux version 5.15.0-microsoft-standard-WSL2';
  expect(wslWarnings('/mnt/c/Users/j/depot', wsl)).toHaveLength(1);
  expect(wslWarnings('/home/j/depot', wsl)).toEqual([]);
  expect(wslWarnings('/mnt/c/depot', 'Linux version 6.1.0-debian')).toEqual([]);
  expect(wslWarnings('/mnt/c/depot', null)).toEqual([]);
});
