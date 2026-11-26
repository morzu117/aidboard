# Recette du chantier 61 — Rétro proposée par le moteur

## Couverture automatique

- Les tests du récit couvrent l’assemblage des pages et des événements
  structurés, l’absence de pages, l’exclusion des textes techniques, le refus
  par le filtre et la borne de taille.
- Les tests de proposition couvrent les réponses du modèle, les doublons, les
  métadonnées des leçons, l’application sélective, l’annulation et le rejet.
- Les tests de la passe de nuit couvrent l’ordre des cycles, les exclusions,
  le plafond partagé et la fenêtre d’entretien. Les tests de santé vérifient
  les compteurs. Les tests de bout en bout couvrent l’application avec une
  leçon décochée et le rejet, à 390 et 1 280 px.

## Recette réelle à cocher

Utiliser une instance de recette sur la tour de travail, avec le CLI connecté
comme administrateur. Installer dans Ollama le modèle configuré dans
`memory.maintenance.model`, activer `memory.maintenance.enabled: true` et
configurer une fenêtre d’entretien qui couvre l’heure de la recette.
Dans le relevé, consigner la forme des résultats, jamais leurs valeurs.
Omettre les noms d’hôtes, les chemins personnels, les contenus de mémoire
réels et les jetons.

- [ ] Créer un sujet de recette, écrire `<ns>/plan/<slug>` et
      `<ns>/review/<slug>` en mémoire, puis merger le sujet. Utiliser des
      observations fictives et distinctes pour susciter plusieurs leçons.
      Le lendemain, ou après avoir ajusté la fenêtre pour déclencher la passe,
      vérifier qu’une proposition « Rétro de … » apparaît dans « Entretien
      de la mémoire », dans la Boîte.
- [ ] Ouvrir la carte. Vérifier le résumé des sources (pages, actions et
      reprises), le texte de la rétro et les leçons cochées par défaut.
      Si le modèle propose moins de deux leçons, utiliser un nouveau cycle
      de recette pour pouvoir en garder une et en décocher une autre.
- [ ] Décocher une leçon et cliquer sur « Appliquer ». Vérifier avec
      `aid mem get` que la rétro est écrite sous `<ns>/retro/<slug>`, que les
      leçons gardées sous `lesson/…` portent `cycle: <ns>/<slug>` et
      `liens.issu_de` vers la rétro, et que la leçon décochée est absente.
      Vérifier avec `aid mem links` sur une leçon gardée que le lien sortant
      `issu_de` cible la rétro.
- [ ] Merger un deuxième sujet avec des pages de cycle, attendre sa
      proposition et cliquer sur « Rejeter ». Vérifier que la proposition
      ne revient pas après la passe de la nuit suivante.
- [ ] Merger un sujet sans aucune page de cycle. Après la passe, vérifier
      l’absence de proposition et l’augmentation du compteur « à écrire à
      la main » dans `aid doctor`.
- [ ] Merger un sujet dont la review contient un faux jeton généré pour
      l’essai. Sa forme est un préfixe de trois lettres minuscules (g, h, p),
      suivi d’un tiret bas et de 36 caractères alphanumériques. Après la
      passe, vérifier l’absence de proposition et la présence d’un refus
      dans le journal du daemon : une ligne « rétro de … non proposée : refus:<classe> ».
      Vérifier que le texte refusé est absent du journal.
- [ ] Relever la ligne « Rétros » de `aid doctor` avant la passe, à
      l’ouverture d’une proposition, puis après les décisions et les refus.
      Vérifier que les cycles en attente alimentent les manquantes, que les
      propositions ouvertes alimentent les proposées, et que le cycle sans
      pages et le cycle refusé alimentent « à écrire à la main ». Une rétro
      appliquée ou rejetée sort des propositions ouvertes.
- [ ] Isoler l’instance des autres activités pendant le job. Démarrer une
      capture du trafic sortant, boucle locale comprise, avant la
      passe. Observer le passage du job `retro` de `running` à `done`
      dans la table `memory_jobs` de l’instance de recette. Vérifier sur
      cet intervalle que le seul trafic réseau du job correspond aux
      échanges avec Ollama.
      Consigner le type de destination, sans recopier les adresses ni
      conserver la capture.

- [ ] Recette observée et accord pour le merge
