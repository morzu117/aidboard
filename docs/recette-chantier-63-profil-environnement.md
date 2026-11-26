# Recette du chantier 63 — Profil d'environnement

## Couverture automatique

- Les tests de `aid env check` couvrent les quatre états, les codes de
  sortie, le délai de vérification, le JSON et le profil d'aidboard avec
  quatre exécutables simulés.
- Les tests de l'environnement de la cell couvrent les sondes locales,
  le cache, les noms des modèles Ollama et les droits de la route.
  Les tests de `aid doctor` couvrent l'affichage de la ligne.

## Recette réelle à cocher

Effectuer chaque contrôle sur la tour de travail (WSL) et sur le serveur, avec
un sujet de recette pour l'essai de l'agent. Cocher chaque case après vérification
sur les deux machines. Dans le relevé, consigner la forme des résultats, jamais
leurs valeurs. Omettre tout nom d'hôte, chemin personnel et jeton.

- [ ] À la racine d'aidboard, lancer `aid env check`. Vérifier les quatre
      lignes, dans l'ordre `node`, `npm`, `git`, `mise`, et le code 0.
- [ ] Lancer `aid env check --json`. Vérifier que la sortie est un objet
      avec `root` (chaîne), `ok` (booléen) et `outils` (tableau). Chaque
      entrée comporte `nom`, `requis` et `etat`, ainsi que `attendu`,
      `trouve`, `detail` et `indication` lorsque ces champs s'appliquent.
- [ ] Avec un `PATH` temporaire sans `mise`, vérifier la ligne
      `! mise — absent` et le code 0. Garder `node`, `npm` et `git`
      accessibles, par exemple via des liens dans un dossier temporaire.
- [ ] Avec un `PATH` temporaire sans `node` et les trois autres outils
      accessibles, vérifier la ligne `✗ node` avec l'état `absent` et le
      code 7. Pour lancer le CLI malgré le masquage, relever au préalable
      le chemin de l'exécutable Node et l'invoquer directement avec
      `dist/cli/aid.js env check` depuis la racine d'aidboard.
- [ ] Copier `agent.yml` dans un dossier temporaire et y déclarer
      `node: { version: ">=99" }`. Avec le `PATH` habituel, pointer
      `aid env check --root` vers ce dossier. Vérifier `hors-plage` sur
      `node` et le code 7.
- [ ] Lancer `aid doctor`. Vérifier la ligne « Environnement » et la
      mention « WSL » sur la tour.
- [ ] Interroger `GET /api/machines/local` via le port local d'administration.
      Vérifier le champ `environnement`, avec l'OS, l'architecture et les
      outils. Sur la tour, avec Ollama actif, vérifier que `modelesOllama`
      contient les noms des modèles et consigner uniquement la forme du tableau.
- [ ] Dans un sujet de recette, lancer un agent de plan ou de dev via `aid`
      avec `node` masqué dans le `PATH` de l'agent. Garder le lanceur de
      l'agent et la commande `aid` fonctionnels. Si `aid` utilise Node,
      le rendre accessible par un script de recette qui invoque le binaire
      Node par son chemin absolu, sans ajouter ce binaire au `PATH`.
      Vérifier l'arrêt à l'étape 0 et la mention de `node` dans le handoff.

- [ ] Recette observée et accord pour le merge
