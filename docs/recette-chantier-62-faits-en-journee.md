# Recette du chantier 62 — Faits candidats en journée

## Couverture automatique

- Les tests de capture couvrent le déclenchement, le report du délai,
  le plafond journalier et les écritures ignorées. Les tests du job
  couvrent l’écriture des faits et le refus par le filtre.
- Les tests de santé vérifient le nombre de candidats, les jobs créés
  depuis minuit local et le plafond, y compris quand la capture est
  éteinte. Les tests du doctor vérifient la ligne sous le plafond,
  l’avertissement au plafond et l’indication de capture éteinte.

## Recette réelle à cocher

Utiliser une instance de recette sur la tour de travail, avec Ollama et
le modèle configuré dans `memory.maintenance.model`. Régler
`memory.capture.enabled: true` et `memory.capture.delayMinutes: 1`.
Activer l’entretien de nuit pour observer la proposition de rétro.
Utiliser des observations fictives. Dans le relevé, consigner la forme
des résultats, jamais leurs valeurs. Omettre tout nom d’hôte, chemin
personnel, contenu de mémoire réel et jeton.

- [ ] Faire écrire son dev-handoff par un agent d’un sujet de recette.
      Une minute plus tard, vérifier si des pages `<ns>/fait/<task>.*`
      existent avec `statut: candidat` et `liens.issu_de` vers le
      handoff, ou si le modèle n’a trouvé aucun fait. Consigner l’issue.
- [ ] Sur un nouveau handoff, faire trois `--append` rapprochés avant
      l’échéance et vérifier qu’ils donnent une seule extraction.
      Comparer le compteur du jour de `aid doctor` avant et après,
      sans autre activité de capture sur cet intervalle.
- [ ] Dans un autre terminal, faire retrouver par un second agent un
      fait via `memory_search` et vérifier le marquage `candidat: true`.
      Au besoin, utiliser un nouveau sujet de recette pour obtenir un fait.
- [ ] Faire écrire par un agent un handoff avec un faux jeton généré
      pour l’essai. Sa forme est un préfixe de trois lettres minuscules
      (g, h, p), un tiret bas, puis 36 caractères alphanumériques.
      Vérifier qu’aucun fait n’est produit et que le journal du daemon
      consigne le refus et sa classe. Vérifier l’absence du texte refusé
      dans le journal.
- [ ] Écrire un handoff en tant qu’admin, puis vérifier après le délai
      que le compteur du jour reste stable et qu’aucun fait n’apparaît.
- [ ] Merger un sujet de recette qui a des faits candidats. La nuit
      suivante, ouvrir la proposition de rétro du chantier 61. Vérifier
      dans `sources.pages` de la proposition (`GET /api/memory/proposals`)
      que le récit inclut les faits candidats du cycle.
- [ ] Appliquer la rétro, lancer `aid mem purge`, puis
      vérifier que les pages `<ns>/fait/<task>.*` ont disparu.
- [ ] Sur une journée de recette sans job de capture préalable, régler
      `memory.capture.maxPerDay: 1`. Faire écrire deux handoffs
      distincts par un agent et attendre le délai après chacun. Vérifier
      que le deuxième ne déclenche aucune extraction et que la ligne
      « Faits candidats » de `aid doctor` reste en avertissement à 1 sur 1.

- [ ] Recette observée et accord pour le merge
