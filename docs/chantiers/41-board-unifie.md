# Chantier 41 a : un seul board (les sujets Swairm reliés à leurs cartes)

| Champ | Valeur |
|---|---|
| État | **Révision 0, 10 novembre 2026.** Spec rév. 1 (morzu-vps). Choix de Julien : oui aux recos Q1 à Q4. Réponses du lab à L1–L3 (DM 95591). |
| Emplacement final | `docs/chantiers/41-board-unifie.md` sur `main` |
| Base | `main` (07b2fc1, v0.5.0) |
| Organisation | Comme au 44. morzu-vps gère le chantier ; Codex CLI écrit le code et les tests de chaque point ; morzu-vps relit, lance le gate, commite et ouvre la PR. |
| Validation | Le 41 a n'ouvre aucune écriture nouvelle : il lit le board et Swairm, et ses notes passent par l'envoi du 35 bis, sous confirmation. Merge : CI verte, puis oui de Julien. Le lab est informé, mais il ne valide pas ce chantier. |
| Bloqué par | Rien pour le 41 a. Le 41 b attend l'isolation des drones (#20) et un verbe de création de carte (L1). |

## 1. Pourquoi

Le programme (§5, phase 5) veut **un seul board**. Les sujets de la ruche Swairm vivent aujourd'hui dans le board SQLite de Swairm, et le travail des cellules dans le board swarph : Julien a donc deux tableaux à suivre. Le 41 a relie chaque sujet Swairm à une carte du board swarph, montre l'état du sujet sur sa carte, et rend visibles les sujets qui n'ont pas de carte.

## 2. État actuel

- **Swairm** : `swairm status --json` (format `swairm-status/1`, contrat `docs/cli-swairm.md` du dépôt `morzu117/swairm`) liste, par projet `owner/dépôt`, les `sujets` (`id`, `titre`, `etat`, `colonne`, `en_pause`, `priorite`, `pas`, `maj`), les `vols` et les `erreurs`. Les valeurs de `etat` sont celles de `SubjectState` : `planned`, `plan_validated`, `in_progress`, `integrated`, `delivering`, `queued`, `merged`, `parked` et `abandoned`. D'autres peuvent apparaître. A-I-D appelle déjà le CLI `swairm` (`swairm.bin`) pour la cell Swairm (14) et pour `ask` (39).
- **Le board swarph** : `BoardReader` (`src/daemon/mesh/board.ts`) lit les projets, les cartes, la fiche, le fil, les obligations et le graphe. Il passe par le CLI, ou par le proxy quand `mesh.proxySocket` est réglé (44).
- **La recherche (L3)** : `board cards list --search TEXT` (CLI), ou `board.cards.list {q}` (proxy, 1000 caractères au plus), cherche une sous-chaîne dans le titre ou le corps, sur **tous les projets**, en une seule réponse, sans pagination. La réponse est `{cards, due, searched}`, et chaque carte contient `body`. La plus grosse recherche mesurée : 682 cartes examinées. La casse n'est repliée que pour l'ASCII.

## 3. Cible et hors-périmètre

**Cible :**
- Dans l'onglet Board, chaque carte reliée à un sujet Swairm porte l'état du sujet.
- Une section « Sujets Swairm sans carte » liste ceux qui n'en ont pas.
- Quand un sujet franchit une étape, A-I-D propose une note sur sa carte, qui part sous confirmation du téléphone.

**Hors périmètre :**
- La création de carte par A-I-D, la clôture par un drone, et la règle « rien sans carte » appliquée dans Swairm. C'est le 41 b.
- Les trailers `Swairm-Drone` et `Swarph-Card`. Ils se posent dans Swairm, par une PR sur `morzu117/swairm` gérée à part. Leur lecture dans la chronologie (38) viendra en 41.6, après cette PR.
- Le 42.

## 4. Décisions

### D285. Le lien est une ligne exacte sur la carte

