-- Un projet peut être un dépôt purement local : remote NULL, les sujets partent de la branche locale.
ALTER TABLE workspaces ADD COLUMN remote TEXT DEFAULT 'origin';
