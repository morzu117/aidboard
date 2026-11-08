# Recette de la chronologie (chantier 38)

Pour Julien, sur son board réel, avec la version du chantier 38 ouverte dans A-I-D.
Les noms `peer-a` et `peer-b` ci-dessous sont des exemples.

## Vérifications

- [ ] Ouvrir le Board, puis une carte qui a des obligations fermées et des messages.
- [ ] Repérer le bloc « Chronologie ». Les cases « Étapes », « Obligations » et « Fil »
      sont cochées. Les entrées vont du plus récent au plus ancien.
- [ ] Comparer les messages de la chronologie au bloc « Fil » : même auteur, même date,
      même début de texte. Au-delà de 140 caractères, le texte finit par « … ».
- [ ] Comparer les événements au bloc « Obligations » : étape et résultat de fermeture
      concordent. Par exemple : « Obligation build ouverte pour peer-b », « prise »,
      « modifiée », « fermée : PASS », selon les événements présents.
- [ ] Décocher « Étapes » : seules les étapes disparaissent. Recocher.
- [ ] Décocher « Obligations » : seuls leurs événements disparaissent. Recocher.
- [ ] Décocher « Fil » : seuls les messages de la chronologie disparaissent ; le bloc
      « Fil » reste lisible. Recocher.
- [ ] Si le pied signale des lignes antérieures, vérifier que leur nombre est affiché,
      sans leurs événements. Si le fil est limité, vérifier l’avertissement de chronologie
      potentiellement incomplète. Sinon, noter « non applicable » pour chaque limite.
- [ ] Sur une carte dont les obligations contiennent un texte d’acceptation ou une preuve
      (`evidence`), vérifier qu’aucun de ces textes n’apparaît dans la chronologie.
      Vérifier aussi les blocs Graphe et Obligations. Si nécessaire, choisir une autre
      carte pour cette vérification ; sans donnée correspondante, noter « non vérifié ».

## Ce qu’il faut renvoyer

Renvoyer la version testée et le résultat de chaque case : OK, échec, non applicable ou
non vérifié. Pour un échec, décrire seulement le comportement observé et celui attendu.
Ne joindre aucun contenu de carte, texte d’acceptation, preuve, nom réel ou capture.
