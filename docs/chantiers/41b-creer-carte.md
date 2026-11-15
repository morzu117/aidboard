# Chantier 41 b : créer la carte d'un sujet Swairm depuis A-I-D

| Champ | Valeur |
|---|---|
| État | **Révision 0, 15 novembre 2026.** D'après la réponse du lab sur ce qui peut avancer sans le #20 (DM 98600) et le verbe `board.cards.create` de swarph-cli 0.82.0 (#1567, DM 98586). Choix de Julien du 15 novembre : le proxy seul, et le projet choisi dans une liste. **Révision 1** : la relecture du lab (DM 98624), avec deux corrections sur le verbe et quatre trous comblés dans D340. Julien a choisi de prévenir pour les obligations ouvertes, sans plus. **Révision 2** : le résumé respecte la borne de 160 caractères du contrat du PDA, et le titre passe dans les lignes signées (arrêt de Codex au 41b.2). |
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
- Ses paramètres : `mesh`, `projet`, `projetNom`, `titre`, `corps`.
  - `projet` : **l'id entier** d'un projet, tel que le renvoie `board.projects.list`. Le proxy n'accepte qu'un entier JSON positif et refuse un slug en `bad_args` (DM 98624). L'écran affiche le nom du projet, mais seul l'id circule. A-I-D n'accepte que des ids qu'il a lus dans cette liste pour ce mesh. `preparer` relit la liste et refuse un projet absent en 400.
  - `titre` : de 1 à 200 caractères, comptés **après** le retrait des espaces en tête et en fin, et sans saut de ligne. Un titre fait seulement d'espaces est refusé, comme le fait le proxy. C'est plus strict que le proxy.
  - `corps` : sa **première ligne** est exactement la ligne Swairm du sujet, au format de D285, puis éventuellement une ligne vide et du texte libre. Le tout fait 4 000 caractères au plus, comme le texte des autres écritures du 35 bis. Un corps dont la première ligne n'est pas une ligne Swairm valide est refusé en 400.
- Le nettoyage du 35 (secrets, texte libre) s'applique au titre et au corps, comme pour `carte.note`.
- **Le résumé et les lignes du téléphone.** Le résumé signé d'une demande fait 160 caractères au plus (contrat du PDA, `src/shared/confirmations.ts` et `src/shared/pda.ts`). Ce contrat ne change pas. Comme pour les trois autres écritures, le résumé est donc court et ne porte que des valeurs bornées : « Création de carte dans le projet #<id> ». Le reste vient des paramètres signés, affichés en lignes : « Titre : <titre> », « Projet : <nom du projet> (#<id>) » et « Sujet : <owner>/<dépôt>#<id> ».
- **Le nom du projet** est un paramètre signé, `projetNom`, de 1 à 100 caractères. `preparer` le relit dans la liste et refuse en 400 un nom qui ne correspond pas à l'id. Le client ne peut donc pas faire afficher au téléphone un autre nom que celui du board.

### D339. Le transport : le proxy seul

