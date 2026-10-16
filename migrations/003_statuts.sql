-- Statuts fins (v0.2) : le dernier agent.status projeté, la demande en cours, la pause.
ALTER TABLE agents ADD COLUMN status_reason TEXT;
ALTER TABLE agents ADD COLUMN status_message TEXT;
-- 'hook' | 'heuristic' | 'daemon' ; NULL tant qu'aucun signal n'est arrivé
ALTER TABLE agents ADD COLUMN status_source TEXT;
ALTER TABLE agents ADD COLUMN status_at TEXT;
-- JSON : silence, dernière ligne, invite détectée (infobulle d'un statut estimé)
ALTER TABLE agents ADD COLUMN status_detail TEXT;
ALTER TABLE agents ADD COLUMN last_tool TEXT;
-- JSON de la demande en cours (permission ou question), NULL sinon
ALTER TABLE agents ADD COLUMN pending TEXT;
ALTER TABLE agents ADD COLUMN paused_at TEXT;
