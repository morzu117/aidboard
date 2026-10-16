import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { WorkspaceQueue } from '../src/daemon/actions/queue.js';
import { type Db, openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { git } from '../src/daemon/git/exec.js';
import { MemoryMirror } from '../src/daemon/memory/mirror.js';
import { MemoryService } from '../src/daemon/memory/service.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';
import { sh } from './helpers/git.js';

let db: Db | undefined;
let t: TestDaemon | undefined;
afterEach(async () => {
  db?.close();
  db = undefined;
  await t?.d.stop();
  t = undefined;
});

const admin = { author: 'admin' };

async function setup(debounceMs = 2000) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-mem-')));
  db = openDb(join(home, 'state.db'));
  const logs: string[] = [];
  const mirror = new MemoryMirror(join(home, 'memory'), git, (l) => logs.push(l), debounceMs);
  await mirror.init();
  const events = new EventStore(db);
  const service = new MemoryService({
    store: new MemoryStore(db),
    mirror,
    events,
    queue: new WorkspaceQueue(),
    log: (l) => logs.push(l),
  });
  return { home, root: mirror.root, mirror, service, events, logs };
}

const commits = (root: string) => sh(root, 'log', '--format=%s%n%b').trim();
const count = (root: string) => Number(sh(root, 'rev-list', '--count', 'HEAD'));

test('init : dépôt git en 0700, .gitignore, identité locale ; idempotent', async () => {
  const { root, mirror } = await setup();
  expect(existsSync(join(root, '.git'))).toBe(true);
  expect(existsSync(join(root, '.gitignore'))).toBe(true);
  expect(sh(root, 'config', 'user.name')).toBeTruthy();
  await expect(mirror.init()).resolves.toBeUndefined();
});

test('put écrit le fichier et, après flush, un commit qui nomme le slug', async () => {
  const { root, mirror, service } = await setup();
  const p = await service.put('aid/plan/alpha', '# Alpha\n\ncorps', { kind: 'create' }, admin);
  expect(p.revision).toBe(1);
  expect(readFileSync(join(root, 'aid/plan/alpha.md'), 'utf8')).toBe('# Alpha\n\ncorps\n');
  await mirror.flush();
  expect(commits(root)).toContain('mem: aid/plan/alpha r1');
  expect(count(root)).toBe(1);
});

test('deux put en rafale : un seul commit, qui liste les deux pages', async () => {
  const { root, mirror, service } = await setup();
  await service.put('aid/plan/a', 'a', { kind: 'create' }, admin);
  await service.put('aid/plan/b', 'b', { kind: 'create' }, admin);
  await mirror.flush();
  expect(count(root)).toBe(1);
  expect(commits(root)).toContain('mem: 2 pages');
  expect(commits(root)).toContain('mem: aid/plan/a r1');
  expect(commits(root)).toContain('mem: aid/plan/b r1');
  await mirror.flush();
  expect(count(root)).toBe(1);
});

test('le commit part de lui-même après le délai', async () => {
  const { root, service } = await setup(50);
  await service.put('aid/plan/a', 'a', { kind: 'create' }, admin);
  await waitFor(
    () => {
      try {
        return count(root) === 1 || undefined;
      } catch {
        return undefined;
      }
    },
    5000,
    'commit différé',
  );
  expect(commits(root)).toContain('mem: aid/plan/a r1');
});

test('append réécrit le fichier entier ; remove supprime et commite', async () => {
  const { root, mirror, service } = await setup();
  await service.put('aid/dev-handoff/x', '## Dev 1', { kind: 'create' }, admin);
  await service.put('aid/dev-handoff/x', '## Re-dev', { kind: 'append' }, { author: 'run:r2' });
  expect(readFileSync(join(root, 'aid/dev-handoff/x.md'), 'utf8')).toBe('## Dev 1\n\n## Re-dev\n');
  await mirror.flush();
  expect(await service.remove('aid/dev-handoff/x', admin)).toBe(true);
  expect(await service.remove('aid/dev-handoff/x', admin)).toBe(false);
  expect(existsSync(join(root, 'aid/dev-handoff/x.md'))).toBe(false);
  await mirror.flush();
  expect(count(root)).toBe(2);
  expect(commits(root)).toContain('mem: aid/dev-handoff/x supprimée');
  expect(await mirror.dirty()).toBe(false);
});

