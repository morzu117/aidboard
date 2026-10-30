-- Chantier 17 (R.1, D74) : discussions sur un serveur distant, à côté des sujets (aucun run ni workspace fictif).
-- Supprimer un serveur supprime ses discussions, leurs agents et leurs fils (décision opérateur du 2026-10-30).
CREATE TABLE server_discussions (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX server_discussions_server ON server_discussions(server_id);
-- Un agent distant : `session_id` pour la reprise (`--resume`, `thread/resume`), `tmux_session` et
-- `out_offset` pour se rattacher au relais sans perte ni doublon (D73).
CREATE TABLE server_agents (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL REFERENCES server_discussions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  tmux_session TEXT,
  out_offset INTEGER NOT NULL DEFAULT 0,
  permission_mode TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX server_agents_discussion ON server_agents(discussion_id);
-- Même forme que `agent_messages` (010, 011), colonne de marque comprise : le fil se rend avec les mêmes composants.
CREATE TABLE server_agent_messages (
  agent_id TEXT NOT NULL REFERENCES server_agents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL,
  marked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, seq)
);
