# Chantier 49 : des noms neutres dans le dépôt

| Champ | Valeur |
|---|---|
| État | **Révision 0, 13 novembre 2026.** Julien a choisi ce chantier après le 48. |
| Emplacement final | `docs/chantiers/49-noms-neutres.md` sur `main` |
| Base | `main`, après le merge du 48 (#160). |
| Organisation | La cell de gestion de Julien gère le chantier. Un agent Codex CLI fait les remplacements sur un brief tiré de ce plan. La cell de gestion relit le diff, lance le gate, commite et ouvre la PR. |
| Validation | Le chantier ne change aucun comportement : le lab ne le relit pas. Julien donne son oui pour le merge, CI verte. |

## 1. Pourquoi

Le dépôt est public. Depuis le chantier 12, des plans, des fiches de recette, des tests, des fixtures et un commentaire de config citent les vrais noms de deux cells de Julien, celui de la cell du lab, et un nom d'hôte du gateway. Les chantiers récents n'utilisent que des noms d'exemple. Ce chantier aligne les anciens fichiers.

## 2. Décisions

### D325. Les noms de remplacement

| Ce qui est remplacé | Remplaçant |
|---|---|
| La cell d'A-I-D sur le Mac de Julien | `cell-aid` |
| La cell de gestion de Julien | `cell-gestion` |
| La cell du lab | `cell-lab` dans le code et les tests ; « la cell du lab » dans la prose quand c'est plus naturel |
| Le nom d'hôte du gateway dans les exemples | `gateway` (par exemple `http://gateway.example.ts.net:8788`) |

- Ces noms ne collisionnent avec aucun nom existant (`principal`, `perso`, `peer-a`, `peer-b`), même dans un fichier qui les utilise tous.
- Un nom de fichier dérivé d'un nom de cell suit le même remplacement (par exemple `<cell>.yaml`).
- Le remplacement est mécanique : aucune attente de test ne change de sens, et aucun comportement ne change.

### D326. Ce qui ne change pas

- L'historique git. Les anciens commits gardent les anciens noms ; les réécrire serait une décision à part, de Julien.
- Les noms d'exemple déjà neutres, les domaines `example`, `exemple` et `aid-e2e.ts.net`.
- Le propriétaire du dépôt dans les URL GitHub.

## 3. Point

### 49.1 Les remplacements

- Tous les fichiers suivis du dépôt, hors `package-lock.json`.
- Un test de garde, `test/noms-neutres.test.ts`, lit les fichiers suivis (`git ls-files`) et échoue si l'un d'eux contient un des anciens noms. Les anciens noms n'y apparaissent pas en clair : le test compare des empreintes SHA-256 de chaque mot du fichier aux empreintes des anciens noms.
- **Tests :**
  - le gate entier, sans attente modifiée autrement que par le remplacement ;
  - le test de garde, et un cas qui montre qu'il échoue sur un ancien nom.

## 4. Pièges

- Un remplacement aveugle peut toucher un nom plus long qui contient l'ancien : remplacer des mots entiers.
- Une fixture shell, un message d'erreur attendu et sa copie dans un test doivent changer ensemble.
- Ce plan, les briefs et les messages de commit ne citent jamais les anciens noms.

## 5. Fini quand

- Le point 49.1 est commité, le gate est vert et la CI de la PR est verte.
- Julien a donné son oui pour le merge.
