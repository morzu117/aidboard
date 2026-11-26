CREATE TABLE memory_proposals_038 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tags', 'duplicate', 'split', 'retro')),
  slug TEXT NOT NULL,
  payload TEXT NOT NULL,
  rationale TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'applied', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
INSERT INTO memory_proposals_038 (id, kind, slug, payload, rationale, state, created_at, decided_at)
  SELECT id, kind, slug, payload, rationale, state, created_at, decided_at FROM memory_proposals;
DROP TABLE memory_proposals;
ALTER TABLE memory_proposals_038 RENAME TO memory_proposals;
CREATE INDEX memory_proposals_slug ON memory_proposals(slug, kind, state);

CREATE TABLE memory_jobs_038 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('embed', 'maintain', 'retro')),
  slug TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_after TEXT
);
INSERT INTO memory_jobs_038 (id, kind, slug, state, attempts, error, created_at, updated_at, run_after)
  SELECT id, kind, slug, state, attempts, error, created_at, updated_at, run_after FROM memory_jobs;
DROP TABLE memory_jobs;
ALTER TABLE memory_jobs_038 RENAME TO memory_jobs;
CREATE INDEX memory_jobs_pending ON memory_jobs(state, created_at);

CREATE TABLE memory_maintenance_seen_038 (
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tags', 'duplicate', 'split', 'retro')),
  revision INTEGER NOT NULL,
  at TEXT NOT NULL,
  vocabulary TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (slug, kind)
);
INSERT INTO memory_maintenance_seen_038 (slug, kind, revision, at, vocabulary)
  SELECT slug, kind, revision, at, vocabulary FROM memory_maintenance_seen;
DROP TABLE memory_maintenance_seen;
ALTER TABLE memory_maintenance_seen_038 RENAME TO memory_maintenance_seen;
