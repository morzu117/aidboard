-- Chantier 31 (D177) : les appareils entrés par le mode host. `empreinte` est le SHA-256 du jeton
-- de l'appareil, jamais le jeton. Un accès dure 8 heures, sans prolongation ; révoquer pose
-- `revoque_a`. Le Mac hôte n'est pas une ligne : il n'entre jamais par cette table.
CREATE TABLE appareils (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  identite TEXT,
  cree_a TEXT NOT NULL,
  dernier_contact TEXT,
  expire_a TEXT NOT NULL,
  revoque_a TEXT,
  empreinte TEXT NOT NULL UNIQUE
);
