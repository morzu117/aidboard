# Recette du chantier 47 — Avatars des pairs

Cocher après observation sur une instance de recette. Ne recopier aucune
identité ni erreur réelle dans le compte rendu. Les noms ci-dessous sont
uniquement des exemples. Q-J1 à Q-J3 sont validés par Julien (13 novembre).

## Préparer

Dans `config.yaml`, ajouter par exemple :

```yaml
avatars:
  peer-a: { initiales: "A1", couleur: bleu }
  peer-b: { couleur: rose }
```

Redémarrer le daemon puis recharger le web : les surcharges sont lues une seule
fois et gardées en mémoire, sans stockage local. Préparer les meshes `principal`
et `perso` avec des données de recette sans conséquence.

## Regarder chaque écran, en thème clair puis sombre

- [ ] Boîte : devant chaque expéditeur de DM, un disque ; le nom reste lisible.
      Le même nom garde son avatar sur `principal` et `perso`. Seule la cell
      d’A-I-D sur le mesh du DM porte l’anneau et le titre « cette cell ».
- [ ] Cells : disque devant chaque nom, anneau sur la cell locale, mention
      « toi », versions et monitor conservés. Changer de mesh : l’anneau suit
      sa cell locale.
- [ ] Board : disque devant chaque responsable ; « sans responsable » reste
      sans disque. Ouvrir la carte : même avatar dans sa fiche, devant les
      détenteurs du graphe et les porteurs d’obligations. Les noms restent écrits.
- [ ] Salles d’avis : disques devant les cells des avis, la baseline et les
      réponses du rebuttal ; dans le choix d’une salle, devant chaque cell.
      Les cases gardent leur nom et leur fonctionnement.
- [ ] Partout : `peer-a` montre « A1 » sur bleu, `peer-b` ses initiales calculées
      sur rose ; aucun autre changement de présentation. Les initiales sont
      décoratives, ignorées par le lecteur d’écran ; les noms restent annoncés.
- [ ] Sans la table `avatars`, puis avec `/api/avatars` indisponible dans les
      outils du navigateur et après rechargement : les avatars calculés restent
      visibles, les écrans utilisables, aucune alerte supplémentaire.
- [ ] Téléphone, confirmations du Mac, appareil, mode host et notifications
      système : texte habituel, aucun avatar ajouté.

Constats : __________

## Accord de Julien

- [ ] Q-J1 : surcharge dans la config seulement, sans édition à l’écran.
- [ ] Q-J2 : téléphone, confirmations, appareil et mode host en texte seul.
- [ ] Q-J3 : un même nom de cell a le même avatar dans les deux meshes.
- [ ] Recette observée et accord explicite pour le merge.
