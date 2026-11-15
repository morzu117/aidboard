CREATE TABLE cartes_en_vol (
  mesh TEXT NOT NULL,
  ligne_swairm TEXT NOT NULL,
  projet INTEGER NOT NULL CHECK (projet > 0),
  etat TEXT NOT NULL CHECK (etat IN ('en-vol', 'incertain')),
  depuis TEXT NOT NULL,
  PRIMARY KEY (mesh, ligne_swairm)
);
