# Recette du chantier 67 — Le testeur d'acceptation

## Couverture automatique

- `test/acceptation-verifier.test.ts`, `test/acceptation-preuve.test.ts`,
  `test/acceptation-couverture.test.ts` et `test/acceptation-doctor.test.ts`
  sont les tests d'acceptation des points 67.3 à 67.6. Chacun a été écrit
  par une session de testeur, depuis le plan seul, avant le code, puis
  commité seul avec le trailer `Acceptation: <point>`.
- `test/preuve-delai.test.ts` couvre le délai de dix minutes de `preuve`,
  que le testeur ne pouvait pas couvrir à l'avance.
- `test/kernel.test.ts` couvre la phase dans le noyau et le rendu de `/sync`.

## Écart au plan

Le plan prévoyait de recetter la phase sur « un vrai chantier suivant ».
Aucun chantier suivant n'est encore lancé, et en lancer un demande un oui
à part. La recette porte donc sur le chantier 67 lui-même, qui s'est servi
de la phase à partir du 67.3 (DM53), et sur un petit dépôt de démonstration.

## Recette réelle à cocher

Sur la tour, dans un clone neuf d'A-I-D sur la branche du chantier, après
`npm ci` et `npm run build`. Dans le relevé, consigner les codes de sortie
et la forme des sorties, jamais un nom d'hôte ni un chemin personnel.

- [ ] Lancer `node dist/cli/aid.js acceptation verifier --base origin/main`.
      Vérifier le code 0, et une ligne « vérifié » pour chaque point de
      67.3 à 67.6.
- [ ] Lancer `node dist/cli/aid.js acceptation preuve --base origin/main`.
      Vérifier le code 0 et une ligne « réussi » par point. Vérifier ensuite
      que `git worktree list` ne montre que le clone, et qu'aucun dossier
      `aid-preuve-worktree-` ne reste dans le dossier temporaire.
- [ ] Lancer
      `node dist/cli/aid.js acceptation couverture --base origin/main --plan docs/chantiers/67-testeur-acceptation.md`.
      Vérifier le code 0 : 67.2 non testable à l'avance avec sa raison, et
      67.3 à 67.6 couverts.
- [ ] Le dev qui touche un test. Dans un dépôt de démonstration vide :

  ```sh
  git init -q demo && cd demo && git commit -q --allow-empty -m base
  mkdir test && echo "rouge" > test/a.test.ts && git add -A
  git commit -q -m "tests" -m "Acceptation: 1.2"
  echo "vert" > test/a.test.ts && git commit -qam "dev"
  node <clone>/dist/cli/aid.js acceptation verifier --base HEAD~2
  ```

  Vérifier le code 1, et une faute « fichier modifié par le dev » qui donne
  le sha du commit « dev » et `test/a.test.ts`.
- [ ] Le testeur qui touche le code. Dans le même dépôt, ajouter un commit
      marqué `Acceptation: 1.3` qui crée `src/b.ts`. Relancer `verifier`
      avec `--base HEAD~3`, et vérifier une faute « fichier hors des chemins
      d'acceptation » pour `src/b.ts`.
- [ ] `aid doctor` dans un projet qui déclare la phase sans
      `acceptation.lancer` : vérifier l'avertissement, et que le code de
      sortie ne change pas pour lui seul.

## Mesure du chantier 67

Rendue par `aid acceptation couverture` sur le plan, à la fin du 67.6 :
cinq points, quatre couverts (67.3 à 67.6), un non testable à l'avance
(67.2, écrit avant que le testeur existe), aucun manquant. La part couverte
parmi les points testables est de 1. Sur les quatre points couverts, le
testeur a laissé un critère hors de portée (le délai de dix minutes du
67.4), couvert ensuite par un test du dev.
