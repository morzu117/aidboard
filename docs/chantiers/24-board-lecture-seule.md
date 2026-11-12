# Chantier 24 : board swarph en lecture seule

| Champ | Valeur |
|---|---|
| État | **Révision 2, 4 novembre 2026, 22 h 15.** Validé par Julien. Relu par le lab le 4 novembre à 22 h 04 (message 89726 sur #1457), verdict : *REVISE, small*. Les 3 corrections demandées sont intégrées (voir §9). **Relecture du plan : PASS** du lab le 4 novembre à 22 h 06 (message 89733), sur la base de la liste des changements de la révision 2. Rien n'est construit. |
| Emplacement final | `docs/chantiers/24-board-lecture-seule.md` sur `main`, dans le premier commit du chantier |
| Base | **6221e16** (`origin/main`, PR #111), le commit relu par la porte 0.b. Les `fichier:ligne` ont été lus sur 850eefc (PR #97). Aucun des fichiers cités n'a changé entre les deux. Une tête plus récente demande une relecture du delta par le lab. |
| Numéro | Ce chantier s'appelait **22** jusqu'au 5 novembre, y compris dans la relecture du lab (89726, 89733) et dans l'obligation #4214. Renuméroté **24**, parce que `main` a pris le 22 (commandes slash) et le 23 (remote-control). Pour la même raison, ses décisions, proposées en D80 à D86, deviennent **D92 à D98** (D80 à D91 sont pris par les chantiers 22 et 23). |
| Bloc et carte | bloc 15 du plan d'architecture ; carte **#1457** du projet 18 `aid-fusion` |
| Spec | maquettes V4, dans le dossier de travail `docs/fusion-aid-swarph/` (hors dépôt, non commité) : `docs/fusion-aid-swarph/spec-driven-plan/specs/board.md`, `docs/fusion-aid-swarph/spec-driven-plan/specs/etats.md`, `docs/fusion-aid-swarph/spec-driven-plan/specs/regles-globales.md` ; écrans `BoardV1`, `CarteV1` et `BoardEtats` |
| Brief | `docs/fusion-aid-swarph/brief-chantier-vue-board.md` |
| Programme | `docs/fusion-aid-swarph/spec-driven-plan/programme.md`, phase 1 |
| Construit par | côté Julien (morzu-mac), une fois le droit d'exécution sur le projet 18 accordé |
| Validé par | le lab, comme pair distinct, par lecture du code. Le code ne tourne que dans son bac à sable, contre le vrai mesh. Plus la recette de Julien. |

## 1. Pourquoi

Julien veut piloter swarph depuis A-I-D. La première marche est de **voir** le board sans terminal : les projets, les cartes, le graphe d'étapes, les obligations, le fil et l'historique. Ce chantier ne fait que lire. Les écritures viendront avec les chantiers 35 et 36, après le proxy local du lab et #20.

C'est aussi la première vue swarph de l'app unique (#1449). Elle n'apparaît que si le mesh est configuré.

## 2. État actuel

Les références sont prises sur `main`.

- **Exécution de swarph** :
  - `meshExec` (`src/daemon/mesh/exec.ts:25-48`) n'utilise jamais de shell. Il prend un tableau d'arguments et un délai. Son tampon est limité à 4 Mo (`:18`).
  - `MeshService` (`src/daemon/mesh/service.ts:48`) construit l'environnement (`env()`, `:243-247` : `SWARPH_STATE` et `MESH_GATEWAY_URL`, jamais de jeton). Il lance swarph par `run()` (`:249-255`, délai de 30 s par défaut).
  - Ses actions passent par la file `serial()` (`:228-232`).
- **Création du service** : `src/daemon/main.ts:221-230`. Il n'existe que si `mesh.cell` est configuré (D39).
- **Routes du mesh** : `src/daemon/routes/mesh.ts:14-19`. Sans cell, tout répond 404 avec `AidHttpError`. Elles sont enregistrées dans `src/daemon/server.ts:149`.
- **Configuration** : `MeshConfig` (`src/daemon/config.ts:43-55`) contient `bin`, `cell`, `gateway` et `stateRoot`.
- **Doctor** : `src/cli/commands/doctor.ts:241-247` vérifie seulement que `swarph --version` répond. Il n'y a pas de version minimale.
- **Faux swarph** : `test/fixtures/fake-swarph.sh` (D40). Il répond à `--version` (0.72.25, `:10-13`), à `monitor` et à `spawn`. Toute autre commande sort en code 2 (`:70-71`). Chaque appel est journalisé dans `FAKE_SWARPH_LOG`.
- **Interface** :
  - routes de `web/src/App.tsx:18-28` ;
  - barre du haut `web/src/ui/Barre.tsx`, avec `EcranId` (`:12`), les liens fixes `LIENS` (`:51-58`) et la pastille mesh conditionnelle ;
  - le contenu d'un pair est affiché en texte brut dans `ArticleMesh` (`web/src/ecrans/Boite.tsx:269`) ;
  - la petite largeur se détecte par `useViewport` (`web/src/ui/useViewport.ts:13`).
- **Modèle de magasin côté web** : `ServeursStore` (`web/src/data/serveurs.ts`). Il lit au premier abonné, relit périodiquement tant qu'il reste un abonné, et gère les courses entre réponses.
- **E2E mesh** : `e2e/mesh.spec.ts`, sur les faux binaires (`mesh.cell` morzu-mac).
- **Décisions** : la dernière prise sur `main` est **D79** (chantier 17). Ce plan propose D92 à D98. Revérifier le numéro au premier commit.

### Ce que swarph-cli 0.72.40 permet (vérifié le 4 novembre)

| Lecture | Commande | Racine du JSON |
|---|---|---|
| projets | `swarph board projects list --json --as <cell>` | `{projects}` |
| cartes | `swarph board cards list --project <id> --json --as <cell>` | `{cards, due}` |
| carte | `swarph board cards show <id> --json --as <cell>` | la carte, avec `stage_history` et `open_obligations` |
| graphe | `swarph board cards graph <id> --json --as <cell>` | `{steps, missing, flow, gate, stage_implied}` |
| fil | `swarph board cards thread <id> --limit 1000 --json --as <cell>` | `{card_id, thread_uuid, messages}`. Sans `--limit`, le gateway applique sa valeur par défaut : d'après une note du lab, ce sont les 200 messages **les plus anciens**, sans indicateur de troncature. |
| obligations | `swarph board obligations list --card <id> --json --as <cell>` | `{obligations, as_of, truncated}`. Avec `--card`, la réponse fait environ 5 Ko (0,25 s). La liste entière fait 20 Mo pour lab-ovh, et la nôtre grandira avec nos droits. |

- `cards history` renvoie aujourd'hui le même objet que `show`. Ce chantier ne l'utilise pas.
- **Erreurs** :
  - code 1 avec `gateway 403: no read grant on this project`, avec `gateway unreachable`, ou avec `cannot resolve a mesh credential for '<cell>'` (cell sans identifiant, relevé par le lab à 22 h 03) ;
  - ces textes ne sont **pas un contrat stable** : il faut toujours une branche « inconnu » ;
  - code 2 pour un argument ou un verbe inconnu ;
  - les erreurs ne sont jamais en JSON.
- **Réponses du lab (89633)** :
  - `status` fait foi pour une obligation. `requested` dans `state` sur une ligne retirée est un bug du lab (#1456).
  - Les lectures du board ne consomment rien (testé par le lab).
  - Il n'y a pas de chronologie fusionnée.

## 3. Cible et hors-périmètre

**Livré :**
1. Des routes `GET /api/board/…` dans le daemon, qui lancent les 6 lectures ci-dessus et rien d'autre.
2. Un écran **Board** :
   - l'identité de la cell et son droit de lecture ;
   - une pastille « Board lu il y a N s » ;
   - un bouton Relire ;
   - les projets ;
   - une colonne par `stage` reçu ;
   - des cartes résumées : numéro, titre, responsable, échéance, nombre d'obligations ouvertes.
3. Une **fiche de carte** : corps, graphe d'étapes, obligations, fil, historique des étapes et liens GitHub.
4. Les messages d'erreur de `BoardEtats` : pas de droit, gateway injoignable, swarph trop ancien, swarph absent, format inattendu, liste tronquée.
5. `aid doctor` signale un swarph plus ancien que 0.72.40.
6. Une mise en page utilisable en petite largeur. Le téléphone n'y aura accès qu'au chantier 31.

**Hors périmètre :**
- toute écriture : commenter, prendre une obligation, déplacer une carte (chantiers 35 et 36) ;
- le flux d'événements (bloc 16) ;
- la chronologie fusionnée (chantier 38) ;
- plusieurs cells (bloc 11) ;
- le multi-mesh ;
- la place définitive de l'entrée Board dans la coque et la pastille « swarph tools » (chantier 25) ;
- « où est passé le temps » ;
- tout stockage en base.

Multi-mesh : voir le chantier 46 (D314, D315, D316), qui donne à chaque mesh ses lecteurs et ses routes de board, choisis par un sélecteur à l’écran.

## 4. Décisions

| # | Décision | Pourquoi |
|---|---|---|
| **D92** | Les lectures passent par une nouvelle méthode publique `MeshService.read(args)`. Elle réutilise `env()` et `run()`, mais **pas** `serial()`. | D35 : le jeton ne transite jamais par A-I-D. Une lecture de 3 s ne doit pas retarder `connect` ni `refresh`. C'est une insertion, sans aucune ligne existante modifiée. |
| **D93** | Les arguments sont construits par le daemon à partir d'une **liste fermée** de 6 formes. Les numéros sont des entiers validés, `--json --as <cell>` est toujours présent. `--no-redact`, `--token-file`, `mesh inbox` et `--consume` ne sont jamais passés. Un test vérifie le journal du faux swarph. | La surface d'exécution reste nulle : l'interface ne choisit jamais un argument. |
| **D94** | Rien n'est stocké en base. Un cache mémoire de **5 s** par vecteur d'arguments, et des requêtes identiques simultanées fusionnées. `?fresh=1` contourne le cache (bouton Relire). | Le board est l'état d'un tiers, lu en direct (comme D16 et D28). Chaque lecture coûte un aller-retour au gateway du lab. |
| **D95** | Les routes répondent toujours 200, avec un résultat discriminé : `{ok: true, data, readAt, schemaVersion}` ou `{ok: false, kind, readAt}`. `kind` vaut `forbidden`, `unreachable`, `credential`, `timeout`, `too-old`, `absent`, `format` ou `unknown`. Une erreur non reconnue est classée `unknown` (« swarph a répondu une erreur inattendue, voir le journal »), **jamais** `unreachable` : sinon un identifiant expiré ou absent ferait croire que le gateway est tombé. Le texte de stderr sert à classer l'erreur et va dans le journal du daemon. Il n'est jamais renvoyé à l'interface. Seule exception : 404 si le mesh est désactivé, comme `/api/mesh`. | Le 403 et le gateway injoignable ont le même code de sortie. Le texte de stderr est une donnée, pas un message à afficher. |
| **D95 bis** (Julien, 5 nov.) | Après la relecture de la PR #113, trois types et deux textes s'ajoutent à D95. `too-large` : une sortie de swarph au-delà de 4 Mo (le tampon d'`exec.ts`) n'est plus `format` mais « Trop volumineux pour être affiché (plus de 4 Mo) », sans action. Le refus reste, conformément au §6, mais il est nommé : un fil de 1000 messages peut le dépasser. `not-found` : le gateway répond `gateway 404` (« card N not found ») ; « Cette carte n'existe pas », avec Retour au board. `gateway 401` (jeton révoqué) est classé `credential`. Le refus `forbidden` dit ce qui est refusé : « Tu ne peux pas lire cette carte » sur la fiche, « Tu ne peux pas lire ce projet » pour ses cartes, « Tu ne peux pas lire les projets du board » pour la liste ; sur `/board`, pas de lien de retour vers la page où l'on est. | « Réponse du board illisible » faisait croire à un bug de lecture ; « Relire » sur un 404 ou un 401 ne pouvait pas aboutir. |
| **D96** | Le parsing est défensif (`src/shared/board.ts`) : les champs inconnus sont ignorés, les absents tolérés, un type inattendu devient `null`. Les chaînes qui contiennent du JSON (`fallback_policy`, `needs_extra`) sont décodées en tolérant l'échec. `trusted_author_column` est un **nom de colonne**, qui varie selon l'objet (`created_by` sur une carte, `credential_author` sur un message). L'auteur affiché est `obj[obj.trusted_author_column]`, ou « inconnu » à défaut, jamais un champ `claimed_*`. Une entrée de `stage_history` qui porte `by: "gateway"`, `derived: true` et `row: <id>` (depuis le 4 novembre, 21 h 04) n'est pas une personne : elle s'affiche « gateway (ligne N) ». `schema_version` est lu s'il est présent. | Le bloc 14 n'est pas livré. |
| **D97** | La lecture n'a lieu que si l'écran est ouvert : à l'ouverture, au retour du focus, puis toutes les 60 s. Jamais en tâche de fond. | La règle de la spec, et le coût pour le gateway. Le lab l'accepte pour un seul utilisateur (4 commandes par fiche ouverte). Le chantier 31 (mode host, plusieurs écrans) devra fixer un budget de lecture. |
| **D98** | Le contenu des pairs (corps, fil, preuves, texte de `state`) est affiché en texte brut, sans HTML ni Markdown, comme `ArticleMesh`. Le texte de `state` est affiché en entier, sans « … ». | Invariant 9 du programme. Le contenu vient d'agents tiers. |

**Ce que l'exécutant ne tranche pas seul :**
- la place de l'entrée Board. Ce plan ajoute un lien conditionnel dans la barre du haut ; le chantier 25 la déplacera ;
- tout ce que la spec ne dessine pas.

## 5. Points

Chaque point est un commit. Le gate complet (`npm run gate`) doit être vert avant chaque commit. On ne fait qu'insérer, sauf là où le point l'autorise expressément.

### 24.1 Modèle partagé et parsing défensif

- **Fichiers** :
  - `src/shared/board.ts` (nouveau) ;
  - `test/board-parse.test.ts` (nouveau) ;
  - `test/fixtures/board/*.json` (nouveaux). Ce sont des fixtures **synthétiques**, de la même forme que le réel. Les échantillons réels de `~/Projects/swarph-workspace/.build/json/` restent hors du dépôt.
- **Signatures** :
  - les types `BoardProject`, `BoardCardSummary`, `BoardCard`, `BoardStageEntry`, `BoardGraph`, `BoardStep`, `BoardObligation`, `BoardMessage` et `BoardResult<T>` ;
  - les fonctions `parseProjects`, `parseCards`, `parseCard`, `parseGraph`, `parseThread(json, limit)` et `parseObligations(json)`, qui renvoient `{value, schemaVersion} | null`. `parseThread` signale `capped: true` quand le nombre de messages atteint la limite ;
  - `trustedAuthor(obj)`, qui lit `obj[obj.trusted_author_column]` et renvoie « inconnu » à défaut, et `decodeJsonString(s)`.
- **Tests** :
  - champs inconnus ignorés ;
  - champ absent : la valeur passe à `null` ;
  - mauvais type : `null`, sans exception ;
  - `trusted_author_column` respecté sur une carte (`created_by`) et sur un message (`credential_author`), `claimed_by` ignoré, « inconnu » si la colonne nommée est absente ;
  - une entrée d'historique dérivée (`by: "gateway"`, `derived: true`, `row`) donne « gateway (ligne N) » ;
  - JSON dans une chaîne, valide et invalide ;
  - `status: withdrawn` avec `state: requested` : l'obligation est fermée et `status` fait foi ;
  - `truncated: true` remonté ;
  - `schema_version` présent ou absent.
- **Vérification** : `npx vitest run test/board-parse.test.ts`

### 24.2 Le faux swarph apprend `board`

- **Fichiers** : `test/fixtures/fake-swarph.sh`. Insertions seulement :
  - avant `:10`, une branche `--version` contrôlée par `FAKE_SWARPH_VERSION` ;
  - avant `:70`, une branche `board`.
- **Comportement** :
  - `board <verbe…> --json` affiche `$FAKE_SWARPH_BOARD/<nom>.json`, avec par exemple `cards-show-1432.json`, `obligations-list.json` ;
  - `FAKE_SWARPH_BOARD_ERROR=forbidden` écrit la ligne 403 réelle sur stderr et sort en code 1 ;
  - `FAKE_SWARPH_BOARD_ERROR=unreachable` écrit `gateway unreachable` et sort en code 1 ;
  - `FAKE_SWARPH_BOARD_ERROR=credential` écrit `cannot resolve a mesh credential for 'morzu-mac'` et sort en code 1 ;
  - `FAKE_SWARPH_BOARD_ERROR=other` écrit un texte quelconque et sort en code 1 ;
  - un argument inconnu sort en code 2 ;
  - `FAKE_SWARPH_BOARD_SLEEP` simule la lenteur.
- **Tests** : couverts par 24.3 et 24.4.
- **Vérification** : `bash test/fixtures/fake-swarph.sh board cards show 1 --json --as x` avec les variables posées.

### 24.3 Lecteur du board dans le daemon

- **Fichiers** :
  - `src/daemon/mesh/service.ts` : insertion de `read(args: string[]): Promise<MeshExecResult>` après `current()` ;
  - `src/daemon/mesh/board.ts` (nouveau) ;
  - `test/board-reader.test.ts` (nouveau).
- **Signatures** :
  - `class BoardReader { constructor(deps: { mesh: MeshService; cell: string; log; now?; cacheMs? }) }`
  - les méthodes `projects()`, `cards(projectId)`, `card(id)`, `fresh` (option de chaque appel) ;
  - `card(id)` lance `show`, `graph`, `thread` et `obligations` en parallèle, et assemble la fiche. Chaque partie a son propre `BoardResult`, pour qu'un graphe en échec n'empêche pas d'afficher le corps ;
  - `classify(result: MeshExecResult): BoardErrorKind | null`.
- **Tests** (exécuteur substitué) :
  - les vecteurs d'arguments exacts pour chaque lecture ;
  - aucun ne contient `--no-redact`, `--token-file`, `inbox` ni `--consume` ;
  - un identifiant non entier est refusé avant toute exécution ;
  - les vecteurs exacts incluent `obligations list --card <id>` et `cards thread <id> --limit 1000` ;
  - la classification : 403, gateway injoignable, identifiant introuvable (`credential`), code 1 avec un texte inconnu (`unknown`, jamais `unreachable`), code 2, `ENOENT`, délai dépassé, JSON illisible ;
  - une sortie au-delà de 4 Mo est refusée et signalée ;
  - le cache de 5 s, et `fresh` qui le contourne ;
  - deux appels simultanés ne lancent qu'une exécution ;
  - un `connect()` en cours dans `serial` ne bloque pas une lecture.
- **Vérification** : `npx vitest run test/board-reader.test.ts test/mesh-service.test.ts`

### 24.4 Routes `GET /api/board`

- **Fichiers** :
  - `src/daemon/routes/board.ts` (nouveau) ;
  - `src/daemon/server.ts` : l'import et une ligne `registerBoardRoutes(…)` insérés après `:149` ;
  - `src/daemon/main.ts` : construction de `BoardReader` quand `mesh` existe, et passage aux dépendances du serveur, en insertion ;
  - `test/board-routes.test.ts` (nouveau).
- **Routes** :
  - `GET /api/board/projects` ;
  - `GET /api/board/projects/:projectId/cards` ;
  - `GET /api/board/cards/:cardId` ;
  - chacune accepte `?fresh=1`.
- **Tests** (faux swarph par le `PATH`) :
  - 404 si le mesh est désactivé ;
  - 400 si l'identifiant est invalide ;
  - les cas `ok` et chaque `kind` ;
  - un jeton de run est refusé sur ces routes (`registerSecurity`) ;
  - `FAKE_SWARPH_LOG` ne contient que des commandes `board … --json --as morzu-mac` ;
  - `inbox.log` n'est pas modifié.
- **Vérification** : `npx vitest run test/board-routes.test.ts test/mesh-routes.test.ts`

### 24.5 `aid doctor` : swarph 0.72.40 minimum

- **Fichiers** :
  - `src/cli/commands/doctor.ts` : insertion après `:247` d'un `verify` de niveau `warn` (« swarph 0.72.25 : la vue board demande 0.72.40 ») ;
  - une comparaison de versions numérique, sans dépendance nouvelle ;
  - `test/doctor-swarph-version.test.ts` (nouveau).
- **Tests** :
  - 0.72.25 donne un avertissement ;
  - 0.72.40 et 0.73.0 passent ;
  - une version illisible garde le message existant.
- **Vérification** : `npx vitest run test/doctor-swarph-version.test.ts`, puis `aid doctor` à la main.

### 24.6 Magasin côté web

- **Fichiers** :
  - `web/src/data/board.ts` (nouveau), sur le modèle de `ServeursStore` ;
  - le test du magasin, à côté des tests web existants.
- **Signatures** :
  - `useBoardProjects()`, `useBoardCards(projectId)` et `useBoardCard(cardId)` renvoient `{result, enLecture, luA, relire()}` ;
  - la constante `BOARD_RELECTURE_MS = 60_000`.
- **Comportement** :
  - une lecture au montage, au retour du focus, puis toutes les 60 s tant que l'écran est monté et l'onglet visible ;
  - rien quand le daemon est injoignable ;
  - une réponse en retard n'écrase jamais une réponse plus récente.
- **Vérification** : `npm run test`

### 24.7 Écran Board

- **Fichiers** :
  - `web/src/ecrans/Board.tsx` (nouveau) et ses styles ;
  - `web/src/App.tsx` : deux `Route` insérées (`/board` et `/board/cartes/:cardId`) ;
  - `web/src/ui/Barre.tsx` : **modification autorisée** de `EcranId` (`:12`), pour ajouter `'board'`, et insertion d'un lien « Board » affiché seulement si `mesh` est défini.
- **Contenu** (`BoardV1` et `BoardEtats`) :
  - l'identité ;
  - la pastille « Board lu il y a N s » ou « Lecture du board… » ;
  - le bouton Relire ;
  - les projets ;
  - les colonnes dans l'ordre des `stage` reçus, jamais une liste fixe ;
  - les cartes « aid-fusion · #1449 », sans responsable ni échéance si c'est le cas ;
  - les messages d'erreur avec leur action (retour au board, Relire, `aid doctor`) ;
  - « Liste tronquée par le board ».
- **Petite largeur** : une colonne à la fois, par `useViewport`.
- **Vérification** : `npm run gate`, puis l'écran ouvert à la main sur le faux swarph (`npm run dev`, avec la configuration de l'e2e).

### 24.8 Fiche d'une carte

- **Fichiers** : `web/src/ecrans/CarteBoard.tsx` (nouveau). Le nom évite la confusion avec le futur écran « Carte, plus tard » de la spec.
- **Blocs** (`CarteV1`) :
  - Corps : texte brut.
  - Graphe : une ligne par étape, dans l'ordre reçu, avec `state` en entier ; « Manque » vient de `missing` ; `flow.unconfirmed` et `stage_implied` sont affichés.
  - Obligations : étape, détenteur, `status` officiel, `state` indicatif, « Fermée » d'après `closed_at`, « Preuve » à « — » si `close_outcome` est vide.
  - Fil : auteur, âge, texte brut. « Fil limité à 1000 messages » si `capped`.
  - Historique : étape, auteur, date. Une entrée dérivée s'affiche « gateway (ligne N) ».
  - GitHub : `links`.
- Une partie en échec affiche son message à sa place. Le reste s'affiche.
- **Vérification** : `npm run gate`

### 24.9 E2E sur le faux swarph

- **Fichiers** : `e2e/board.spec.ts` (nouveau). Mêmes `global-setup` et `helpers` que `e2e/mesh.spec.ts`. Les fixtures viennent de 24.1.
- **Scénarios** :
  - sans `mesh.cell`, ni lien ni route ;
  - le board du projet de test et ses colonnes ;
  - la fiche, avec son fil et son graphe ;
  - le 403 affiche « Tu ne peux pas lire cette carte » ;
  - gateway injoignable, puis rétabli : tout revient après Relire ;
  - swarph trop ancien (code 2) ;
  - `inbox.log` est identique avant et après ;
  - `FAKE_SWARPH_LOG` ne contient ni `inbox`, ni `--consume`, ni `--no-redact`, ni `--token-file`.
- **Vérification** : `npm run gate:e2e`

### 24.10 Recette réelle et fiche de recette

- **Fichiers** : `docs/recette-chantier-24-board.md` (nouveau), rempli pendant la recette.
- **Côté Julien, sur le Mac** :
  1. `swarph --version` donne au moins 0.72.40, le monitor est lancé et Tailscale est connecté.
  2. Le projet 18 s'affiche, ainsi que la carte #1432 avec son fil et son graphe, et #1457.
  3. La carte #559, ouverte par l'URL, affiche « Tu ne peux pas lire cette carte ». Relever aussi ce que donne `obligations list --card 559` : rien ou un refus. Le lab ne l'a pas testé et veut le voir sur la fiche.
  4. Tailscale arrêté affiche « Le gateway ne répond pas ». Tout revient quand Tailscale repart.
  5. `wc -l inbox.log` et l'état lu des DM sont relevés avant et après une lecture de `cards thread` sur une carte qui a un vrai DM. Ils doivent être inchangés. Ne jamais lancer `swarph mesh inbox`.
- **Côté lab** : la même recette dans son bac à sable contre le vrai mesh, **après** la revue de sécurité (porte 0.b du programme).
- **Vérification** : la fiche remplie, citée dans la PR.

## 6. Pièges

- **Les `AID_*` de la session** : relancer le gate avec `env -u AID_HOME -u AID_NO_BROWSER` si la session les exporte (chantier 12).
- **Code de sortie 1 ambigu** : seul le texte de stderr distingue le 403 du gateway injoignable. Le comparer à des sous-chaînes connues. S'il ne correspond à aucune, classer en `unknown` et journaliser. Ces textes ne sont pas un contrat stable.
- **Taille** : toujours `obligations list --card <id>`, jamais la liste entière (20 Mo pour lab-ovh, au-delà du tampon de 4 Mo de `exec.ts:18`). Garder le refus au-delà de 4 Mo : le signaler, ne pas agrandir le tampon en silence.
- **Fil** : toujours `--limit 1000`. Sans lui, un fil long cacherait ses messages les plus récents sans le dire.
- **`cards history`** : c'est le même objet que `show`, donc on ne l'appelle pas.
- **#1456** : `state` peut contredire `status`. On affiche `status`. Le test de 24.1 fige ce cas.
- **Fixtures** : uniquement synthétiques. Aucun message réel du lab dans le dépôt.
- **Ne pas toucher à `serial()`** ni aux autres méthodes de `MeshService` : seule l'insertion de `read()` est permise.
- **`EcranId`** : c'est la seule ligne existante qu'on modifie dans l'interface. Vérifier les `switch` exhaustifs qui en dépendent.
- **Petite largeur** : le téléphone n'atteint pas le cockpit avant le chantier 31. Ne pas promettre l'accès mobile dans la recette.

## 7. Fini quand

- Les points 24.1 à 24.10 sont commités, un commit par point, et `npm run gate` comme `npm run gate:e2e` passent.
- La recette de Julien est faite et sa fiche est remplie.
- La revue de sécurité (0.b) est passée, puis le lab a validé (ligne `validate` de #1457) par lecture du code et par la recette dans son bac à sable.
- La PR sur le dépôt A-I-D cite #1457, et Julien l'a mergée.
- Les obligations de #1457 sont fermées avec leurs preuves : la PR, le commit et les deux fiches de recette.
- La preuve de clôture de #4214 (build) suit le format demandé par le lab : `https://github.com/morzu117/aidboard/pull/N head <sha de 40 caractères>`. Elle nomme aussi ce qui n'a pas été lancé.

## 8. Avant de construire

1. Julien valide ce plan, en particulier D92 à D98 et le lien provisoire dans la barre du haut.
2. Le lab relit la spec et le plan (relecture voulue pour le 24).
3. Le commander accorde à morzu-mac le droit d'exécution sur le projet 18, pour qu'il puisse prendre la ligne `build` de #1457.
4. Le plan est copié dans `docs/chantiers/24-board-lecture-seule.md` sur une branche `feat/24-board-lecture-seule` partie de `main`, et ajouté au tableau du §9 du README des chantiers.

## 9. Relecture du lab (4 novembre, 22 h 04, message 89726)

Verdict : **REVISE, small**. La forme convient au lab : liste fermée de commandes, aucun jeton dans A-I-D, aucun stockage, texte brut, lecture seulement quand l'écran est ouvert. Le lab a lancé les commandes en tant que lab-ovh (swarph-cli 0.72.41) et lu le code du gateway. Il n'a pas lu le code d'A-I-D.

| Demande du lab | Intégrée dans |
|---|---|
| 1. `obligations list --card <id>` au lieu de filtrer la liste entière | §2, 24.1, 24.3, §6 |
| 2. Ajouter les types `unknown` et `credential` : une erreur non reconnue ne doit jamais s'afficher comme « gateway injoignable » | §2, D95, 24.2, 24.3, §6 |
| 3. `cards thread --limit 1000`, et « fil limité à N messages » quand la limite est atteinte | §2, 24.1, 24.3, 24.8, §6 |

Réponses du lab aux trois questions :
- Les 6 commandes répondent comme décrit.
- `cards thread` ne marque rien comme lu, ni les cinq autres lectures. Seul `GET /messages` met à jour `last_seen`, et A-I-D ne l'appelle pas.
- 0.72.40 suffit comme version minimale.

Également intégrés :
- les entrées d'historique dérivées du gateway ;
- le fonctionnement exact de `trusted_author_column` ;
- la vérification de `obligations --card 559` pendant la recette ;
- le budget de lecture à fixer au chantier 31.

**PASS** le 4 novembre à 22 h 06 (89733). Le lab a lu la révision 1 en entier et la liste des changements de la révision 2, mais pas le texte de la révision 2. Au moment du build, le validateur comparera le plan commité dans `docs/chantiers/24` à cette relecture. La ligne `plan-review` de #1457 n'a pas pu être fermée : le gateway répond « Eligible: NOBODY », car le projet 18 n'a aucun droit d'exécution. Les lignes s'ouvriront quand le commander aura décidé des droits. Cette relecture n'approuve ni le programme, ni le build, ni le droit.

Toujours en attente : le droit d'exécution de morzu-mac sur le projet 18, et la décision du commander sur qui mène la revue de sécurité (0.b).
