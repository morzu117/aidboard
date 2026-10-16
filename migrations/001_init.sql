CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  root TEXT NOT NULL UNIQUE,
  base_branch TEXT NOT NULL,
  worktrees_dir TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('feat', 'fix', 'chore', 'spike')),
  branch TEXT NOT NULL,
  base TEXT NOT NULL,
  worktree TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'active', 'review', 'merged', 'archived')),
  phase TEXT,
  index_state TEXT NOT NULL CHECK (index_state IN ('disabled', 'indexing', 'ready', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  mode TEXT NOT NULL CHECK (mode IN ('standard', 'swairm')),
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  transport TEXT NOT NULL,
  status TEXT NOT NULL,
  cwd TEXT NOT NULL,
  command TEXT NOT NULL,
  pid INTEGER,
  exit_code INTEGER,
  issue INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  topic_id TEXT,
  workspace_id TEXT NOT NULL,
  action TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'needs_human', 'failed')),
  exit_code INTEGER,
  result TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  v INTEGER NOT NULL,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  workspace_id TEXT,
  topic_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX events_topic ON events(topic_id, seq);
