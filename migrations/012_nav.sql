-- Chantier 15 (D55, groupe B) : groupes de la barre gauche, placement des sujets, réglages de la barre.
CREATE TABLE nav_group (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  ord INTEGER NOT NULL,
  collapsed INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  workspace_id TEXT NULL UNIQUE REFERENCES workspaces(id)
);
CREATE TABLE nav_placement (
  topic_id TEXT PRIMARY KEY REFERENCES topics(id),
  group_id TEXT NOT NULL REFERENCES nav_group(id),
  ord INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NULL
);
CREATE TABLE nav_pref (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
