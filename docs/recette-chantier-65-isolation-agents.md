# Recette du chantier 65 — Isolation des agents

## Couverture automatique

- Les tests du profil vérifient les montages et les chemins masqués. Les tests
  du lanceur couvrent le démarrage, le refus et les deux transports avec des
  doublures.
- Les tests de doctor couvrent la version, le mode `off` et le champ absent.
  Le test de vue vérifie la marque « isolé » et son absence.

## Recette réelle à cocher

Faire la recette sur la tour, sous WSL, avec une instance et un sujet de
recette. Consigner la forme des résultats, jamais leurs valeurs, et omettre
les noms d’hôte et les chemins personnels.

- [ ] Installer bubblewrap avec `sudo apt install bubblewrap`, puis lancer
      `npx vitest run test/isolation-integration.test.ts`. Vérifier que le
      test s’exécute et passe.
- [ ] Régler `agents.isolation: bwrap` et redémarrer le daemon. Vérifier
      qu’`aid doctor` affiche « Isolation : bwrap <version> ».
- [ ] Garder `agents.isolation: bwrap` et démarrer le daemon avec un
      `PATH` sans bwrap. Vérifier le refus au démarrage et le message
      « isolation demandée mais bubblewrap indisponible : bwrap absent du
      PATH ». Rétablir le `PATH` et redémarrer pour la suite.
- [ ] Lancer un agent `claude` en stream dans le sujet. Vérifier qu’il voit
      son worktree, peut y faire un commit et que sa carte porte « isolé ».
- [ ] Dans le même agent, vérifier que `git push` et l’écriture d’un
      fichier de test dans le home échouent, et que `ls ~/.ssh` ne rend
      aucune entrée. Vérifier que `touch .git/hooks/x` échoue. Dans un
      worktree lié, vérifier aussi le refus avec
      `touch "$(git rev-parse --git-common-dir)/hooks/x"` pour tester le
      répertoire des hooks du dépôt.
- [ ] Lancer un agent `codex` dans le sujet. Refaire les deux contrôles
      précédents, du commit et de la marque jusqu’aux refus et au masquage
      de `~/.ssh`.
- [ ] Lancer un agent en PTY. Vérifier que le terminal répond, que Ctrl-C
      interrompt une commande au premier plan et que le terminal prend en
      compte un redimensionnement.
- [ ] Le lendemain, reprendre la session `claude`. Vérifier qu’elle
      répond sans nouvelle connexion après le rafraîchissement du jeton
      d’abonnement.
- [ ] Ouvrir un `shell` dans un sujet avec l’isolation activée. Vérifier
      qu’une écriture de test dans le home réussit et que la carte ne porte
      pas la marque « isolé ». Supprimer le fichier de test.

## Risques connus

- `~/.claude.json` reste inscriptible.
- Les autres dépôts du home restent lisibles.
- `git pack-refs` ou la suppression d’une branche échoue dans le bac à sable.

- [ ] Recette observée et accord pour le merge
