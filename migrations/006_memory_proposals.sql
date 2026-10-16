CREATE TABLE memory_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tags', 'duplicate', 'split')),
  slug TEXT NOT NULL,
  payload TEXT NOT NULL,
  rationale TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'applied', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX memory_proposals_slug ON memory_proposals(slug, kind, state);
