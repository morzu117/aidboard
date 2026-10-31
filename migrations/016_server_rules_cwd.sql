-- Chantier 17, décision opérateur du 2026-10-31 (review complète) : « Toujours autoriser » vaut pour la commande
-- exacte dans le dossier de la discussion, plus sur tout le serveur — `rm -rf build` approuvé dans un projet ne
-- l'est pas ailleurs. La contrainte d'unicité change : table reconstruite.
CREATE TABLE server_rules_cwd (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL,
  pattern TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (server_id, cwd, pattern)
);
-- une règle d'avant ne dit pas son dossier : elle n'est pas reprise (elle approuvait plus que voulu)
DROP TABLE server_rules;
ALTER TABLE server_rules_cwd RENAME TO server_rules;
