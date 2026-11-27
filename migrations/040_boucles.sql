CREATE TABLE boucles (
  id TEXT PRIMARY KEY NOT NULL,
  sujet_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN (
    'plan', 'attente_go', 'acceptation', 'dev', 'gate', 'revue',
    'triage', 'livraison_prete', 'escalade', 'arretee'
  )),
  tete TEXT NOT NULL CHECK (length(tete) = 40),
  donnees TEXT NOT NULL CHECK (json_valid(donnees)),
  CHECK (length(json_extract(donnees, '$.gate.tete')) = 40),
  CHECK (length(json_extract(donnees, '$.revue.tete')) = 40)
);

CREATE UNIQUE INDEX boucles_sujet_actif
  ON boucles (sujet_id)
  WHERE phase NOT IN ('arretee', 'livraison_prete');

CREATE TABLE boucle_etapes (
  boucle_id TEXT NOT NULL REFERENCES boucles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('plan', 'acceptation', 'dev', 'gate', 'revue', 'triage')),
  tentative INTEGER NOT NULL CHECK (tentative >= 1),
  donnees TEXT NOT NULL CHECK (json_valid(donnees)),
  CHECK (length(json_extract(donnees, '$.teteDepart')) = 40),
  CHECK (length(json_extract(donnees, '$.teteArrivee')) = 40),
  CHECK (json_extract(donnees, '$.issue') IN (
    'pass', 'fail', 'cannot_evaluate', 'skipped', 'delai_depasse'
  )),
  PRIMARY KEY (boucle_id, type, tentative),
  UNIQUE (boucle_id, position)
);
