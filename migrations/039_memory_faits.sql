CREATE TABLE memory_jobs_039 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('embed', 'maintain', 'retro', 'faits')),
  slug TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_after TEXT
);
INSERT INTO memory_jobs_039 (id, kind, slug, state, attempts, error, created_at, updated_at, run_after)
  SELECT id, kind, slug, state, attempts, error, created_at, updated_at, run_after FROM memory_jobs;
DROP TABLE memory_jobs;
ALTER TABLE memory_jobs_039 RENAME TO memory_jobs;
CREATE INDEX memory_jobs_pending ON memory_jobs(state, created_at);
