# Recette du chantier 66 — Avis de plusieurs fournisseurs

## Recette réelle à cocher

Sur la tour, utiliser une instance de recette avec les trois CLI installés et
connectés. Utiliser uniquement des questions factices. Dans le relevé, noter
la forme des données, jamais leur valeur. Omettre les noms d'hôtes, les
chemins personnels et les jetons.

- [ ] Lancer `vibe --help`. Relever la syntaxe réelle de `-p`,
      `--max-turns`, `--output json`, `--max-price` et `--enabled-tools`,
      et la présence éventuelle d'un sélecteur de modèle. Si un flag diffère,
      corriger l'adaptateur dans un commit de recette.
- [ ] Lancer `codex exec --help`. Vérifier `--sandbox read-only`,
      `--skip-git-repo-check` et `-o`.
- [ ] Lancer `aid avis "<question factice sans secret>"`. Vérifier les trois
      avis Claude et le tableau d'accord.
- [ ] Lancer `aid avis --challenge "<question factice>"`. Vérifier les trois
      avis, un de chaque fournisseur, le tableau d'accord et le coût total
      (montant ou « inconnu »).
- [ ] Soumettre une question contenant une clé fictive composée du préfixe
      `sk-` suivi de 16 caractères alphanumériques. Vérifier le message
      « question refusée : ressemble à une clé API » et l'absence de
      lancement de processus fournisseur.
- [ ] Depuis l'écran d'avis du cockpit, lancer une demande factice. Ouvrir
      ensuite la demande du challenge lancé par le CLI dans l'historique
      des avis et vérifier l'affichage des trois fournisseurs.
- [ ] Retirer `swairm` du `PATH` du daemon de recette et relancer le daemon.
      Répéter la demande du cockpit et le challenge, puis vérifier que
      l'écran affiche leurs résultats.
- [ ] Relancer le daemon de recette avec un CLI absent du `PATH`, par exemple
      `vibe`. Rejouer le challenge avec `--json`. Vérifier que l'avis
      correspondant est en `echec` avec « CLI absent » et que les deux autres
      fournisseurs répondent. Rétablir le `PATH` initial du daemon.
- [ ] Inspecter le journal du daemon sur la période des essais. Vérifier
      l'absence du texte des questions, y compris celle qui a été refusée.

- [ ] Recette observée et accord pour le merge
