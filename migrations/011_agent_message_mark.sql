-- Chantier 15 (A.7) : marque d'une question dans le fil (repères de discussion).
ALTER TABLE agent_messages ADD COLUMN marked INTEGER NOT NULL DEFAULT 0;
