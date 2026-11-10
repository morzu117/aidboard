CREATE TABLE swairm_etats (
  projet TEXT,
  sujet TEXT,
  etat TEXT,
  vu_a TEXT,
  PRIMARY KEY (projet, sujet)
);
CREATE TABLE swairm_propositions (
  id INTEGER PRIMARY KEY,
  projet TEXT NOT NULL,
  sujet TEXT NOT NULL,
  etat TEXT NOT NULL,
  titre TEXT NOT NULL,
  carte INTEGER NOT NULL,
  cree_a TEXT NOT NULL,
  fermee_a TEXT,
  confirmation TEXT
);
CREATE UNIQUE INDEX swairm_proposition_ouverte
  ON swairm_propositions(projet, sujet, etat) WHERE fermee_a IS NULL;
