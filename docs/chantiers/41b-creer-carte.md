# Chantier 41 b : créer la carte d'un sujet Swairm depuis A-I-D

| Champ | Valeur |
|---|---|
| État | **Révision 0, 15 novembre 2026.** D'après la réponse du lab sur ce qui peut avancer sans le #20 (DM 98600) et le verbe `board.cards.create` de swarph-cli 0.82.0 (#1567, DM 98586). Choix de Julien du 15 novembre : le proxy seul, et le projet choisi dans une liste. |
| Emplacement final | `docs/chantiers/41b-creer-carte.md` sur `main` |
| Base | `main`. |
| Organisation | Comme au 41 a. La cell de gestion de Julien gère le chantier. Codex CLI écrit le code et les tests de chaque point. La cell de gestion relit, lance le gate et `gate:e2e`, commite et ouvre la PR. |
| Validation | Le chantier ouvre une écriture nouvelle sur le mesh : **le lab relit le code**. La vérification réelle a lieu sur le bac à sable du lab, quand le commander l'aura accepté (DM 98600). Merge : CI verte, relecture du lab, puis oui de Julien. |
| Bloqué par | Rien pour 41b.2 à 41b.4. 41b.5, la vérification réelle, attend un proxy sur le bac à sable du lab et un jeton neuf pour sa cell de test. La clôture par un drone attend le #20 : elle reste hors de ce chantier. |

## 1. Pourquoi

Le 41 a liste les « Sujets Swairm sans carte ». Pour chacun, il propose seulement de copier la ligne `Swairm: <owner>/<dépôt>#<id>` ou un modèle de commande `swarph board cards add`, qu'A-I-D n'exécute jamais (D287). Le 41 b ajoute un bouton « Créer la carte ». La carte part par le proxy, sous confirmation du téléphone, comme les autres écritures du 35 bis. Elle porte la ligne Swairm : le lien de D285 se fait donc tout seul à la lecture suivante.

## 2. État actuel

- Les écritures d'A-I-D passent **seulement** par le proxy (35 bis, D262) : une écriture n'est possible que si `mesh.proxySocket` est réglé et que le proxy n'est pas en lecture seule (`src/daemon/mesh/registre.ts`, D283). Tout repli sur le CLI avec jeton est exclu (35 bis, §3).
- L'action confirmée `mesh.ecrire` porte trois actions : `carte.note`, `dm.envoyer` et `canal.poster`. Elles sont de classe `toujours` (`src/shared/confirmations.ts`). Le parcours est celui du 35 bis : aperçu, « Envoyer », demande au téléphone, puis envoi par le proxy.
- `VERBES_PROXY` (`src/daemon/mesh/proxy.ts`) ne contient pas `board.cards.create`. Le verbe existe dans swarph-cli 0.82.0. Ses bornes, d'après le lab (DM 98586) : titre de 1 à 1 000 caractères, corps jusqu'à 200 000, priorité entière de 0 à 13, et de 1 à 12 labels.
- `board.projects.list` est déjà un verbe de lecture du proxy, et `BoardReader` lit les projets.
- Aujourd'hui, aucune machine de Julien n'a de proxy. Sur le Mac, le proxy attend le #1557, et les écritures y restent coupées (#1539 (a)).

## 3. Cible et hors-périmètre

**Cible :** dans « Sujets Swairm sans carte », un bouton « Créer la carte » par sujet. Il ouvre l'écran d'écriture, prérempli, avec un choix de projet. La carte part par `board.cards.create`, sous confirmation du téléphone. Sans proxy, ou avec un proxy en lecture seule, le bouton est désactivé, et les deux boutons « Copier » restent.

**Hors périmètre :**
- tout envoi par le CLI avec le jeton de la cell (choix de Julien, 15 novembre) ;
- la priorité, l'échéance et les labels : le gateway met ses valeurs par défaut ;
- la clôture d'une carte par un drone, le trailer `Swarph-Card` et la règle « rien sans carte » dans Swairm, qui attendent le #20 ;
- l'installation d'un proxy, où que ce soit.

## 4. Décisions

### D338. Une quatrième action d'écriture, `carte.creer`

- `mesh.ecrire` gagne l'action `carte.creer`. Elle reste de classe `toujours`, comme les trois autres.
- Ses paramètres : `mesh`, `projet`, `titre`, `corps`.
  - `projet` : un id ou un slug de projet, tel que le renvoie `board.projects.list`. A-I-D n'accepte que des valeurs qu'il a lues dans cette liste pour ce mesh. `preparer` relit la liste et refuse un projet absent en 400.
  - `titre` : de 1 à 200 caractères après nettoyage, sans saut de ligne. C'est plus strict que le proxy.
  - `corps` : sa **première ligne** est exactement la ligne Swairm du sujet, au format de D285, puis éventuellement une ligne vide et du texte libre. Le tout fait 4 000 caractères au plus, comme le texte des autres écritures du 35 bis. Un corps dont la première ligne n'est pas une ligne Swairm valide est refusé en 400.
- Le nettoyage du 35 (secrets, texte libre) s'applique au titre et au corps, comme pour `carte.note`.
- Le résumé affiché sur le téléphone : « Créer la carte « <titre> » dans <projet> », suivi des lignes « Projet : <projet> » et « Sujet : <owner>/<dépôt>#<id> ».

