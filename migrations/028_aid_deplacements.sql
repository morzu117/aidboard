CREATE TABLE aid_etats (
  sujet TEXT PRIMARY KEY,
  carte INTEGER NOT NULL,
  phase TEXT,
  etat TEXT NOT NULL,
  pr INTEGER
);
CREATE TABLE aid_propositions (
  id INTEGER PRIMARY KEY,
  sujet TEXT NOT NULL,
  carte INTEGER NOT NULL,
  etape TEXT NOT NULL CHECK (etape IN ('review', 'ready')),
  cree_a TEXT NOT NULL,
  fermee_a TEXT,
  confirmation TEXT
);
CREATE UNIQUE INDEX aid_proposition_ouverte
  ON aid_propositions(carte, etape) WHERE fermee_a IS NULL;
