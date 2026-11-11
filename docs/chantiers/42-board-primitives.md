# Chantier 42 : le board d'A-I-D sur les primitives swarph (les sujets reliés à leurs cartes)

| Champ | Valeur |
|---|---|
| État | **Révision 0, 11 novembre 2026.** Spec rév. 0 (morzu-vps). Choix de Julien : oui aux recos Q1 à Q4. Questions au lab L4 à L7 (DM 96343) en attente : elles conditionnent D293 et 42.5. |
| Emplacement final | `docs/chantiers/42-board-primitives.md` sur `main` |
| Base | `main` (4fec800) |
| Organisation | Comme au 41. morzu-vps gère le chantier ; Codex CLI écrit le code et les tests de chaque point ; morzu-vps relit, lance le gate, commite et ouvre la PR. |
| Validation | 42.2 à 42.4 n'écrivent rien sur le mesh. 42.5 ajoute une écriture, `carte.deplacer`, et le lab valide le chantier avant le merge (L7). Merge : CI verte, validation du lab, puis oui de Julien. |
| Bloqué par | 42.5 attend les réponses du lab (L4 à L7). |

## 1. Pourquoi

Le programme (§5, phase 5, bloc 21) veut un seul board, piloté dans A-I-D, sur les primitives swarph. Depuis le 41 a, les sujets Swairm sont reliés à leurs cartes. Les sujets d'A-I-D, eux (un worktree, une branche, des agents), vivent encore à part, dans la base locale. Le 42 les relie aux cartes, comme au 41 a. La carte devient la source de vérité de l'avancement (invariant 3), et le sujet garde ce qui est local : le worktree, les agents et le terminal.

## 2. État actuel

- **Les sujets** : `Topic` (`src/shared/model.ts`) porte `workspaceId`, `slug` (unique par workspace, migration 001), `title`, `type`, `branch`, `state` (`draft`, `active`, `review`, `merged`, `archived`), `phase` (`plan`, `dev`, `review`, `triage`, `retro`), `prNumber` et `prUrl`. Un `Workspace` a un `name`, une `root` et un `remote` (le nom du remote, par exemple `origin`, ou `null`).
- **Le board** : la lecture du 24, la recherche `q` et l'assemblage du 41 a (`src/daemon/swairm/board.ts`), qui servent de modèle.
- **Le déplacement d'une carte**, dans le proxy de swarph-cli 0.75.0 : `board.cards.move {id, stage, expect_stage, expect_stage_version}`. Les étapes admises sont `proposed`, `idea`, `spec`, `plan`, `build`, `review`, `ready`, `done` et `parked`. Le proxy refuse `done`, et il refuse aussi une carte sans `stage_version`.

## 3. Cible et hors-périmètre

**Cible :**
- Une carte reliée à un sujet d'A-I-D montre ce sujet (état, phase, agents, PR), avec un lien pour l'ouvrir.
- L'Accueil garde la liste des sujets, et gagne une section « Sujets sans carte ».
- On peut créer un sujet depuis la fiche d'une carte.
- Un changement de phase propose un déplacement de la carte, sous confirmation du téléphone.

