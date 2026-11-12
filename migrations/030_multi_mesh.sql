-- D312 : la transaction et user_version = 30 sont portés par migrate().
-- Les données antérieures appartiennent à principal ; aucun défaut ne subsiste.

CREATE TABLE mesh_inbox_030 (
  id INTEGER NOT NULL,
  thread_id TEXT,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reply_to INTEGER,
  obligation_id TEXT,
  seen_at TEXT,
  event_id TEXT NOT NULL,
  decided_at TEXT,
  mesh TEXT NOT NULL,
  PRIMARY KEY (mesh, id)
);
INSERT INTO mesh_inbox_030 (id, thread_id, from_node, to_node, kind, content, created_at, reply_to, obligation_id, seen_at, event_id, decided_at, mesh)
  SELECT id, thread_id, from_node, to_node, kind, content, created_at, reply_to, obligation_id, seen_at, event_id, decided_at, 'principal' FROM mesh_inbox;
DROP TABLE mesh_inbox;
ALTER TABLE mesh_inbox_030 RENAME TO mesh_inbox;

CREATE TABLE mesh_state_030 (
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  mesh TEXT NOT NULL,
  PRIMARY KEY (mesh, k)
);
INSERT INTO mesh_state_030 (k, v, mesh)
  SELECT k, v, 'principal' FROM mesh_state;
DROP TABLE mesh_state;
ALTER TABLE mesh_state_030 RENAME TO mesh_state;

CREATE TABLE aid_etats_030 (
  sujet TEXT NOT NULL,
  carte INTEGER NOT NULL,
  phase TEXT,
  etat TEXT NOT NULL,
  pr INTEGER,
  mesh TEXT NOT NULL,
  PRIMARY KEY (mesh, sujet)
);
INSERT INTO aid_etats_030 (sujet, carte, phase, etat, pr, mesh)
  SELECT sujet, carte, phase, etat, pr, 'principal' FROM aid_etats;
DROP TABLE aid_etats;
ALTER TABLE aid_etats_030 RENAME TO aid_etats;

CREATE TABLE aid_propositions_030 (
  id INTEGER PRIMARY KEY,
  sujet TEXT NOT NULL,
  carte INTEGER NOT NULL,
  etape TEXT NOT NULL CHECK (etape IN ('review', 'ready')),
  cree_a TEXT NOT NULL,
  fermee_a TEXT,
  confirmation TEXT,
  mesh TEXT NOT NULL
);
INSERT INTO aid_propositions_030 (id, sujet, carte, etape, cree_a, fermee_a, confirmation, mesh)
  SELECT id, sujet, carte, etape, cree_a, fermee_a, confirmation, 'principal' FROM aid_propositions;
DROP TABLE aid_propositions;
ALTER TABLE aid_propositions_030 RENAME TO aid_propositions;

CREATE TABLE swairm_propositions_030 (
  id INTEGER PRIMARY KEY,
  projet TEXT NOT NULL,
  sujet TEXT NOT NULL,
  etat TEXT NOT NULL,
  titre TEXT NOT NULL,
  carte INTEGER NOT NULL,
  cree_a TEXT NOT NULL,
  fermee_a TEXT,
  confirmation TEXT,
  mesh TEXT NOT NULL
);
INSERT INTO swairm_propositions_030 (id, projet, sujet, etat, titre, carte, cree_a, fermee_a, confirmation, mesh)
  SELECT id, projet, sujet, etat, titre, carte, cree_a, fermee_a, confirmation, 'principal' FROM swairm_propositions;
DROP TABLE swairm_propositions;
ALTER TABLE swairm_propositions_030 RENAME TO swairm_propositions;

CREATE TABLE avis_mesh_030 (
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
  echeances TEXT NOT NULL,
  mesh TEXT NOT NULL
);
INSERT INTO avis_mesh_030 (id, question, sieges, carte, canal, motion, jeton, date, etat, confirmation, erreur, echeances, mesh)
  SELECT id, question, sieges, carte, canal, motion, jeton, date, etat, confirmation, erreur, echeances, 'principal' FROM avis_mesh;
DROP TABLE avis_mesh;
ALTER TABLE avis_mesh_030 RENAME TO avis_mesh;

CREATE INDEX mesh_inbox_created ON mesh_inbox (mesh, created_at DESC);
CREATE UNIQUE INDEX swairm_proposition_ouverte
  ON swairm_propositions(mesh, projet, sujet, etat) WHERE fermee_a IS NULL;
CREATE UNIQUE INDEX aid_proposition_ouverte
  ON aid_propositions(mesh, carte, etape) WHERE fermee_a IS NULL;

CREATE TABLE meshes_connus (
  nom TEXT PRIMARY KEY,
  empreinte TEXT NOT NULL,
  vu_a TEXT NOT NULL
);
