-- Préserver les réglages et leurs dates en élargissant le catalogue.
ALTER TABLE confirmations_reglage RENAME TO confirmations_reglage_025;
CREATE TABLE confirmations_reglage (
  action TEXT PRIMARY KEY CHECK (action IN ('merge', 'push', 'nettoyage', 'projet.retirer', 'mesh.ecrire', 'mesh.etat')),
  actif INTEGER NOT NULL CHECK (actif IN (0, 1)),
  modifie_a INTEGER
);
INSERT INTO confirmations_reglage SELECT * FROM confirmations_reglage_025 ORDER BY rowid;
DROP TABLE confirmations_reglage_025;
INSERT INTO confirmations_reglage (action, actif) VALUES ('mesh.etat', 1);
