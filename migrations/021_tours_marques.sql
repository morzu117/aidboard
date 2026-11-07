-- Chantier 32 (D189) : la dernière marque du tour par agent. Un nouveau tour rend
-- l'ancienne marque sans effet ; `par` vaut `mac` ou l'identifiant de l'appareil.
CREATE TABLE tours_marques (
  agent_id TEXT PRIMARY KEY,
  tour_id TEXT NOT NULL,
  etat TEXT NOT NULL CHECK (etat IN ('relu','a_reprendre')),
  par TEXT NOT NULL,
  a TEXT NOT NULL
);