- `board.cards.create` entre dans `VERBES_PROXY`, avec un schéma d'arguments fermé : `project`, `title` et `body`. Ce sont les noms du document de schéma de swarph-cli 0.82.0 (`docs/proxy-protocol.md`, dépôt public, ligne du verbe). `priority`, `labels` et `assignee` existent aussi, mais A-I-D ne les envoie pas, ni aucun autre champ. Le proxy fixe lui-même l'acteur à sa cell.
- Le proxy fait un seul POST, sans lecture préalable. Un refus du gateway (403 : pas de droit sur le projet) arrive en `upstream_error`, avec le statut 403. L'écran dit alors « Le board a refusé cette création (403) : ta cell n'a pas le droit d'écrire dans ce projet. »
- **Une création ouvre aussi les obligations obligatoires** du menu du projet, sans détenteur : build, validate, plan-review (document de schéma, § `board.cards.create`). Le board les propose ensuite aux cells, et A-I-D ne peut pas les retirer, car le proxy n'a pas de verbe pour ça. **Choix de Julien : prévenir, sans plus.** L'aperçu le dit en une ligne : « Le board ouvrira aussi les obligations obligatoires du projet, sans détenteur. A-I-D ne pourra pas les retirer. » C'est l'opérateur qui choisit le projet et retire ces lignes au besoin.
- Sans `mesh.proxySocket`, `preparer` répond 409 `proxy_absent` (D262). Avec un proxy en lecture seule, l'écran le dit et rien n'est demandé (D283).
- **Le verbe n'existe qu'à partir de swarph-cli 0.82.0.** Un proxy plus ancien répond `verb_not_allowed`. L'écran dit : « Le proxy a refusé de créer la carte : il est trop ancien (swarph-cli 0.82.0 requis) ou en lecture seule. Rien n'a été créé. »
- **Les issues certaines et incertaines**, d'après la table des erreurs du document de schéma :
  - **certaines, sans relecture** : `bad_args`, `verb_not_allowed`, `peer_not_allowed`, `proxy_unavailable` et `connexion` (refusés avant le gateway), `upstream_unreachable` (échec de connexion avant tout envoi), `upstream_error` avec son statut (le 403 compris), et une réponse 2xx ;
  - **incertaines, donc D340** : `upstream_ambiguous` (coupure pendant ou après l'envoi), `interrompu` et `delai`.
  - Les `request_id` du proxy ne servent pas de clé d'idempotence et ne dédoublonnent pas les écritures (document de schéma) : D340 est donc la seule protection.
- Si le proxy configuré ne répond pas, c'est une erreur, avec les messages de D263. Il n'y a jamais de repli sur le CLI (règle du lab, `docs/proxy-deployment.md` de swarph-cli).
- Une réponse 2xx renvoie la carte créée telle quelle. A-I-D n'en garde que l'id, qu'il affiche. `detail` n'est jamais remonté.

### D340. Pas de doublon, ni avant, ni pendant, ni après l'envoi

Le proxy ne dédoublonne pas (D339). A-I-D s'en charge, par quatre règles.

- **Une création en vol par sujet.** Le daemon tient une table `cartes_en_vol` (nouvelle migration), avec une ligne par création : `(mesh, ligne_swairm, projet, etat, depuis)`. `etat` vaut `en-vol` ou `incertain`, et le couple `(mesh, ligne_swairm)` est unique. La ligne est insérée **avant** l'envoi. Une seconde création pour le même sujet, depuis un autre onglet ou depuis le téléphone, est refusée en 409 : « Une création de carte est déjà en cours pour ce sujet. »
- **Vérifier avant l'envoi.** Au moment de l'envoi, après le oui du téléphone, le daemon relit le board (voir la relecture plus bas). Si une carte porte déjà la ligne Swairm, rien ne part : « Une carte porte déjà ce sujet : #<n>. Rien n'a été créé. » La liste « sans carte » du 41 a peut en effet être périmée, ou une autre cell a pu créer la carte entre-temps.
- **Une issue certaine** (D339) efface la ligne de `cartes_en_vol`. **Une issue incertaine** la passe à `incertain`, et l'écran dit : « Création incertaine : la carte a peut-être été créée. A-I-D relit le board avant de te laisser recommencer. » A-I-D relit alors le board. Si une carte porte la ligne, la création est réputée faite, et la ligne est effacée. Sinon, la ligne est effacée et le bouton revient. Si la relecture échoue, la ligne reste `incertain`, et le bouton reste désactivé, avec « Relire le board ».
- **Au démarrage du daemon**, toute ligne de `cartes_en_vol` passe à `incertain` et suit la même relecture avant que le bouton revienne. Un redémarrage pendant l'envoi ne réactive donc rien.
- **La relecture est directe et complète.** Elle lit `board.cards.list` du projet choisi, **toutes étapes comprises** : une carte done ou parked qui porte la ligne compte. A-I-D filtre ensuite lui-même sur la ligne Swairm exacte (D285). Elle ne passe pas par la recherche de D286, qui pourrait ne pas montrer encore une carte toute neuve. Le point 41b.2 vérifie, dans le document de schéma, comment `board.cards.list` liste toutes les étapes. S'il ne le permet pas en une lecture, il le dit avant de coder.
- Le bouton « Créer la carte » d'un sujet reste désactivé tant qu'une ligne existe pour lui dans `cartes_en_vol`.

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
- La table `cartes_en_vol` et sa migration, le verrou par sujet, la vérification avant l'envoi, la relecture directe et la reprise au démarrage (D340).
- **Tests :** les validations de D338, une par règle, dont le titre blanc et le projet envoyé en entier ; le projet hors liste ; l'absence de proxy (409) ; le proxy en lecture seule ; `verb_not_allowed` (proxy trop ancien) ; chacun des codes du proxy, classé certain ou incertain ; la seconde création concurrente (409) ; une carte trouvée avant l'envoi ; l'envoi incertain, sa relecture qui trouve la carte puis qui ne la trouve pas, et sa relecture en échec ; un redémarrage avec une ligne en vol ; une carte done ou parked qui compte ; aucun champ envoyé hors schéma ; `detail` jamais remonté.

### 41b.3 Le web et le téléphone (D341)

- Le bouton, l'écran de création et le sélecteur de projet. L'affichage de `carte.creer` dans l'app du téléphone (`pda-v2`) : le résumé et ses lignes, sans aucun champ interne.
- **Tests :** l'écran sans proxy, avec un proxy en lecture seule, et avec un proxy ; l'aperçu impossible sans projet ; la ligne Swairm non modifiable ; l'affichage sur le téléphone ; le bouton désactivé pendant la relecture de D340.

### 41b.4 L'e2e et la fiche de recette

- Un e2e « Créer la carte » contre le faux proxy : choix du projet, aperçu, confirmation, carte créée, puis sujet relié à la lecture suivante.
- La fiche `docs/recette-chantier-41b-creer-carte.md`.

### 41b.5 La vérification réelle

Le lab la fait sur son bac à sable, contre un vrai proxy en 0.82.0, sur un projet où sa cell de test a le droit d'écrire, quand le commander l'aura accepté (DM 98600). Le lab lit d'abord le menu du projet (projet 17 proposé), pour savoir quelles obligations la carte ouvrira (DM 98624). Rien n'est installé par A-I-D.

## 6. Pièges

- Ne jamais écrire avec le jeton de la cell, même si le proxy tombe.
- Ne jamais accepter un projet qu'A-I-D n'a pas lu dans `board.projects.list` pour ce mesh.
- Ne jamais recréer une carte après un envoi incertain sans avoir relu le board, ni envoyer sans avoir vérifié qu'aucune carte ne porte déjà la ligne.
- Ne jamais envoyer un slug comme `project` : seulement l'id entier.
- Aucun nom de cell réel, de gateway ni de projet réel dans le code, les tests ou la doc.

## 7. Fini quand

- 41b.2 à 41b.4 sont mergés, avec la CI verte, la relecture du lab et le oui de Julien.
- La vérification réelle de 41b.5 est faite par le lab, ou bien elle est notée comme en attente du commander.
