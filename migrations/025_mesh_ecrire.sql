-- Élargir le CHECK sans modifier les réglages ni leurs dates existants.
ALTER TABLE confirmations_reglage RENAME TO confirmations_reglage_024;
CREATE TABLE confirmations_reglage (
  action TEXT PRIMARY KEY CHECK (action IN ('merge', 'push', 'nettoyage', 'projet.retirer', 'mesh.ecrire')),
  actif INTEGER NOT NULL CHECK (actif IN (0, 1)),
  modifie_a INTEGER
);
INSERT INTO confirmations_reglage SELECT * FROM confirmations_reglage_024 ORDER BY rowid;
DROP TABLE confirmations_reglage_024;
INSERT INTO confirmations_reglage (action, actif) VALUES ('mesh.ecrire', 1);
ALTER TABLE pda_demandes ADD COLUMN envoi TEXT;
