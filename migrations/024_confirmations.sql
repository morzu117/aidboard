CREATE TABLE confirmations_reglage (
  action TEXT PRIMARY KEY CHECK (action IN ('merge', 'push', 'nettoyage', 'projet.retirer')),
  actif INTEGER NOT NULL CHECK (actif IN (0, 1)),
  modifie_a INTEGER
);
INSERT INTO confirmations_reglage (action, actif) VALUES
  ('merge', 1), ('push', 1), ('nettoyage', 1), ('projet.retirer', 1);

CREATE TABLE confirmations_armement (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  arme INTEGER NOT NULL CHECK (arme IN (0, 1)),
  arme_a INTEGER,
  desarme_a INTEGER
);
INSERT INTO confirmations_armement (id, arme) VALUES (1, 0);

ALTER TABLE pda_demandes ADD COLUMN classe TEXT;
ALTER TABLE pda_demandes ADD COLUMN params TEXT;
ALTER TABLE pda_demandes ADD COLUMN resume TEXT;
ALTER TABLE pda_demandes ADD COLUMN numero_mac TEXT;
ALTER TABLE pda_demandes ADD COLUMN resultat TEXT CHECK (resultat IS NULL OR resultat IN ('executee', 'echouee', 'perimee', 'annulee'));
ALTER TABLE pda_demandes ADD COLUMN raison TEXT;
