-- Aucun corps de bulletin : les résultats se relisent uniquement au gateway.
CREATE TABLE avis_mesh (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  sieges TEXT NOT NULL,
  carte INTEGER NOT NULL,
  canal TEXT,
  motion INTEGER,
  jeton TEXT NOT NULL,
  date TEXT NOT NULL,
  etat TEXT NOT NULL,
  confirmation TEXT,
  erreur TEXT,
  echeances TEXT NOT NULL
);
