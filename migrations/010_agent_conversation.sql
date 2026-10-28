-- Chantier 15 (D52) : journal des événements normalisés d'un agent `stream`, et son identifiant de session.
ALTER TABLE agents ADD COLUMN session_id TEXT;
CREATE TABLE agent_messages (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY(agent_id, seq)
);
