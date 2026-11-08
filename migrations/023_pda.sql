CREATE TABLE pda_appareils (
  id TEXT PRIMARY KEY,
  appareil_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  cred_id TEXT NOT NULL UNIQUE,
  cle_publique TEXT NOT NULL,
  cle_relais TEXT NOT NULL,
  etat TEXT NOT NULL CHECK (etat IN ('attente', 'actif', 'revoque')),
  cree_a TEXT NOT NULL,
  active_a TEXT,
  revoque_a TEXT
);

CREATE TABLE pda_demandes (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  sujet TEXT NOT NULL,
  h_demande TEXT NOT NULL,
  numero TEXT NOT NULL,
  echeance INTEGER NOT NULL,
  etat TEXT NOT NULL CHECK (etat IN ('ouverte', 'confirmee', 'refusee', 'expiree')),
  consomme_a TEXT,
  cree_a TEXT NOT NULL
);