test('les événements memory.page portent slug, révision, auteur et op', async () => {
  const { service, events } = await setup();
  await service.put('aid/plan/x', 'v1', { kind: 'create' }, { author: 'run:r1', runId: 'run_1' });
  await service.put('aid/plan/x', 'v2', { kind: 'append' }, admin);
  await service.remove('aid/plan/x', admin);
  const got = events.since(null).filter((e) => e.type === 'memory.page');
  expect(got.map((e) => e.data)).toEqual([
    { slug: 'aid/plan/x', revision: 1, author: 'run:r1', op: 'put' },
    { slug: 'aid/plan/x', revision: 2, author: 'admin', op: 'append' },
    { slug: 'aid/plan/x', revision: 2, author: 'admin', op: 'rm' },
  ]);
  expect(got[0]!.source).toBe('daemon');
  expect(got[0]!.runId).toBe('run_1');
});

test('reindex relit le miroir, frontmatter compris, et ignore un slug invalide en le journalisant', async () => {
  const { root, mirror, service, logs } = await setup();
  await mirror.write(
    'lesson/sqlite/wal',
    '---\ntags: [sqlite]\n---\n\n# WAL\n\nUn seul écrivain.\n',
  );
  await mirror.write('aid/plan/a', 'alpha\n');
  mkdirSync(join(root, 'Majuscule'), { recursive: true });
  writeFileSync(join(root, 'Majuscule', 'x.md'), 'ignorée');
  writeFileSync(join(root, 'sans-segment.md'), 'ignorée aussi');
  const r = await service.reindex();
  expect(r.pages).toBe(2);
  expect(service.get('lesson/sqlite/wal')).toMatchObject({
    title: 'WAL',
    frontmatter: { tags: ['sqlite'] },
    body: '# WAL\n\nUn seul écrivain.',
    author: 'reindex',
    revision: 1,
  });
  expect(service.list('')).toEqual(['aid/plan/a', 'lesson/sqlite/wal']);
  expect(logs.filter((l) => l.includes('slug invalide'))).toHaveLength(2);
  expect((await service.search('ecrivain', 'aid', 5)).hits.map((h) => h.slug)).toEqual([
    'lesson/sqlite/wal',
  ]);
});

test('export puis import dans un store vide : mêmes pages, mêmes frontmatters ; l’existant est sauté', async () => {
  const a = await setup();
  await a.service.put('aid/plan/a', '---\nk: 1\n---\n# A\n\nalpha', { kind: 'create' }, admin);
  await a.service.put('lesson/l/b', 'beta', { kind: 'create' }, admin);
  await a.service.put('autre/plan/c', 'gamma', { kind: 'create' }, admin);
  const dir = mkdtempSync(join(tmpdir(), 'aid-export-'));
  expect(await a.service.export('aid', dir)).toBe(2);
  expect(existsSync(join(dir, 'aid/plan/a.md'))).toBe(true);
  expect(existsSync(join(dir, 'lesson/l/b.md'))).toBe(true);
  expect(existsSync(join(dir, 'autre/plan/c.md'))).toBe(false);
  db!.close();
  const b = await setup();
  expect(await b.service.import(dir)).toEqual({ imported: 2, skipped: [], failed: [] });
  expect(b.service.get('aid/plan/a')).toMatchObject({
    frontmatter: { k: 1 },
    body: '# A\n\nalpha',
    title: 'A',
    author: 'import',
  });
  expect(await b.service.import(dir)).toEqual({
    imported: 0,
    skipped: ['aid/plan/a', 'lesson/l/b'],
    failed: [],
  });
  const flat = mkdtempSync(join(tmpdir(), 'aid-import-'));
  writeFileSync(join(flat, 'une-lecon.md'), '# Leçon\n');
  expect(await b.service.import(flat, 'lesson')).toEqual({ imported: 1, skipped: [], failed: [] });
  expect(await b.service.import(flat)).toEqual({ imported: 0, skipped: [], failed: ['une-lecon'] });
  expect(b.service.get('lesson/une-lecon')?.title).toBe('Leçon');
  await b.mirror.flush();
  expect(count(b.root)).toBe(1);
  expect(commits(b.root)).toContain('mem: 3 pages');
});

test('le daemon ouvre ~/.aid/memory au démarrage et commite ce qui reste à l’arrêt', async () => {
  t = await startTestDaemon();
  const root = join(t.home, 'memory');
  expect(existsSync(join(root, '.git'))).toBe(true);
  await t.d.memory.put('aid/plan/x', 'contenu', { kind: 'create' }, admin);
  expect(existsSync(join(root, 'aid/plan/x.md'))).toBe(true);
  await t.d.stop();
  t = undefined;
  expect(count(root)).toBe(1);
});