**Hors périmètre :**
- La création de carte par A-I-D (#1567, après #20).
- Le déplacement vers `done`.
- Le 41 b.
- Plusieurs cells dans A-I-D (bloc 11).

## 4. Décisions

### D290. Le lien est une ligne exacte sur la carte (Q1)

- Une carte est reliée au sujet `<owner>/<dépôt>#<slug>` si son `body` contient une ligne qui est **exactement** `AID: <owner>/<dépôt>#<slug>`, lue comme en D285 : ligne par ligne, avec une expression ancrée, et `\r` final toléré.
  - `owner` et `dépôt` ont la même forme qu'en D285 ;
  - le `slug` suit la forme des slugs d'A-I-D (`src/shared/slug.ts`), 1 à 100 caractères.
- `<owner>/<dépôt>` vient de l'URL du remote du workspace (`git remote get-url <remote>`), pour une URL GitHub `https`, `ssh` ou `git@`. Un workspace sans remote, ou dont l'URL ne donne pas `owner/dépôt`, n'a pas de lien possible : l'écran le dit, et ne propose pas de ligne.
- La recherche gateway `q = "AID: "` n'est qu'un préfiltre. Les conflits se traitent comme en D285 : un sujet relié à deux cartes ou plus n'est relié à aucune.
- A-I-D n'écrit jamais le lien. Il propose la ligne à copier.
- Un lien vers un sujet absent de cette machine s'affiche « Sujet d'A-I-D absent de cette machine », sans erreur.

### D291. La vue (Q2)

- **Sur une carte reliée**, dans la liste : une pastille « A-I-D · <état> ». Dans la fiche, un bloc A-I-D : le workspace, la branche, la phase, l'état des agents (en marche, en attente, terminé), la PR (`prNumber`, avec un lien `https://github.com/` seulement), et un bouton « Ouvrir le sujet ».
- **L'Accueil** reste l'entrée des sujets. Il gagne une section « Sujets sans carte », repliée par défaut, avec leur nombre. Elle liste les sujets `draft`, `active` et `review` qui n'ont pas de carte, chacun avec « Copier la ligne ». Les sujets `merged` et `archived` n'y sont pas, et un compteur dit combien il y en a.
- L'assemblage est fait par le daemon, sur le modèle de D286, et servi par `GET /api/aid/board`, réservé à l'admin et absent en mode host (D178). Il est relu au même rythme que l'assemblage Swairm du 41 a.
- Tout s'affiche en texte brut (invariant 9).

### D292. Créer un sujet depuis une carte (Q4)

- Un bouton « Nouveau sujet » sur la fiche d'une carte **sans lien A-I-D**. Il est réservé à l'admin, et absent en mode host.
- Il ouvre l'écran « Nouveau sujet » existant, avec le titre prérempli par celui de la carte (en texte brut, borné à la longueur permise) et le numéro de carte en mémoire.
- Une fois le sujet créé, A-I-D montre la ligne `AID: …` à copier sur la carte. Aucune écriture sur le gateway.

### D293. Le déplacement proposé (Q3), à compléter après L4 à L7

- Une nouvelle action d'écriture, `carte.deplacer {carte, etape, attendu: {stage, stageVersion}}`. Elle passe par `board.cards.move` avec `expect_stage` et `expect_stage_version`, par la porte du 35 bis, **toujours sous confirmation du téléphone** (35b.6, classe « toujours »). `done` est refusé par A-I-D avant même le proxy.
- Les transitions proposées, par défaut, à vérifier avec L4 :
  - un sujet qui passe en phase `plan` propose `plan` ;
  - en phase `dev`, `build` ;
  - en phase `review`, ou à l'ouverture de sa PR, `review` ;
  - un sujet `merged` propose `ready`.
  Rien n'est proposé si la carte est déjà à cette étape, ou plus loin selon l'ordre de L4.
- Une proposition dans la Boîte, « Déplacer la carte #n vers <étape> », sur le modèle de D288 : une seule par (carte, étape), aucune au premier relevé, aucune après un redémarrage. L'aperçu dit l'étape actuelle, la cible, et les effets de bord connus (L5).

## 5. Points

### 42.1 Le plan

Ce document, et une ligne dans `README.md`.

### 42.2 Le lien et l'assemblage (D290, D291)

Le parseur `AID:`, l'identité `owner/dépôt` d'un workspace, la recherche `q = "AID: "`, l'assemblage, les conflits, et la route `GET /api/aid/board`.

### 42.3 La vue (D291)

La pastille et le bloc A-I-D de la fiche de la carte, et la section « Sujets sans carte » de l'Accueil.

### 42.4 Créer un sujet depuis une carte (D292)

### 42.5 Le déplacement proposé (D293), après le lab

### 42.6 L'e2e et la fiche de recette

## 6. Pièges

- La recherche est une sous-chaîne (L3) : sans l'expression ancrée, `#a` relierait `#ab`.
- L'URL du remote peut contenir des identifiants (`https://user:token@…`). Ne la garde jamais, ne la journalise jamais, et ne l'affiche jamais : n'en tire que `owner/dépôt`.
- Le titre d'une carte vient du gateway : c'est du texte brut, borné, jamais du HTML.

## 7. Fini quand

- Un sujet relié se voit sur sa carte, et s'ouvre depuis elle. Un sujet sans carte apparaît dans l'Accueil, avec sa ligne à copier.
- Un sujet se crée depuis une carte, sans écriture sur le gateway.
- Un changement de phase crée une seule proposition de déplacement, qui part seulement après confirmation du téléphone, et jamais vers `done`.
- Le gate est vert, l'e2e aussi, la fiche de recette est écrite, et le lab a validé.
