import { parse, stringify } from 'yaml';
import {
  LESSON_NS,
  type MemoryPage,
  type PutMode,
  RevisionConflict,
  type SearchHit,
} from '../../shared/memory.js';
import type { Db } from '../db.js';
import { assertMemSlug, namespaceOf } from './slug.js';

type Frontmatter = Record<string, unknown>;

interface Row {
  rowid: number;
  slug: string;
  namespace: string;
  title: string;
  frontmatter: string;
  body: string;
  revision: number;
  author: string;
  created_at: string;
  updated_at: string;
}

function isRecord(v: unknown): v is Frontmatter {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

// Une page = frontmatter YAML facultatif puis corps. Le titre vient du frontmatter, sinon du premier « # ».
export function parseMarkdown(text: string): {
  frontmatter: Frontmatter;
  body: string;
  title: string | undefined;
} {
  let frontmatter: Frontmatter = {};
  let body = text;
  const m = FRONTMATTER_RE.exec(text);
  if (m) {
    const doc: unknown = m[1]!.trim() === '' ? {} : parse(m[1]!);
    if (doc !== null && doc !== undefined && !isRecord(doc)) {
      throw new Error('frontmatter : un objet YAML est attendu');
    }
    frontmatter = (doc as Frontmatter | null | undefined) ?? {};
    body = text.slice(m[0].length);
  }
  body = body.replace(/^\s*\n/, '').replace(/\s+$/, '');
  const fmTitle = frontmatter.title;
  const heading = /^#\s+(.+?)\s*$/m.exec(body)?.[1];
  const title = typeof fmTitle === 'string' && fmTitle.trim() ? fmTitle.trim() : heading;
  return { frontmatter, body, title };
}

export function renderMarkdown(p: Pick<MemoryPage, 'frontmatter' | 'body'>): string {
  const body = p.body.replace(/\s+$/, '');
  const keys = Object.keys(p.frontmatter).sort();
  if (keys.length === 0) return `${body}\n`;
  const sorted: Frontmatter = {};
  for (const k of keys) sorted[k] = p.frontmatter[k];
  return `---\n${stringify(sorted)}---\n\n${body}\n`;
}

function tagsOf(fm: Frontmatter): string {
  const tags = fm.tags;
  return Array.isArray(tags) ? tags.filter((t) => typeof t === 'string').join(' ') : '';
}

function fromRow(r: Row): MemoryPage {
  return {
    slug: r.slug,
    namespace: r.namespace,
    title: r.title,
    frontmatter: JSON.parse(r.frontmatter) as Frontmatter,
    body: r.body,
    revision: r.revision,
    author: r.author,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Termes cités un par un : une entrée utilisateur n'est jamais de la syntaxe FTS5.
export function ftsQuery(q: string): string | null {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  return terms.length === 0 ? null : terms.map((t) => `"${t}"`).join(' OR ');
}

function snippetOf(body: string, q: string, width = 160): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean);
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = Math.max(0, at === -1 ? 0 : at - Math.floor(width / 3));
  const cut = flat.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${cut}${start + width < flat.length ? '…' : ''}`;
}

export class MemoryStore {
  constructor(private readonly db: Db) {}

  private row(slug: string): Row | undefined {
    return this.db.prepare('SELECT rowid, * FROM memory_pages WHERE slug = ?').get(slug) as
      Row | undefined;
  }

  private ftsInsert(rowid: number, slug: string, title: string, body: string, tags: string) {
    this.db
      .prepare('INSERT INTO memory_fts (rowid, slug, title, body, tags) VALUES (?, ?, ?, ?, ?)')
      .run(rowid, slug, title, body, tags);
  }

  // Table contentless : la suppression redonne les valeurs indexées.
  private ftsDelete(r: Row) {
    this.db
      .prepare(
        "INSERT INTO memory_fts (memory_fts, rowid, slug, title, body, tags) VALUES ('delete', ?, ?, ?, ?, ?)",
      )
      .run(r.rowid, r.slug, r.title, r.body, tagsOf(JSON.parse(r.frontmatter) as Frontmatter));
  }

  get(slug: string): MemoryPage | undefined {
    const r = this.row(slug);
    return r ? fromRow(r) : undefined;
  }

  // Transaction synchrone : rien d'asynchrone ici, le fichier et le commit viennent après.
  put(slug: string, text: string, mode: PutMode, author: string, title?: string): MemoryPage {
    assertMemSlug(slug);
    const parsed = parseMarkdown(text);
    const now = new Date().toISOString();
    return this.db.transaction((): MemoryPage => {
      const existing = this.row(slug);
      if (!existing) {
        const fm = { ...parsed.frontmatter, ...(title && { title }) };
        const t = title ?? parsed.title ?? slug.slice(slug.lastIndexOf('/') + 1);
        this.db
          .prepare(
            'INSERT INTO memory_pages (slug, namespace, title, frontmatter, body, revision, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
          )
          .run(slug, namespaceOf(slug), t, JSON.stringify(fm), parsed.body, author, now, now);
        const r = this.row(slug)!;
        this.ftsInsert(r.rowid, slug, t, parsed.body, tagsOf(fm));
        return fromRow(r);
      }
      if (mode.kind === 'create') throw new RevisionConflict(slug, existing.revision);
      if (mode.kind === 'replace' && mode.expectedRevision !== existing.revision) {
        throw new RevisionConflict(slug, existing.revision);
      }
      const oldFm = JSON.parse(existing.frontmatter) as Frontmatter;
      let fm: Frontmatter;
      let body: string;
      let t: string;
      if (mode.kind === 'append') {
        fm = { ...oldFm, ...parsed.frontmatter, ...(title && { title }) };
        body = existing.body === '' ? parsed.body : `${existing.body}\n\n${parsed.body}`;
        t = title ?? existing.title;
      } else {
        fm = { ...parsed.frontmatter, ...(title && { title }) };
        body = parsed.body;
        t = title ?? parsed.title ?? slug.slice(slug.lastIndexOf('/') + 1);
      }
      this.ftsDelete(existing);
      this.db
        .prepare(
          'UPDATE memory_pages SET title = ?, frontmatter = ?, body = ?, revision = revision + 1, author = ?, updated_at = ? WHERE slug = ?',
        )
        .run(t, JSON.stringify(fm), body, author, now, slug);
      this.ftsInsert(existing.rowid, slug, t, body, tagsOf(fm));
      return fromRow(this.row(slug)!);
    })();
  }

  remove(slug: string): boolean {
    return this.db.transaction((): boolean => {
      const r = this.row(slug);
      if (!r) return false;
      this.ftsDelete(r);
      this.db.prepare('DELETE FROM memory_pages WHERE slug = ?').run(slug);
      return true;
    })();
  }

  list(prefix: string): string[] {
    return (
      this.db
        .prepare('SELECT slug FROM memory_pages WHERE substr(slug, 1, ?) = ? ORDER BY slug')
        .all(prefix.length, prefix) as { slug: string }[]
    ).map((r) => r.slug);
  }

  // scope <ns> = ce namespace et les leçons ; 'all' = tout.
  searchFts(q: string, scope: string | 'all', limit: number): SearchHit[] {
    const match = ftsQuery(q);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT p.slug, p.title, p.body, bm25(memory_fts, 0, 4.0, 1.0, 2.0) AS rank
         FROM memory_fts JOIN memory_pages p ON p.rowid = memory_fts.rowid
         WHERE memory_fts MATCH ? AND (? = 'all' OR p.namespace IN (?, ?))
         ORDER BY rank LIMIT ?`,
      )
      .all(match, scope, scope, LESSON_NS, limit) as {
      slug: string;
      title: string;
      body: string;
      rank: number;
    }[];
    return rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      snippet: snippetOf(r.body, q),
      score: Math.round(-r.rank * 1000) / 1000,
    }));
  }

  countByNamespace(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .prepare('SELECT namespace, count(*) AS n FROM memory_pages GROUP BY namespace')
      .all() as { namespace: string; n: number }[]) {
      out[r.namespace] = r.n;
    }
    return out;
  }

  jobCounts(): { pending: number; failed: number } {
    const row = this.db
      .prepare(
        "SELECT sum(state IN ('pending', 'running')) AS pending, sum(state = 'failed') AS failed FROM memory_jobs",
      )
      .get() as { pending: number | null; failed: number | null };
    return { pending: row.pending ?? 0, failed: row.failed ?? 0 };
  }

  *all(): Iterable<MemoryPage> {
    for (const r of this.db
      .prepare('SELECT rowid, * FROM memory_pages ORDER BY slug')
      .iterate() as Iterable<Row>) {
      yield fromRow(r);
    }
  }

  // Pour reindex : vide pages et index d'un coup.
  clear(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_pages').run();
      this.db.prepare("INSERT INTO memory_fts (memory_fts) VALUES ('delete-all')").run();
    })();
  }
}
