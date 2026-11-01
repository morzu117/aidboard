-- Chantier 20 (DM6) : le texte libre des serveurs est masqué à l'entrée depuis ce chantier. Ce qui a été écrit avant
-- l'est une fois, au démarrage suivant, par le daemon — le détecteur est en TypeScript, pas en SQL. Une ligne de
-- `maintenance` dit « à faire » ; le daemon la retire dans la même transaction que la passe.
CREATE TABLE maintenance (task TEXT PRIMARY KEY);
INSERT INTO maintenance (task) VALUES ('masquer-secrets-serveurs');
