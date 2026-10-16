-- Modèle et dimension des vecteurs en place ; la table vec0 elle-même est créée par le daemon
-- une fois l'extension sqlite-vec chargée (elle n'est pas disponible sur toutes les plateformes).
CREATE TABLE memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

ALTER TABLE memory_jobs ADD COLUMN run_after TEXT;
