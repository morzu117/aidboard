-- Session source conservée tant que le premier tour du fork n'est pas terminé.
ALTER TABLE server_agents ADD COLUMN fork_from TEXT;
