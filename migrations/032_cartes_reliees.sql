CREATE TABLE groupes_cartes (
  id INTEGER PRIMARY KEY,
  note TEXT,
  cree_a TEXT NOT NULL
);

CREATE TABLE membres_groupe (
  id INTEGER PRIMARY KEY,
  groupe INTEGER NOT NULL REFERENCES groupes_cartes(id) ON DELETE CASCADE,
  mesh TEXT NOT NULL,
  empreinte TEXT NOT NULL,
  carte INTEGER NOT NULL,
  thread_uuid TEXT NOT NULL,
  carte_creee_a TEXT,
  ajoute_a TEXT NOT NULL,
  UNIQUE (mesh, empreinte, carte),
  UNIQUE (groupe, mesh, empreinte)
);
