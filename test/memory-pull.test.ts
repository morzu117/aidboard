import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { WorkspaceQueue } from '../src/daemon/actions/queue.js';
import { openDb, type Db } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { git } from '../src/daemon/git/exec.js';
import { machineName, MemoryMirror, type GitExec } from '../src/daemon/memory/mirror.js';
import { MemoryService } from '../src/daemon/memory/service.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';
import { sh } from './helpers/git.js';

const homes: string[] = [];
const databases: Db[] = [];
const mirrors: MemoryMirror[] = [];
let daemon: TestDaemon | undefined;
afterEach(async () => {
  await daemon?.d.stop();
  daemon = undefined;
  for (const mirror of mirrors.splice(0)) await mirror.flush();
  for (const db of databases.splice(0)) db.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function pair(exec: GitExec = git) {
  const home = mkdtempSync(join(tmpdir(), 'aid-pull-'));
  homes.push(home);
  const origin = join(home, 'origin.git');
  mkdirSync(origin);
  sh(origin, 'init', '--bare', '-q', '-b', 'main');
  const a = await machine(join(home, 'a'));
  sh(a.mirror.root, 'remote', 'add', 'origin', origin);
  await a.service.put('lesson/base', '# Base\n', { kind: 'create' }, { author: 'test' });
  await a.mirror.flush();
  a.mirror.push = true;
  await a.mirror.pushIfConfigured();
  const bHome = join(home, 'b');
  mkdirSync(bHome);
  sh(home, 'clone', '-q', origin, join(bHome, 'memory'));
  const b = await machine(bHome, exec);
  await b.service.reindex();
  b.mirror.push = true;
  return { home, origin, a, b };
}

async function machine(home: string, exec: GitExec = git) {
  mkdirSync(home, { recursive: true });
  const logs: string[] = [];
  const mirror = new MemoryMirror(join(home, 'memory'), exec, (line) => logs.push(line), 60_000);
  mirrors.push(mirror);
  await mirror.init();
  const db = openDb(join(home, 'state.db'));
  databases.push(db);
  const written: string[] = [];
  const removed: string[] = [];
  const service = new MemoryService({
    mirror,
    store: new MemoryStore(db),
    events: new EventStore(db),
    queue: new WorkspaceQueue(),
    onWrite: (slug) => written.push(slug),
    onRemove: (slug) => removed.push(slug),
  });
  mirror.synchronize = (action) => service.synchronizeMirror(action);
  return { mirror, service, logs, written, removed };
}

async function put(m: Awaited<ReturnType<typeof machine>>, slug: string, text: string) {
  await m.service.put(slug, text, { kind: 'force' }, { author: 'test' });
  await m.mirror.flush();
}

test('57.4 : avance rapide, relecture ciblée, suppression et hooks des vecteurs', async () => {
  const { a, b } = await pair();
  await put(a, 'lesson/nouvelle', '---\ntitle: Nouvelle\n---\n\nmotdistantspecial');
  const revision = b.service.get('lesson/base')!.revision;
  b.written.length = 0;
  await b.mirror.pull();
  expect(b.service.get('lesson/nouvelle')?.title).toBe('Nouvelle');
  expect((await b.service.search('motdistantspecial', 'all', 10)).hits).toHaveLength(1);
  expect(b.service.get('lesson/base')?.revision).toBe(revision);
  expect(b.written).toEqual(['lesson/nouvelle']);
  await b.mirror.pull();
  expect(b.written).toEqual(['lesson/nouvelle']);
  await a.service.remove('lesson/nouvelle', { author: 'test' });
  await a.mirror.flush();
  await b.mirror.pull();
  expect(b.service.get('lesson/nouvelle')).toBeUndefined();
  expect(b.removed).toEqual(['lesson/nouvelle']);
  expect((await b.service.search('motdistantspecial', 'all', 10)).hits).toHaveLength(0);
});

test('57.4 : deux pages différentes divergent, rebase avant push et convergence', async () => {
  const { a, b, origin } = await pair();
  await put(a, 'lesson/a', 'machine A');
  await put(b, 'lesson/b', 'machine B');
  expect(b.service.get('lesson/a')?.body).toBe('machine A');
  await a.mirror.pull();
  expect(a.service.get('lesson/b')?.body).toBe('machine B');
  expect(sh(a.mirror.root, 'rev-parse', 'HEAD')).toBe(sh(origin, 'rev-parse', 'main'));
  expect(sh(b.mirror.root, 'rev-parse', 'HEAD')).toBe(sh(origin, 'rev-parse', 'main'));
  expect(b.mirror.conflicts).toEqual([]);
});

test('57.4 : conflit conservé sans résolution automatique, y compris après redémarrage', async () => {
  const { a, b, origin } = await pair();
  await put(a, 'lesson/base', 'version distante\n\nfin');
  const remoteHead = sh(origin, 'rev-parse', 'main');
  await put(b, 'lesson/base', 'version locale\n\nfin');
  const copy = `lesson/base.conflit-${machineName()}`;
  expect(b.mirror.conflicts).toEqual(['lesson/base.md']);
  expect(readFileSync(b.mirror.pathOf(copy), 'utf8')).toBe('version locale\n\nfin\n');
  expect(b.service.get(copy)?.body).toBe('version locale\n\nfin');
  expect(b.service.get('lesson/base')?.body).toBe('version distante\n\nfin');
  expect(existsSync(join(b.mirror.root, '.git/rebase-merge'))).toBe(false);
  const restarted = new MemoryMirror(b.mirror.root, git, () => {});
  restarted.push = true;
  await restarted.init();
  await restarted.pushIfConfigured();
  restarted.scheduleCommit('ne doit pas commiter le conflit');
  await restarted.flush();
  expect(restarted.conflicts).toEqual(['lesson/base.md']);
  expect((await restarted.syncHealth()).conflicts).toEqual(['lesson/base.md']);
  expect((await b.service.health()).mirrorSync?.conflicts).toEqual(['lesson/base.md']);
  expect(sh(origin, 'rev-parse', 'main')).toBe(remoteHead);
  expect(b.logs.some((line) => line.includes('conflit en attente'))).toBe(true);
});

test('57.4 : push désactivé, origin absent ou fetch en échec ne modifient pas le miroir', async () => {
  const { a, b } = await pair();
  await put(a, 'lesson/a', 'distant');
  const head = sh(b.mirror.root, 'rev-parse', 'HEAD');
  b.mirror.push = false;
  await b.mirror.pull();
  expect(sh(b.mirror.root, 'rev-parse', 'HEAD')).toBe(head);
  b.mirror.push = true;
  sh(b.mirror.root, 'remote', 'remove', 'origin');
  await b.mirror.pull();
  sh(b.mirror.root, 'remote', 'add', 'origin', join(b.mirror.root, 'absent.git'));
  await b.mirror.pull();
  expect(sh(b.mirror.root, 'rev-parse', 'HEAD')).toBe(head);
  expect(b.logs.some((line) => line.includes('git fetch a échoué'))).toBe(true);
});

test('57.4 : le daemon tire au démarrage et relit les pages dans la base existante', async () => {
  const { home, a, origin } = await pair();
  const daemonHome = join(home, 'daemon');
  mkdirSync(daemonHome);
  sh(home, 'clone', '-q', origin, join(daemonHome, 'memory'));
  await put(a, 'lesson/demarrage', 'reçu au démarrage');
  daemon = await startTestDaemon(daemonHome, {
    config: {
      memory: {
        embeddings: { provider: 'off', model: 'bge-m3', url: 'http://127.0.0.1:11434' },
        maintenance: { enabled: false, model: 'qwen3:8b', window: '02:00-06:00' },
        git: { push: true },
      },
    },
  });
  expect(daemon.d.memory.get('lesson/demarrage')?.body).toBe('reçu au démarrage');
  const health = await daemon.d.app.inject({
    method: 'GET',
    url: '/api/memory/health',
    headers: daemon.headers,
  });
  expect(health.statusCode).toBe(200);
  expect(health.json().mirrorSync).toEqual({
    push: true,
    origin: true,
    ahead: 0,
    behind: 0,
    conflicts: [],
  });
});

test('57.5 : santé du miroir sans origin, avec push désactivé puis activé', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-health-'));
  homes.push(home);
  const { mirror, service } = await machine(home);
  expect((await service.health()).mirrorSync).toEqual({
    push: false,
    origin: false,
    ahead: null,
    behind: null,
    conflicts: [],
  });
  mirror.push = true;
  expect((await service.health()).mirrorSync).toMatchObject({ push: true, origin: false });
  const origin = join(home, 'empty.git');
  mkdirSync(origin);
  sh(origin, 'init', '--bare', '-q', '-b', 'main');
  sh(mirror.root, 'remote', 'add', 'origin', origin);
  expect(await mirror.syncHealth()).toMatchObject({ origin: true, ahead: null, behind: null });
});

test('57.5 : avance et retard selon le dernier fetch, sans synchronisation par la santé', async () => {
  const { a, b } = await pair();
  expect((await b.service.health()).mirrorSync).toMatchObject({ ahead: 0, behind: 0 });
  b.mirror.push = false;
  await put(b, 'lesson/locale', 'locale');
  expect(await b.mirror.syncHealth()).toMatchObject({ ahead: 1, behind: 0 });
  await put(a, 'lesson/distante', 'distante');
  // La lecture de santé ne fetch pas et ne masque pas la date implicite de la référence.
  expect(await b.mirror.syncHealth()).toMatchObject({ ahead: 1, behind: 0 });
  sh(b.mirror.root, 'fetch', '-q', 'origin');
  const head = sh(b.mirror.root, 'rev-parse', 'HEAD');
  expect((await b.service.health()).mirrorSync).toMatchObject({ ahead: 1, behind: 1 });
  expect(sh(b.mirror.root, 'rev-parse', 'HEAD')).toBe(head);
  expect(b.service.get('lesson/distante')).toBeUndefined();
});

test('57.4 : premier tirage dans un miroir sans commit', async () => {
  const { home, origin } = await pair();
  const fresh = await machine(join(home, 'neuf'));
  sh(fresh.mirror.root, 'remote', 'add', 'origin', origin);
  fresh.mirror.push = true;
  await fresh.mirror.init();
  expect(fresh.service.get('lesson/base')?.title).toBe('Base');
  expect(fresh.mirror.conflicts).toEqual([]);
});

test.each(['locale', 'distante'])('57.4 : conflit modification/suppression %s', async (side) => {
  const { a, b, origin } = await pair();
  if (side === 'distante') {
    await a.service.remove('lesson/base', { author: 'test' });
    await a.mirror.flush();
    await put(b, 'lesson/base', 'modification locale');
    expect(b.service.get('lesson/base')).toBeUndefined();
  } else {
    await put(a, 'lesson/base', 'modification distante');
    await b.service.remove('lesson/base', { author: 'test' });
    await b.mirror.flush();
    expect(b.service.get('lesson/base')?.body).toBe('modification distante');
  }
  expect(b.mirror.conflicts).toEqual(['lesson/base.md']);
  expect(sh(origin, 'rev-parse', 'main')).toBe(sh(a.mirror.root, 'rev-parse', 'HEAD'));
});

test('57.4 : des fichiers locaux non commités empêchent le tirage sans être écrasés', async () => {
  const { a, b } = await pair();
  await put(a, 'lesson/base', 'version distante');
  await b.mirror.write('lesson/base', 'brouillon local');
  await b.mirror.pull();
  expect(readFileSync(b.mirror.pathOf('lesson/base'), 'utf8')).toBe('brouillon local');
  expect(b.logs.some((line) => line.includes('tirage différé'))).toBe(true);
  expect(b.mirror.conflicts).toEqual([]);
});

test('57.4 : deux commits locaux rejoués, seul le commit en conflit est copié', async () => {
  const { a, b } = await pair();
  b.mirror.push = false;
  await put(b, 'lesson/locale', 'premier commit local');
  await put(b, 'lesson/base', 'second commit local');
  await put(a, 'lesson/base', 'distant');
  b.mirror.push = true;
  await b.mirror.pull();
  expect(b.mirror.conflicts).toEqual(['lesson/base.md']);
  expect(b.service.get(`lesson/base.conflit-${machineName()}`)?.body).toBe('second commit local');
  expect(b.service.get('lesson/locale')?.body).toBe('premier commit local');
  expect(existsSync(b.mirror.pathOf(`lesson/locale.conflit-${machineName()}`))).toBe(false);
  expect(sh(b.mirror.root, 'log', '-2', '--format=%s').split('\n')).toHaveLength(2);
});

test('57.4 : rebase sans conflit abandonné sans marqueur, puis nouvelle tentative', async () => {
  let reject = true;
  const calls: string[][] = [];
  const { a, b } = await pair(async (cwd, args, timeout) => {
    calls.push(args);
    if (reject && args.includes('rebase') && !args.includes('--abort')) {
      return { ok: false, code: 1, stdout: '', stderr: 'verrou git' };
    }
    return git(cwd, args, timeout);
  });
  b.mirror.push = false;
  await put(b, 'lesson/locale', 'locale');
  await put(a, 'lesson/distante', 'distante');
  b.mirror.push = true;
  await b.mirror.pull();
  expect(calls).toContainEqual(['rebase', '--abort']);
  expect(b.mirror.conflicts).toEqual([]);
  expect(existsSync(join(b.mirror.root, '.git/aid-memory-conflicts.json'))).toBe(false);
  expect(b.logs.filter((line) => line.includes('sans conflit'))).toHaveLength(1);
  reject = false;
  await b.mirror.pull();
  expect(sh(b.mirror.root, 'show', 'HEAD:lesson/distante.md')).toContain('distante');
});

test('57.4 : collisions de copies numérotées sans interrompre les autres slugs', async () => {
  const { a, b } = await pair();
  await put(a, 'lesson/autre', 'base autre');
  await b.mirror.pull();
  b.mirror.push = false;
  const copy = `lesson/base.conflit-${machineName()}`;
  await put(b, copy, 'ancienne copie');
  await put(b, `${copy}-2`, 'deuxième copie');
  await b.service.put('lesson/base', 'locale base', { kind: 'force' }, { author: 'test' });
  await b.service.put('lesson/autre', 'locale autre', { kind: 'force' }, { author: 'test' });
  await b.mirror.flush();
  await a.service.put('lesson/base', 'distante base', { kind: 'force' }, { author: 'test' });
  await a.service.put('lesson/autre', 'distante autre', { kind: 'force' }, { author: 'test' });
  await a.mirror.flush();
  b.mirror.push = true;
  await b.mirror.pull();
  expect(b.mirror.conflicts).toEqual(['lesson/autre.md', 'lesson/base.md']);
  expect(b.service.get(copy)?.body).toBe('ancienne copie');
  expect(b.service.get(`${copy}-2`)?.body).toBe('deuxième copie');
  expect(b.service.get(`${copy}-3`)?.body).toBe('locale base');
  expect(b.service.get(`lesson/autre.conflit-${machineName()}`)?.body).toBe('locale autre');
  expect(b.service.get('lesson/base')?.body).toBe('distante base');
  expect(b.service.get('lesson/autre')?.body).toBe('distante autre');
});

test.each(['{', '{}', '[12]'])('57.4 : marqueur corrompu %s toléré', async (content) => {
  const { b } = await pair();
  writeFileSync(join(b.mirror.root, '.git/aid-memory-conflicts.json'), content);
  expect(b.mirror.conflicts).toEqual(['marqueur illisible']);
  expect((await b.mirror.syncHealth()).conflicts).toEqual(['marqueur illisible']);
  await b.mirror.pull();
  expect(b.logs.at(-1)).toContain('conflit en attente');
});

test('57.4 : marqueur illisible toléré', async () => {
  const { b } = await pair();
  mkdirSync(join(b.mirror.root, '.git/aid-memory-conflicts.json'));
  expect(b.mirror.conflicts).toEqual(['marqueur illisible']);
});

test('57.4 : relecture de la diff distante même si le rebase garde le contenu local', async () => {
  const { a, b } = await pair();
  b.mirror.push = false;
  await put(b, 'lesson/base', 'identique');
  await put(b, 'lesson/locale', 'locale');
  await put(a, 'lesson/base', 'identique');
  b.written.length = 0;
  b.mirror.push = true;
  await b.mirror.pushIfConfigured();
  expect(b.written).toEqual(['lesson/base']);
  expect(b.service.get('lesson/locale')?.body).toBe('locale');
});

test('57.4 : fetch borné à 30 secondes au démarrage et avant push', async () => {
  const timeouts: (number | undefined)[] = [];
  const { b } = await pair(async (cwd, args, timeout) => {
    if (args[0] === 'fetch') {
      timeouts.push(timeout);
      return { ok: false, code: null, stdout: '', stderr: 'délai dépassé' };
    }
    return git(cwd, args, timeout);
  });
  await b.mirror.init();
  await put(b, 'lesson/locale', 'locale');
  expect(timeouts).toEqual([30_000, 30_000]);
  expect(b.logs.filter((line) => line.includes('git fetch a échoué'))).toHaveLength(2);
  const result = await git(b.mirror.root, ['-c', 'alias.attendre=!sleep 2', 'attendre'], 20);
  expect(result.ok).toBe(false);
});
