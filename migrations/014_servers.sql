-- Chantier 17 (S.1, D72, D76) : serveurs distants. Aucun secret : ni mot de passe, ni clé, ni passphrase.
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('ssh_alias', 'ssh_host', 'command')),
  target TEXT NOT NULL,
  ssh_options TEXT,
  load_profile INTEGER NOT NULL DEFAULT 1,
  workdir TEXT NOT NULL DEFAULT '~',
  shell TEXT NOT NULL DEFAULT 'bash',
  keep_session INTEGER NOT NULL DEFAULT 1,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  confirm_destructive INTEGER NOT NULL DEFAULT 1,
  allowed_dirs TEXT NOT NULL DEFAULT '["~"]',
  group_name TEXT NOT NULL DEFAULT 'Serveurs',
  color TEXT NOT NULL,
  detected_agents TEXT,
  last_test_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- « Toujours autoriser sur ce serveur » (§11.3) : révocable depuis la configuration (§11.2).
CREATE TABLE server_rules (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (server_id, pattern)
);
