-- Chantier 29 (D155) : le dernier diagnostic d'un serveur, ce que le test de connexion ne garde pas : la version de
-- chaque agent trouvé et la mémoire disponible, avec l'heure de la mesure. Supprimé avec le serveur.
CREATE TABLE server_diagnostics (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  versions TEXT NOT NULL,
  memory_bytes INTEGER,
  measured_at TEXT NOT NULL
);
