import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { RevisionConflict } from '../src/shared/memory.js';
import { type Db, openDb } from '../src/daemon/db.js';
import { isValidMemSlug, namespaceOf } from '../src/daemon/memory/slug.js';
import {
  ftsQuery,
  MemoryStore,
  parseMarkdown,
  renderMarkdown,
} from '../src/daemon/memory/store.js';

let db: Db;
afterEach(() => db?.close());

function fresh(): MemoryStore {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'aid-mem-')), 'state.db'));
  return new MemoryStore(db);
}

test('la migration 004 crée les tables mémoire et la colonne namespace', () => {
  fresh();
  expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(6);
  const cols = (db.pragma('table_info(workspaces)') as { name: string }[]).map((c) => c.name);
  expect(cols).toContain('namespace');
  expect(() =>
    db.prepare("SELECT * FROM memory_fts WHERE memory_fts MATCH 'x'").all(),
  ).not.toThrow();
});

test('slug de page : deux segments au moins, caractères bornés, 200 au plus', () => {
  expect(isValidMemSlug('aid/plan/ma-tache')).toBe(true);
  expect(isValidMemSlug('lesson/git/worktree_v1.2')).toBe(true);
  expect(isValidMemSlug('sans-segment')).toBe(false);
  expect(isValidMemSlug('aid//plan')).toBe(false);
  expect(isValidMemSlug('Aid/Plan')).toBe(false);
  expect(isValidMemSlug('aid:plan')).toBe(false);
  expect(isValidMemSlug(`aid/${'a'.repeat(200)}`)).toBe(false);
  expect(namespaceOf('aid/plan/x')).toBe('aid');
});

test('création : titre explicite, sinon premier « # », sinon dernier segment', () => {
  const s = fresh();
  const a = s.put('aid/plan/alpha', '# Alpha\n\ncorps', { kind: 'create' }, 'admin');
  expect(a).toMatchObject({
    slug: 'aid/plan/alpha',
    namespace: 'aid',
    title: 'Alpha',
    revision: 1,
  });
  expect(a.body).toBe('# Alpha\n\ncorps');
  const b = s.put('aid/plan/beta', 'corps sans titre', { kind: 'create' }, 'admin');
  expect(b.title).toBe('beta');
  const c = s.put('aid/plan/gamma', '# Pas lui', { kind: 'create' }, 'admin', 'Explicite');
  expect(c.title).toBe('Explicite');
  expect(c.frontmatter).toEqual({ title: 'Explicite' });
  expect(s.get('aid/plan/gamma')?.title).toBe('Explicite');
  expect(s.get('aid/plan/absent')).toBeUndefined();
});

test('put sans option sur une page existante : revision_conflict avec la révision courante', () => {
  const s = fresh();
  s.put('aid/plan/x', 'v1', { kind: 'create' }, 'admin');
  s.put('aid/plan/x', 'v2', { kind: 'force' }, 'admin');
  let err: unknown;
  try {
    s.put('aid/plan/x', 'v3', { kind: 'create' }, 'admin');
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RevisionConflict);
  expect(err).toMatchObject({ message: 'revision_conflict', slug: 'aid/plan/x', revision: 2 });
  expect(s.get('aid/plan/x')?.body).toBe('v2');
});

test('append ajoute en fin de corps et incrémente ; une page absente est créée', () => {
  const s = fresh();
  expect(
    s.put('aid/dev-handoff/x', '## Dev 1\n\nfait', { kind: 'append' }, 'run:r1').revision,
  ).toBe(1);
  const p = s.put('aid/dev-handoff/x', '## Re-dev 1/2\n\nrefait', { kind: 'append' }, 'run:r2');
  expect(p.revision).toBe(2);
  expect(p.body).toBe('## Dev 1\n\nfait\n\n## Re-dev 1/2\n\nrefait');
  expect(p.author).toBe('run:r2');
  expect(p.createdAt).toBe(s.get('aid/dev-handoff/x')!.createdAt);
});

test('replace exige la révision attendue ; force remplace sans condition', () => {
  const s = fresh();
  s.put('aid/plan/x', 'v1', { kind: 'create' }, 'admin');
  expect(() =>
    s.put('aid/plan/x', 'v2', { kind: 'replace', expectedRevision: 7 }, 'admin'),
  ).toThrow(RevisionConflict);
  expect(
    s.put('aid/plan/x', 'v2', { kind: 'replace', expectedRevision: 1 }, 'admin').revision,
  ).toBe(2);
  const f = s.put('aid/plan/x', '# Titre\n\nv3', { kind: 'force' }, 'admin');
  expect(f).toMatchObject({ revision: 3, body: '# Titre\n\nv3', title: 'Titre' });
});

test('slug invalide : erreur qui nomme la règle, rien d’écrit', () => {
  const s = fresh();
  expect(() => s.put('Plan', 'x', { kind: 'create' }, 'admin')).toThrow(/segments \[a-z0-9._-\]/);
  expect(s.list('')).toEqual([]);
});

