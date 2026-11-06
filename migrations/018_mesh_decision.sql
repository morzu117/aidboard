-- Chantier 28 (D137) : « En faire une décision » sur un DM du mesh. Une marque locale de l'humain, comme `seen_at`
-- (12.4) : écrite en direct, jamais un fait du mesh, et rien n'est envoyé au pair.
ALTER TABLE mesh_inbox ADD COLUMN decided_at TEXT;
