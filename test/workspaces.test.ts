import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readConsignes, wslWarnings } from '../src/daemon/routes/workspaces.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';
import { makeOriginAndClone, sh } from './helpers/git.js';
import { makeTopic, setupWorkspace } from './helpers/topics.js';

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

const remove = (id: string) =>
  t.d.app.inject({ method: 'DELETE', url: `/api/workspaces/${id}`, headers: t.headers });

test('retirer un projet sans sujet : 204, il disparaît ; inconnu : 404', async () => {
  t = await startTestDaemon();
  const { clone } = makeOriginAndClone(tmp());
  const ws = (await register({ path: clone })).json();
  expect((await remove(ws.id)).statusCode).toBe(204);
  expect(t.db.prepare('SELECT count(*) c FROM workspaces').get()).toEqual({ c: 0 });
  expect((await remove(ws.id)).statusCode).toBe(404);
});

test('retirer un projet : refusé tant qu’un sujet est ouvert, puis oublie les sujets archivés', async () => {
  const c = await setupWorkspace();
  t = c.t;
  const { topicId } = await makeTopic(c);
  const r = await remove(c.ws.id);
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toContain('1 sujet ouvert');
  t.store.append({ source: 'daemon', type: 'topic.state', topicId, data: { state: 'archived' } });
  expect((await remove(c.ws.id)).statusCode).toBe(204);
  for (const table of ['workspaces', 'topics', 'runs', 'actions'])
    expect(t.db.prepare(`SELECT count(*) c FROM ${table}`).get(), table).toEqual({ c: 0 });
  // le dépôt et le journal restent
  expect(sh(c.clone, 'rev-parse', '--is-inside-work-tree')).toBe('true');
  expect(t.store.since(null).some((e) => e.topicId === topicId)).toBe(true);
});

test('consignes : présence de CLAUDE.md et AGENTS.md, version du bloc et du noyau', async () => {
  const root = tmp();
  const kernel = tmp();
  expect(readConsignes(root, kernel)).toEqual({
    claudeMd: false,
    agentsMd: false,
    blockVersion: null,
    kernelVersion: null,
  });
  writeFileSync(
    join(root, 'AGENTS.md'),
    '# x\n<!-- agentkit:start 0.7.1 -->\n…\n<!-- agentkit:end -->\n',
  );
  writeFileSync(join(root, 'CLAUDE.md'), '# Projet\n');
  writeFileSync(join(kernel, 'VERSION'), '0.8.0\n');
  expect(readConsignes(root, kernel)).toEqual({
    claudeMd: true,
    agentsMd: true,
    blockVersion: '0.7.1',
    kernelVersion: '0.8.0',
  });
  // le bloc de CLAUDE.md l'emporte sur celui d'AGENTS.md
  writeFileSync(join(root, 'CLAUDE.md'), '<!-- agentkit:start 0.6.0 -->\n');
  expect(readConsignes(root, kernel).blockVersion).toBe('0.6.0');

  t = await startTestDaemon();
  const { clone } = makeOriginAndClone(tmp());
  const ws = (await register({ path: clone })).json();
  const get = (id: string) =>
    t.d.app.inject({ method: 'GET', url: `/api/workspaces/${id}/consignes`, headers: t.headers });
  expect((await get(ws.id)).json()).toMatchObject({ claudeMd: false, agentsMd: false });
  expect((await get('ws_inconnu')).statusCode).toBe(404);
});

test('namespace mémoire : project.namespace d’agent.yml, sinon le nom ; PATCH le change', async () => {
  t = await startTestDaemon();
  const a = makeOriginAndClone(tmp(), { name: 'avec-manifeste' });
  writeFileSync(join(a.clone, 'agent.yml'), 'project:\n  namespace: aid\n');
  expect((await register({ path: a.clone })).json().namespace).toBe('aid');
  const b = makeOriginAndClone(tmp(), { name: 'sans-manifeste' });
  const created = await register({ path: b.clone });
  expect(created.json().namespace).toBe('sans-manifeste');
  const c = makeOriginAndClone(tmp(), { name: 'manifeste-invalide' });
  writeFileSync(join(c.clone, 'agent.yml'), 'project:\n  namespace: Majuscule\n');
  expect((await register({ path: c.clone })).json().namespace).toBe('manifeste-invalide');

  const id = created.json().id as string;
  const patch = (payload: unknown, target = id) =>
    t.d.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${target}`,
      headers: t.headers,
      payload: payload as never,
    });
  expect((await patch({ namespace: 'Majuscule' })).statusCode).toBe(400);
  expect((await patch({ namespace: 'a/b' })).statusCode).toBe(400);
  expect((await patch({ namespace: 'ok', extra: 1 })).statusCode).toBe(400);
  expect((await patch({ namespace: 'projet' }, 'ws_absent')).statusCode).toBe(404);
  expect((await patch({ namespace: 'projet' })).json()).toEqual({ id, namespace: 'projet' });
  const state = await t.d.app.inject({ url: '/api/state', headers: t.headers });
  const ws = (state.json().workspaces as Array<{ id: string; namespace: string }>).find(
    (w) => w.id === id,
  );
  expect(ws?.namespace).toBe('projet');
});

test('au démarrage, un workspace sans namespace en reçoit un', async () => {
  t = await startTestDaemon();
  const home = t.home;
  const { clone } = makeOriginAndClone(tmp(), { name: 'ancien' });
  t.db
    .prepare(
      'INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at, namespace) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    )
    .run('ws_old', 'ancien', clone, 'main', '/w', 't0');
  await t.d.stop();
  t = await startTestDaemon(home);
  expect(t.db.prepare("SELECT namespace FROM workspaces WHERE id = 'ws_old'").get()).toEqual({
    namespace: 'ancien',
  });
});