### D339. Le transport : le proxy seul

- `board.cards.create` entre dans `VERBES_PROXY`, avec un schéma d'arguments fermé : le projet, le titre et le corps, **sous les noms exacts** du document de schéma de swarph-cli 0.82.0 (`docs/proxy-protocol.md`, dépôt public). Aucun autre champ n'est envoyé.
- Sans `mesh.proxySocket`, `preparer` répond 409 `proxy_absent` (D262). Avec un proxy en lecture seule, l'écran le dit et rien n'est demandé (D283).
- Si le proxy configuré ne répond pas, c'est une erreur, avec les messages de D263. Il n'y a jamais de repli sur le CLI (règle du lab, `docs/proxy-deployment.md` de swarph-cli).
- La réponse est lue au format du document de schéma : l'id de la carte créée est affiché, et seulement lui. `detail` n'est jamais remonté.

### D340. L'envoi incertain ne crée pas de doublon

- Si le résultat est `upstream_ambiguous`, `interrompu` ou `delai`, la carte a peut-être été créée. L'écran affiche « Création incertaine : la carte a peut-être été créée. A-I-D relit le board avant de te laisser recommencer. »
- A-I-D relit alors le board, par la recherche de D286 sur la ligne Swairm. Si une carte porte la ligne, le sujet quitte « sans carte » et la création est réputée faite. Sinon, le bouton « Créer la carte » revient.
- Tant que cette relecture n'a pas répondu, le bouton « Créer la carte » de ce sujet reste désactivé.

### D341. L'écran

- **Le bouton.** Dans « Sujets Swairm sans carte » (D287), chaque sujet gagne « Créer la carte », à côté des deux « Copier ». Sans proxy, il est désactivé et porte le texte de D262.
- **L'écran de création** réutilise l'écran d'écriture du 35 (`EcrireAuMesh`), avec :
  - un sélecteur « Projet », rempli par `board.projects.list` du mesh, **sans valeur par défaut**, de sorte que l'aperçu reste impossible tant qu'aucun projet n'est choisi ;
  - le titre prérempli avec le titre du sujet Swairm, modifiable ;
  - la ligne Swairm en tête du corps, non modifiable, suivie d'une zone de texte libre facultative ;
  - le bandeau du mesh (46.8).
- La suite est celle du 35 bis : aperçu, « Envoyer », demande au téléphone, résultat.
- Après une création réussie, A-I-D relit le board : le sujet passe dans les cartes reliées.
- Tout ce qui vient de Swairm ou du board s'affiche en texte brut (invariant 9).

## 5. Points

### 41b.1 Le plan

Ce document, et sa ligne dans `docs/chantiers/README.md`.

### 41b.2 Le daemon : l'action et le verbe (D338, D339, D340)

- `carte.creer` dans `src/shared/confirmations.ts` (validation, résumé, classe) et dans le parcours d'écriture du 35 bis (`preparer`, l'envoi, le résultat).
- `board.cards.create` dans `src/daemon/mesh/proxy.ts`, avec son schéma d'arguments. Le faux proxy de test (`test/fixtures/faux-proxy.ts`) apprend le verbe.
- **Tests :** les validations de D338, une par règle ; le projet hors liste ; l'absence de proxy (409) ; le proxy en lecture seule ; chacun des codes du proxy ; l'envoi incertain et sa relecture (D340) ; aucun champ envoyé hors schéma ; `detail` jamais remonté.

### 41b.3 Le web et le téléphone (D341)

- Le bouton, l'écran de création et le sélecteur de projet. L'affichage de `carte.creer` dans l'app du téléphone (`pda-v2`) : le résumé et ses lignes, sans aucun champ interne.
- **Tests :** l'écran sans proxy, avec un proxy en lecture seule, et avec un proxy ; l'aperçu impossible sans projet ; la ligne Swairm non modifiable ; l'affichage sur le téléphone ; le bouton désactivé pendant la relecture de D340.

### 41b.4 L'e2e et la fiche de recette

- Un e2e « Créer la carte » contre le faux proxy : choix du projet, aperçu, confirmation, carte créée, puis sujet relié à la lecture suivante.
- La fiche `docs/recette-chantier-41b-creer-carte.md`.

### 41b.5 La vérification réelle

Le lab la fait sur son bac à sable, contre un vrai proxy en 0.82.0, sur un projet où sa cell de test a le droit d'écrire, quand le commander l'aura accepté (DM 98600). Rien n'est installé par A-I-D.

## 6. Pièges

- Ne jamais écrire avec le jeton de la cell, même si le proxy tombe.
- Ne jamais accepter un projet qu'A-I-D n'a pas lu dans `board.projects.list` pour ce mesh.
- Ne jamais recréer une carte après un envoi incertain sans avoir relu le board.
- Aucun nom de cell réel, de gateway ni de projet réel dans le code, les tests ou la doc.

## 7. Fini quand

- 41b.2 à 41b.4 sont mergés, avec la CI verte, la relecture du lab et le oui de Julien.
- La vérification réelle de 41b.5 est faite par le lab, ou bien elle est notée comme en attente du commander.
