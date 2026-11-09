# Chantier 37 : les onglets swarph en lecture seule

| Champ | Valeur |
|---|---|
| État | **Révision 1, 9 novembre 2026.** Julien a retenu Q1 à Q3 de la spec. Le lab a donné son PASS sur la spec, révision 1 (DM 92942), avec ses réponses L1 à L7, et le commander a tranché #1512 (DM 92804). Le lab a aussi donné son PASS sur le plan, révision 0 (DM 92955), avec deux changements obligatoires, intégrés dans D239 : l'environnement de `memory` et `--` avant la requête de `codegraph`. |
| Emplacement final | `docs/chantiers/37-onglets-swarph.md` sur `main`, dans le premier commit du chantier |
| Base | **dc6c162** (`origin/main`, PR #132). |
| Spec | `specs/onglets-37.md`, révision 1 (dossier de travail, hors dépôt). |
| Organisation | Comme au 38. morzu-vps gère le chantier. Un agent Codex CLI écrit le code et les tests de chaque point, sur un brief tiré de ce plan. morzu-vps relit chaque diff, lance le gate, commite et ouvre la PR. |
| Validation | Le lab valide le 37 (programme §5 bis). Le merge suit la règle de Julien : CI verte et validation du lab. |

## 1. Pourquoi

Ligne 37 du programme : les onglets venus de swarph-desktop. Le 24 a apporté le Board. Le 37 ajoute ce que swarph permet déjà de lire sur la cellule et sur le mesh : les cellules, l'index de code local, la mémoire et l'état de la cellule. Rien n'y écrit, et rien n'y est envoyé.

Le desktop a été lu en lecture seule, avec l'accord du commander et de Julien. Ce plan n'en reprend ni code, ni contenu, ni seuil : il décrit ce qu'A-I-D fait, avec ses propres lectures swarph-cli.

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| Le lecteur | `src/daemon/mesh/board.ts` | `BoardReader` : une liste fermée de lectures `--json --as <cell>` (D93), un cache de 5 s, les demandes identiques fusionnées (D94), `classify()` pour les erreurs (D95). |
| Les routes | `src/daemon/routes/board.ts` | `GET /api/board/…`, avec un résultat discriminé `{ok, data, readAt}` ou `{ok: false, kind, readAt}`. Elles répondent 404 si le mesh est désactivé. |
| Le mode host | `src/daemon/host/serveur.ts:527-544` | Il ne réexpose que les trois routes du Board aux appareils (D178). |
| Le web | `web/src/ecrans/Board.tsx`, `web/src/data/board.ts`, `web/src/ui/Barre.tsx:172-182` | L'écran Board et ses états (`BoardEtats`). Le lien « Board » de la barre n'existe que si le mesh est configuré. `/swarph` est la page « Connecter à swarph » (chantier 25). |
| Le faux swarph | `test/fixtures/fake-swarph.sh` | Il connaît `monitor`, la cell en PTY et les six lectures `board`, servies depuis `$FAKE_SWARPH_BOARD/<nom>.json`. |
| `aid doctor` | `src/cli/commands/doctor.ts:90` | `SWARPH_BOARD_MIN = '0.72.40'`. |

Les lectures swarph-cli du 37, d'après le code de swarph-cli et les réponses du lab :

| Lecture | Sortie |
|---|---|
| `swarph mesh peers --as <cell>` | Du **texte**, une ligne par pair : le nom et la version déclarée, séparés par des espaces. Il n'y a pas de `--json` (L7) ; il viendra avec #1513. |
| `swarph rights --json --as <cell>` | `{peer, groups[], grants[{grant_type, target, level, direct, via_group}]}`. On ne passe jamais de nom de pair (L1). |
| `swarph codegraph <requête> --local --json --limit N --caller-cell <cell>` | Une **liste brute** de `{repo, name, kind, file_path, start_line, callers, score, qualified_name, docstring, signature}`. S'il n'y a pas d'index, le code de sortie n'est pas 0 et `stderr` contient `NO INDEX AVAILABLE`. Un index périmé est signalé sur `stderr` (`STALE INDEX`), et les lignes restent valides. |
| `swarph memory list --tag <t> -n N --json` | Une liste de pages (`slug`, `title`, `type`, `tags`…), dans la forme de gbrain, sans contrat versionné. |
| `swarph memory get <slug> --json` | Une page. Le corps est sous `compiled_truth`, ou sous `content` pour les anciens cerveaux. |
| `swarph memory links <slug> --direction both --json` | Des arêtes OKF : `{type: "edge", from, to, rel, direction, hop}`. |
| `swarph monitor status --json --as <cell>` | Déjà lu par `MeshService` (chantier 12). |

## 3. Cible et hors-périmètre

**Cible.**
- Quatre onglets s'ajoutent au Board, sous la même entrée de la coque : **Cells**, **Federation**, **Memory** et **Réglages swarph**.
- Une barre d'onglets commune réunit Board, Cells, Federation, Memory et Réglages swarph.
- Chaque onglet lit à son ouverture et sur « Recharger ».

**Hors-périmètre.**
- Command (répondre, approuver, rejeter) : c'est une écriture, qui ira au 35 ou au 36.
- Les DM des autres cellules : ils attendent #733.
- La présence des cellules : elle attend #1513.
- `cell selfcheck` et `cell probe` : ils attendent leur `--json` dans #1513 (L7).
- Le parcours de l'index par niveaux, qui demande une commande swarph-cli dédiée (L6).
- Toute lecture directe d'une base de swarph.
- Les onglets du haut du desktop, qui ne sont que des bouchons (spec 0.d).
- L'exposition de ces lectures aux appareils, en mode host.

## 4. Décisions

### D239. Une liste fermée de six nouvelles lectures

- **Un nouveau lecteur.** `SwarphReader` (`src/daemon/mesh/lectures.ts`) reprend le modèle de `BoardReader` :
  - un cache de 5 s par commande ;
  - les demandes identiques fusionnées ;
  - `?fresh=1` ;
  - `classify()` réutilisée telle quelle ;
  - le même `mesh.read(args)`, donc le même environnement et le même délai.
- **Les lectures sont exactement celles du tableau du §2.** Il y en a six, plus `monitor status`, déjà lu. Aucune autre forme n'est construite.
- **Les arguments venus de l'interface** sont validés avant tout lancement. Un argument refusé donne une erreur 400, et swarph n'est pas lancé.
  - La requête `codegraph` fait de 1 à 200 caractères, sans caractère de contrôle, et **ne commence jamais par `-`**. Il y a **deux défenses** (lab, DM 92955) : ce refus, et un `--` placé juste avant la requête dans l'argv. La requête est le dernier argument.
  - Les slugs reçus dans les liens d'une page viennent d'autres cellules. Ils repassent par la même regex avant tout `memory get`.
  - Un `tag` ou un `slug` suit `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$`.
  - `N` est fixé par le daemon : 50 pour `codegraph`, 100 pour `memory list`.
- **Les cas propres à `codegraph`.**
  - Un code de sortie non nul avec `NO INDEX AVAILABLE` sur `stderr` donne un nouveau `kind`, `no-index`. Ce n'est pas `unknown`.
  - `STALE INDEX` sur `stderr` donne `ok: true`, avec `perime: true`.
- **L'identité et le chemin de `memory`** (lab, DM 92955, changement obligatoire).
  - Le choix du chemin dépend de l'environnement. Si `SWARPH_BRAIN_GATEWAY` est posé, `memory` passe par le gateway avec le jeton de pair de `SWARPH_SELF`. Sinon, il va droit au cerveau, avec `GBRAIN_TOKEN`, `SWARPH_BRAIN_TOKEN` ou le jeton de pair.
  - Le chemin direct contournerait la future réduction de portée de #1512, et le bandeau mentirait. Pour les trois lectures `memory`, le lecteur :
    - pose `SWARPH_BRAIN_GATEWAY`, tiré du `gateway` de la config mesh d'A-I-D, et `SWARPH_SELF=<cell>` ;
    - **retire** `GBRAIN_TOKEN` et `SWARPH_BRAIN_TOKEN` de l'environnement du sous-processus ;
    - ne passe jamais `--token-file`.
  - Sans adresse de gateway dans la config, Memory affiche « non configuré » (un nouveau `kind`, `not-configured`) et ne lance rien. Il ne retombe jamais sur le chemin direct.
  - `codegraph` n'a pas d'option `--as` : le lecteur lui passe `SWARPH_SELF=<cell>` et `--caller-cell <cell>`.
  - Aucun jeton n'est passé ni lu par A-I-D.

### D240. Les parseurs, tolérants

Les parseurs sont dans `src/shared/swarph.ts`. Ce sont des fonctions pures, qui renvoient `null` si la forme est inattendue (`kind: 'format'`).

- **`parsePeers(texte)`** : chaque ligne non vide est découpée sur les espaces et doit donner exactement deux colonnes, `{nom, version}`. Une ligne qui n'a pas deux colonnes rend toute la lecture `format`.
- **`parseRights(json)`** :
  - il garde `peer`, `groups` (des chaînes), et pour chaque droit `grant_type`, `target`, `level` et `direct` ;
  - si `direct` est absent, la valeur se déduit de `via_group === null` ;
  - le reste est ignoré.
- **`parseCodegraph(json)`** :
  - le JSON doit être une liste ;
  - chaque ligne garde `repo`, `name`, `kind`, `file_path`, `start_line`, `callers`, `qualified_name` et `signature`, coupés à 300 caractères ;
  - `docstring` est gardé coupé à 500 caractères ;
  - une ligne sans `name` est ignorée.
- **`parseMemoryList`, `parseMemoryPage` et `parseMemoryLinks`** :
  - le slug est obligatoire, et le titre, le type et les tags sont lus s'ils existent ;
  - le corps vient de `compiled_truth`, sinon de `content`, coupé à 200 000 caractères ;
  - les arêtes gardent `from`, `to`, `direction` et `hop` ;
  - un champ inconnu est ignoré, et une valeur inconnue s'affiche telle quelle.

### D241. Les routes, locales seulement

- **Les routes** :
  - `GET /api/swarph/cells`, qui renvoie `{peers, monitor}` ;
  - `GET /api/swarph/federation?q=` ;
  - `GET /api/swarph/memory?tag=` ;
  - `GET /api/swarph/memory/:slug`, qui renvoie `{page, links}`, lus en parallèle, chacun avec son propre résultat ;
  - `GET /api/swarph/reglages`, qui renvoie `{rights, monitor}`.
- Elles suivent les mêmes règles que `/api/board` : un résultat discriminé, toujours en 200 (D95), et une erreur 404 si le mesh est désactivé.
- **Elles ne sont pas réexposées en mode host** (`host/serveur.ts`). Un test vérifie qu'une route `/api/swarph/*` y répond 404. Les appareils n'ont, en lecture swarph, que le Board (D178).

### D242. La coque : une barre d'onglets swarph

- **La barre de la coque garde son lien « Board ».** Il est actif sur `/board` et sur les nouvelles routes.
- **Le composant `OngletsSwarph`** (`web/src/ui/OngletsSwarph.tsx`) s'affiche en haut de ces écrans : Board (`/board`), Cells (`/swarph/cells`), Federation (`/swarph/federation`), Memory (`/swarph/memoire`) et Réglages swarph (`/swarph/reglages`).
- **`/swarph` reste la page de connexion.** Sans mesh configuré, les quatre routes renvoient vers `/swarph`.
- **Les `data-node`** sont `onglets-swarph` et `onglets-swarph.<id>`.

### D243. Les quatre écrans

Règles communes :
- **La lecture se fait à l'ouverture**, et « Recharger » relit avec `fresh`. Une seule lecture est en cours à la fois, et l'écran affiche « Lu à ».
- **Les erreurs** passent par `BoardEtats`, avec en plus `no-index`.
- **Tout est rendu en texte React** : pas de Markdown, pas de `dangerouslySetInnerHTML`, et aucune URL du contenu n'est rendue en lien.

Les écrans :

- **Cells** (`web/src/ecrans/Cells.tsx`) :
  - un tableau avec le nom et la « version déclarée ». La cellule locale est en tête, marquée « toi », avec l'état de son monitor, et les autres suivent par nom ;
  - une note sous le tableau : « Version annoncée à la dernière inscription du pair, pas forcément celle qui tourne. La présence arrivera avec une lecture swarph dédiée. »
- **Federation** (`web/src/ecrans/Federation.tsx`) :
  - un champ et un bouton « Chercher », désactivés tant que la requête est vide ou invalide, avec la raison affichée ;
  - les résultats : le nom qualifié, le type, le dépôt, `fichier:ligne`, le nombre d'appelants et la signature. Le docstring se déplie ;
  - le bandeau « Index périmé : les numéros de ligne ont pu bouger » si `perime` ;
  - l'état `no-index` : « Aucun index local. Ce n'est pas un résultat négatif : rien n'a été cherché. »
- **Memory** (`web/src/ecrans/MemoireSwarph.tsx`, car `ui/Memoire.tsx` existe déjà pour la mémoire locale) :
  - le bandeau permanent : « Cette mémoire est partagée par tout le mesh pour l'instant. Sa portée se réduira à ta cellule. » ;
  - un champ de tag et la liste des pages ;
  - une page s'ouvre dans le même écran (`/swarph/memoire/:slug`). Le corps s'affiche en texte brut, avec `white-space: pre-wrap` ;
  - les liens entrants et sortants sont une liste de slugs. Chacun ouvre la page dans l'onglet : c'est notre propre navigation, pas un lien du texte ;
  - pas d'export, pas de bouton de copie ;
  - un refus (`forbidden`) s'affiche comme un état normal : « Ta cellule n'a pas, ou plus, accès à cette mémoire. »
- **Réglages swarph** (`web/src/ecrans/ReglagesSwarph.tsx`) :
  - les groupes et les droits de la cellule : type, cible, niveau, direct ou hérité ;
  - l'état du monitor ;
  - deux lignes « à venir » : la vérification de la cellule et la sonde des outils ;
  - aucune configuration brute : ni chemin, ni adresse du gateway.

## 5. Points

### 37.1 Les parseurs (D240)

`src/shared/swarph.ts` et `test/swarph-parse.test.ts`. Les tests couvrent, pour chaque parseur :
- la forme nominale ;
- un champ inconnu ;
- un champ manquant ;
- une forme illisible.

Ils couvrent aussi :
- une ligne `peers` à trois colonnes, qui donne `format` ;
- un `docstring` et un corps trop longs ;
- un droit sans `direct`.
- *Révision 37.1.* `src/shared/swarph.ts` contient les six parseurs et les trois validations d'arguments. `BoardErrorKind` gagne `no-index` et `not-configured`, avec leurs libellés dans `MESSAGES_BOARD` (4 lignes insérées, aucune modifiée). Une page de mémoire garde `content`, tiré de `compiled_truth` ou à défaut de `content`. Gate 2507.

### 37.2 Le faux swarph apprend les six lectures

- `test/fixtures/fake-swarph.sh` sert :
  - `mesh peers` depuis `$FAKE_SWARPH_BOARD/mesh-peers.txt` ;
  - `rights` depuis `rights.json` ;
  - `codegraph` depuis `codegraph-<requête normalisée>.json` ;
  - `memory list` depuis `memory-list-<tag>.json` ;
  - `memory get` depuis `memory-get-<slug>.json` ;
  - `memory links` depuis `memory-links-<slug>.json`.
- Il simule aussi les modes `no-index` et `stale` pour `codegraph`.
- Il refuse toute forme inconnue, comme au 24.
- Les fixtures vont dans `test/fixtures/board/`, avec des noms de pairs d'exemple (`peer-a`, `peer-b`). Aucun vrai nom de cellule n'y figure.
- *Révision 37.2.* Le faux swarph accepte les six lectures sous l'argv exact du plan, avec `--` avant la requête de `codegraph`. Il sert des fichiers, avec la requête normalisée en `[A-Za-z0-9._-]`. `FAKE_SWARPH_CODEGRAPH_MODE` vaut `no-index` ou `stale`. Les fixtures sont `mesh-peers.txt`, `rights.json`, `codegraph-lecture_test.json`, puis `memory-list-test.json`, `memory-get-page-test.json` et `memory-links-page-test.json`. 59 lignes sont insérées, aucune n'est modifiée. Gate 2520.

### 37.3 Le lecteur et les routes (D239, D241)

- `src/daemon/mesh/lectures.ts`, `src/daemon/routes/swarph.ts` et leur câblage dans `server.ts`.
- Les tests passent par le faux swarph, comme `test/board-reader.test.ts` et `test/board-routes.test.ts`. Ils couvrent :
  - chaque route ;
  - chaque argument refusé, et le fait que swarph n'est alors pas lancé. Une requête `-x` donne 400. Une requête valide arrive avec `--` juste avant elle dans l'argv ;
  - un `GBRAIN_TOKEN` et un `SWARPH_BRAIN_TOKEN` présents dans l'environnement du daemon n'arrivent pas dans celui de `memory`, qui reçoit `SWARPH_BRAIN_GATEWAY` et `SWARPH_SELF`. Sans gateway configuré, on obtient `not-configured`, et swarph n'est pas lancé ;
  - `no-index` et `stale` ;
  - `SWARPH_SELF` et `--caller-cell` ;
  - le cache et la fusion des demandes ;
  - le 404 sans mesh ;
  - le 404 en mode host.
- *Révision 37.3.* **Écart au plan (D241) :** la page de mémoire se lit par `GET /api/swarph/memory/page?slug=`, et non par `/memory/:slug`, parce qu'un slug peut contenir `/`. La réponse est `{page, links}`, deux résultats discriminés lus en parallèle. Federation rend `data: {lignes, perime}`. `monitor` reprend l'état courant complet de `MeshService`, sans relancer swarph. `MeshService.read(args, {env, unset})` : seule la signature est modifiée (1 ligne). Le test `test/swarph-host.test.ts` vérifie le 404 côté host, dans un fichier nouveau. Gate 2533.

### 37.4 La coque et les données web (D242)

- `web/src/ui/OngletsSwarph.tsx`, les routes dans `web/src/App.tsx`, et `web/src/data/swarph.ts` (des hooks sur le modèle de `data/board.ts`).
- Les tests couvrent :
  - la barre d'onglets ;
  - le lien « Board » actif sur les nouvelles routes ;
  - le renvoi vers `/swarph` sans mesh.

### 37.5 Cells et Réglages swarph (D243)

- Les deux écrans, avec leurs tests :
  - l'ordre de Cells ;
  - la note sur la version ;
  - les droits directs et hérités ;
  - aucune adresse ni aucun chemin dans le rendu des Réglages ;
  - les états d'erreur.

### 37.6 Federation et Memory (D243)

- Les deux écrans, avec leurs tests :
  - la validation de la requête ;
  - le bandeau d'index périmé et l'état `no-index` ;
  - le bandeau permanent de Memory ;
  - une page qui contient `<img src=x onerror=alert(1)>` et `https://exemple.invalid`, rendus en texte, sans balise `img` ni `a` ;
  - la navigation entre pages par les liens ; un slug de lien qui ne passe pas la regex ne s'affiche pas en lien et ne lance aucun `memory get` ;
  - le refus montré comme un état normal ;
  - l'absence de bouton d'export.

### 37.7 L'e2e et la fiche de recette

- `e2e/swarph-onglets.spec.ts`, sur le faux swarph : les quatre onglets, une recherche, une page de mémoire et ses liens, un état d'erreur par onglet.
- La fiche `docs/recette-chantier-37-onglets.md`, pour Julien, sur son vrai mesh. Elle vérifie :
  - les versions déclarées ;
  - une recherche dans l'index local ;
  - une page de mémoire, en relevant que la lecture passe bien par le gateway ;
  - les droits de sa cellule ;
  - l'absence de toute écriture. Pour cela, on relève `wc -l inbox.log` et l'état lu avant et après, comme au 24.10.

## 6. Pièges

- **L'environnement.** `memory` choisit son chemin, gateway ou cerveau direct, d'après l'environnement. D239 force le gateway et retire les jetons du cerveau. Le daemon lancé par launchd n'a pas l'environnement du shell, et le lecteur ne doit dépendre ni de l'un ni de l'autre.
- **La forme de gbrain** n'a pas de contrat versionné. Les parseurs restent tolérants, et une forme inattendue donne `format`, jamais un écran vide.
- **Le contenu venu des cellules.** `docstring`, `signature`, le corps des pages et les slugs viennent d'autres cellules. Ils ne s'affichent qu'en texte.
- **`codegraph`.** Une requête FTS mal formée rend `[]`, pas une erreur : « aucun résultat » doit rester neutre. Le code de sortie, lui, distingue l'absence d'index.
- **`mesh peers` est une sortie texte** qui peut changer de mise en page. Le parsing reste strict sur ses deux colonnes, et on passera au `--json` dès #1513.

## 7. Fini quand

- 37.1 à 37.7 sont commités, avec `npm run gate` et `npm run e2e` verts.
- La CI est verte.
- Le lab a validé le chantier.
- La recette de Julien est faite.
