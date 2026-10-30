-- Chantier 16 (D67, D69) : réglages d'un agent `stream`, et le dernier choisi par kind pour le suivant.
ALTER TABLE agents ADD COLUMN permission_mode TEXT;
ALTER TABLE agents ADD COLUMN model TEXT;
ALTER TABLE agents ADD COLUMN effort TEXT;
CREATE TABLE agent_defaults (
  kind TEXT PRIMARY KEY,
  permission_mode TEXT NOT NULL,
  model TEXT,
  effort TEXT
);
