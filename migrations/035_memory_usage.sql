-- Journal local : aucune clé étrangère, les lectures survivent à la purge des pages.
CREATE TABLE memory_usage (
  slug TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('search', 'get')),
  role TEXT,
  at TEXT NOT NULL
);
CREATE INDEX memory_usage_slug ON memory_usage(slug);