- Une carte est reliée au sujet `<owner>/<dépôt>#<id>` si son `body` contient une ligne qui est **exactement** `Swairm: <owner>/<dépôt>#<id>`. On la lit ligne par ligne, avec une expression ancrée au début et à la fin de la ligne :
  - `owner` et `dépôt` sont faits de `[A-Za-z0-9._-]`, 1 à 100 caractères chacun ;
  - l'`id` est fait de `[A-Za-z0-9._/-]`, 1 à 200 caractères ;
  - aucune espace en trop, et aucune autre forme n'est acceptée.
- La recherche gateway (`Swairm: `) n'est qu'un préfiltre : c'est une sous-chaîne, et `#12` trouverait aussi `#123` (L3). Seule la ligne exacte vaut lien.
- Une carte peut porter plusieurs lignes, donc plusieurs sujets. Un sujet relié à **deux cartes ou plus** est en conflit : A-I-D n'en choisit aucune, et affiche « Lien en double : cartes #a, #b. »
- `owner/dépôt` se compare **tel quel**, à la casse près, comme Swairm l'écrit (L3).
- A-I-D n'écrit jamais ce lien. C'est Julien qui crée la carte, ou qui ajoute la ligne à une carte existante (Q1).

### D286. Deux lectures, un seul assemblage

- **Les liens** : une seule lecture, `board.cards.list` avec `q = "Swairm: "`, **sans projet**, par le `BoardReader` (CLI `--search`, ou proxy `{q}`). Elle a le même cache de 5 s et la même fusion des demandes que le reste. Le lecteur proxy du 44 gagne l'argument `q`.
- **Les sujets** : `swairm status --json`, par un lecteur `SwairmStatut`, avec un cache de 5 s, un délai de 10 s et un parseur strict qui ignore les champs inconnus. Sans `swairm.bin`, ou si le binaire est absent, l'état est « Swairm non configuré », sans erreur.
- **L'assemblage** se fait dans le daemon. Il produit, par sujet, `{projet, id, titre, etat, colonne, en_pause, pas, maj, vol, carte: number | null, conflit: number[]}`, et la liste des cartes reliées. Il est servi par une route de lecture, `GET /api/swairm/board`, réservée à l'admin. En mode host, il n'est pas servi (D178).
- Une lecture en échec n'efface pas l'autre : l'écran montre ce qui a pu être lu, avec l'erreur de l'autre.

### D287. La vue

- **Sur une carte reliée**, dans la liste et dans la fiche : une pastille « Swairm · <etat> », et, dans la fiche, le projet, l'id, la colonne, les pas, « en pause », le vol en cours et la date `maj`.
  - Les libellés de l'état : `planned` « planifié », `plan_validated` « plan validé », `in_progress` « en cours », `integrated` « intégré », `delivering` « en livraison », `queued` « en file », `merged` « mergé », `parked` « garé », `abandoned` « abandonné ».
  - Un état inconnu s'affiche tel quel.
- **« Sujets Swairm sans carte »** : une section de l'onglet Board, repliée par défaut, avec leur nombre. Chaque sujet a deux boutons « Copier » :
  - « Copier la ligne » copie `Swairm: <owner>/<dépôt>#<id>` ;
  - « Copier la commande » copie un modèle `swarph board cards create --project <PROJET> --title "<titre>" --body "Swairm: <owner>/<dépôt>#<id>"`, où `<PROJET>` reste à remplir. A-I-D n'exécute jamais cette commande.
- Les sujets `merged` et `abandoned` sans carte ne sont pas listés : la règle « rien sans carte » vaut pour le travail vivant. Un compteur dit combien il y en a.
- Tout ce qui vient de Swairm ou des cartes s'affiche en texte brut (invariant 9).

### D288. Les notes d'étape, proposées

- A-I-D garde le dernier `etat` vu de chaque sujet relié, dans une table `swairm_etats` (migration 027) : `(projet, sujet, etat, vu_a)`. Ainsi, un redémarrage ne repropose rien.
- Quand un sujet relié passe à `plan_validated`, `merged` ou `abandoned`, A-I-D crée une **proposition**, une entrée de la Boîte « Proposer une note sur la carte #n ». Elle ouvre l'écran d'écriture du 35, prérempli :
  - action `carte.note`, carte `n` ;
  - texte « Swairm : <titre> — <libellé de l'état>. » ;
  - kind `fyi`.