test('frontmatter : lu, rendu trié, titre pris dedans, tags indexés', () => {
  const s = fresh();
  const text = '---\ntags:\n  - sqlite\n  - wal\ntitle: Concurrence\n---\n\nUn seul écrivain.\n';
  const p = s.put('lesson/sqlite/un-ecrivain', text, { kind: 'create' }, 'admin');
  expect(p.title).toBe('Concurrence');
  expect(p.frontmatter).toEqual({ tags: ['sqlite', 'wal'], title: 'Concurrence' });
  expect(p.body).toBe('Un seul écrivain.');
  expect(renderMarkdown({ frontmatter: { zeta: 1, alpha: 'a' }, body: 'corps' })).toBe(
    '---\nalpha: a\nzeta: 1\n---\n\ncorps\n',
  );
  expect(renderMarkdown({ frontmatter: {}, body: 'corps\n\n' })).toBe('corps\n');
  expect(parseMarkdown(renderMarkdown(p))).toEqual({
    frontmatter: p.frontmatter,
    body: p.body,
    title: 'Concurrence',
  });
  expect(() => parseMarkdown('---\njuste une chaîne\n---\n')).toThrow(/objet YAML/);
  expect(s.searchFts('wal', 'all', 5).map((h) => h.slug)).toEqual(['lesson/sqlite/un-ecrivain']);
});

test('searchFts avec scope : le namespace et les leçons, pas les autres', () => {
  const s = fresh();
  s.put('aid/plan/base', 'Ouvrir SQLite en mode WAL.', { kind: 'create' }, 'admin');
  s.put(
    'lesson/sqlite/wal',
    'Le mode WAL tolère des lecteurs concurrents.',
    { kind: 'create' },
    'admin',
  );
  s.put('autre/plan/base', 'WAL aussi ici, mais ailleurs.', { kind: 'create' }, 'admin');
  const hits = s.searchFts('wal', 'aid', 10);
  expect(hits.map((h) => h.slug).sort()).toEqual(['aid/plan/base', 'lesson/sqlite/wal']);
  expect(hits[0]).toMatchObject({
    title: expect.any(String),
    snippet: expect.stringMatching(/WAL/),
  });
  expect(hits[0]!.score).toBeGreaterThanOrEqual(0);
  expect(s.searchFts('wal', 'all', 10)).toHaveLength(3);
  expect(s.searchFts('wal', 'all', 2)).toHaveLength(2);
  expect(s.searchFts('tolere', 'all', 10).map((h) => h.slug)).toEqual(['lesson/sqlite/wal']);
});

test('une requête hostile ne jette pas et n’est jamais de la syntaxe FTS', () => {
  const s = fresh();
  s.put('aid/plan/x', 'near la fin, une étoile', { kind: 'create' }, 'admin');
  for (const q of ['"', '*', 'NEAR(', 'a OR', '-x', 'x*', '(', '""', '   ']) {
    expect(() => s.searchFts(q, 'all', 5)).not.toThrow();
  }
  expect(ftsQuery('a "b" c')).toBe('"a" OR "b" OR "c"');
  expect(ftsQuery('"')).toBeNull();
  expect(s.searchFts('near', 'all', 5)).toHaveLength(1);
});

test('remove retire la page et son entrée d’index ; list filtre par préfixe', () => {
  const s = fresh();
  s.put('aid/plan/a', 'alpha', { kind: 'create' }, 'admin');
  s.put('aid/plan/b', 'beta', { kind: 'create' }, 'admin');
  s.put('aid/review/a', 'gamma', { kind: 'create' }, 'admin');
  expect(s.list('aid/plan/')).toEqual(['aid/plan/a', 'aid/plan/b']);
  expect(s.list('aid/')).toHaveLength(3);
  expect(s.remove('aid/plan/a')).toBe(true);
  expect(s.remove('aid/plan/a')).toBe(false);
  expect(s.searchFts('alpha', 'all', 5)).toEqual([]);
  expect(s.list('aid/plan/')).toEqual(['aid/plan/b']);
  expect(s.countByNamespace()).toEqual({ aid: 2 });
});

test('reindex : tout vider puis rejouer all() sérialisé redonne la même recherche', () => {
  const s = fresh();
  s.put('aid/plan/a', '---\ntags: [x]\n---\n# A\n\nalpha wal', { kind: 'create' }, 'admin');
  s.put('lesson/l/b', 'beta wal', { kind: 'create' }, 'admin');
  s.put('lesson/l/b', 'encore', { kind: 'append' }, 'admin');
  const before = s.searchFts('wal', 'all', 10);
  const dump = [...s.all()].map((p) => ({ slug: p.slug, text: renderMarkdown(p) }));
  s.clear();
  expect(s.searchFts('wal', 'all', 10)).toEqual([]);
  for (const d of dump) s.put(d.slug, d.text, { kind: 'create' }, 'reindex');
  expect(s.searchFts('wal', 'all', 10)).toEqual(before);
  expect(s.get('aid/plan/a')?.frontmatter).toEqual({ tags: ['x'] });
});
