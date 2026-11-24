# Recette du chantier 60 — Liens et validité des pages mémoire

## Couverture automatique

- Les tests mémoire couvrent la dérivation des liens et de l’état clos, le
  recalcul depuis le miroir, les liens pendants et les métadonnées invalides.
- Les tests de recherche couvrent les remplacements, les voisines et l’option
  `closes`. Les tests du service, des routes, du CLI et du MCP couvrent les
  décisions et la lecture des liens.
- Les tests d’entretien couvrent l’exclusion des pages closes, la date UTC de
  fermeture, le refus d’une proposition devenue caduque et l’annulation du
  découpage.

## Recette réelle à cocher

Utiliser une instance de recette avec un `AID_HOME` neuf et le CLI connecté
comme administrateur à cette instance. Le miroir de recette est
`$AID_HOME/memory`, équivalent de `~/.aid/memory` sur une installation par
défaut. Dans le relevé, consigner la forme des résultats, jamais leurs
valeurs. Omettre les noms d’hôtes, les chemins personnels, les contenus de
mémoire réels et les jetons.

- [ ] Écrire les deux leçons ci-dessous. Lancer
      `aid mem links lesson/exemple/regle` et
      `aid mem links lesson/exemple/exception`. Vérifier les liens
      `precise` et `contredit` en entrée sur la règle et en sortie sur
      l’exception, avec des cibles existantes.

  ```sh
  aid mem put lesson/exemple/regle <<'MD'
  # Règle de calibration

  Vérifier le réglage avant usage.
  MD
  aid mem put lesson/exemple/exception <<'MD'
  ---
  liens:
    precise: [lesson/exemple/regle]
    contredit: [lesson/exemple/regle]
  ---
  # Exception

  Le mode automatique dispense de la vérification manuelle.
  MD
  ```

- [ ] Lancer `aid mem search calibration --scope demo`. Vérifier que la règle
      figure dans les résultats et que l’exception apparaît sous `Voisines`.

- [ ] Exécuter les commandes ci-dessous. Vérifier que `aid mem get` lit encore
      la page d’origine, que `aid mem links` indique sa fermeture et que la
      recherche courante affiche la décision avec `(remplace …)`. Avec
      `--closes`, vérifier que la recherche rend aussi la page fermée.

  ```sh
  printf '# Protocole\n\nProcédure de démonstration.\n' | aid mem put demo/protocole
  aid mem decide revision --namespace demo --title 'Procédure révisée' \
    --raison 'Exemple de remplacement' --remplace demo/protocole </dev/null
  aid mem get demo/protocole
  aid mem links demo/protocole
  aid mem search protocole --scope demo
  aid mem search protocole --scope demo --closes
  ```

- [ ] Tenter une seconde décision avec un nouveau slug sur `demo/protocole`.
      Vérifier le message `deja_close` et le code de sortie 6.

  ```sh
  aid mem decide seconde-revision --namespace demo --title 'Autre procédure' \
    --raison 'Essai de second remplacement' --remplace demo/protocole </dev/null
  ```

- [ ] Vérifier que le miroir conserve les fichiers des deux leçons, du protocole
      clos et de la décision. Lancer `aid mem reindex`, puis répéter
      `aid mem links` et les recherches avec et sans `--closes`. Vérifier que
      les liens et l’état clos sont identiques.

- [ ] Écrire le fichier ci-dessous directement dans le miroir de recette.
      Lancer `aid mem reindex` et vérifier que `aid mem get demo/tolerance`
      lit la page. Le journal du daemon doit signaler le type inconnu et
      `aid mem links demo/tolerance` doit rendre le lien valide pendant.

  ```sh
  cat > "$AID_HOME/memory/demo/tolerance.md" <<'MD'
  ---
  liens:
    inconnu: [demo/protocole]
    precise: [demo/absente]
  ---
  # Tolérance à la relecture
  MD
  aid mem reindex
  aid mem get demo/tolerance
  aid mem links demo/tolerance
  ```

- [ ] Interroger `GET /api/memory/health` sur l’instance de recette. Vérifier
      que `closed` compte le protocole clos et que `links.pendants` compte
      la cible absente.

- [ ] Recette observée et accord pour le merge