- La note ne part que par l'envoi du 35 bis, **sous confirmation du téléphone** (35b.6). Rien ne part sans geste. La proposition se ferme à l'envoi, ou par « Ignorer ».
- **Au premier relevé d'un sujet**, quand aucun état n'est encore connu, A-I-D enregistre l'état sans rien proposer.

## 5. Points

### 41.1 Le plan

Ce document, et une ligne dans `README.md`.

### 41.2 Les lectures et l'assemblage (D285, D286)

Le parseur des lignes `Swairm:` et ses tests de frontière. La recherche `q` dans `BoardReader`, par le CLI et par le proxy. Le lecteur `SwairmStatut`. L'assemblage, les conflits, et la route `GET /api/swairm/board`.
- *Révision 41.2.* Plusieurs vols sur un même sujet : le premier est retenu. Reprise r1 : `searched` est un entier (le nombre de cartes examinées, mesuré sur le vrai CLI : 682), pas la chaîne cherchée ; le parseur a été vérifié sur une vraie réponse du CLI, et toutes les cartes passent. 3 lignes existantes modifiées. Vrai proxy 25/25. Gate 2996 (échecs connus hors CI).

### 41.3 La vue (D287)

La pastille et le bloc Swairm de la fiche ; la section « Sujets Swairm sans carte » et les deux « Copier ».
- *Révision 41.3.* La commande copiée cite le titre et le corps entre quotes simples POSIX (apostrophe : `'"'"'`), plus sûr que les guillemets doubles de D287 : `$(…)` et les backquotes d'un titre restent du texte. 0 ligne existante modifiée, 22 tests ajoutés. E2E Board 8/8. Gate 3016 (échecs connus hors CI ; `self-update` instable dans le gate complet, 11/11 isolé avec et sans le diff).

### 41.4 Les notes proposées (D288)

La migration 027, la détection des transitions, les propositions dans la Boîte, et l'ouverture de l'écriture préremplie.
- *Révision 41.4.* La proposition est une table `swairm_propositions` (une seule ouverte par projet, sujet et état). L'envoi garde la route du 35 et sa porte ; il porte seulement l'id de la proposition, refusé (400) si elle est fermée ou si la carte diffère, et la proposition se ferme au succès confirmé au téléphone. La détection suit la lecture de l'assemblage, sans minuterie nouvelle. 8 lignes existantes modifiées (3 `user_version` 26 → 27). 17 tests ajoutés. Vrai proxy 25/25, e2e Boîte 5/5, gate 3034 (échecs connus hors CI).

### 41.5 L'e2e et la fiche de recette

Un e2e Board avec un faux `swairm` et un faux `swarph`, et la fiche `docs/recette-chantier-41-board-unifie.md`.
- *Révision 41.5.* Aucun défaut révélé par l'e2e. E2e nouveau 1/1, Board 8/8, Boîte 5/5 ; gate 3034 (échecs connus hors CI).

## 6. Pièges

- La recherche est une sous-chaîne : sans l'expression ancrée, `#12` relierait `#123`.
- La casse des caractères non ASCII n'est pas repliée par le gateway : ne normalise pas `owner/dépôt`.
- `swairm status` lit des fichiers SQLite qu'une ruche active est en train d'écrire. Un board illisible est rangé dans `erreurs`, et le code de sortie reste 0 : il faut lire `erreurs`, pas seulement le code.
- Ne repropose pas une note après un redémarrage (D288).

## 7. Fini quand

- Un sujet relié montre son état sur sa carte. Un sujet sans carte apparaît dans la section, avec ses deux « Copier ». Un lien en double est signalé, et aucune carte n'est choisie.
- Un passage à `plan_validated`, `merged` ou `abandoned` crée une seule proposition, qui part seulement après confirmation du téléphone.
- Le gate est vert, l'e2e aussi, et la fiche de recette est écrite.
