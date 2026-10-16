ALTER TABLE workspaces ADD COLUMN namespace TEXT;

CREATE TABLE memory_pages (
  slug TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  title TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX memory_pages_ns ON memory_pages(namespace, slug);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  slug UNINDEXED,
  title,
  body,
  tags,
  content='',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE memory_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('embed', 'maintain')),
  slug TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX memory_jobs_pending ON memory_jobs(state, created_at);
