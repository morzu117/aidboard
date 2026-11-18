-- Résultats sans proposition, locaux à cette machine, jamais dans le miroir git.
CREATE TABLE memory_maintenance_seen (
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tags', 'duplicate', 'split')),
  revision INTEGER NOT NULL,
  at TEXT NOT NULL,
  vocabulary TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (slug, kind)
);
