# Chantier 38 : la chronologie d'une carte du board

| Champ | Valeur |
|---|---|
| État | **Révision 0, 8 novembre 2026.** Julien a retenu Q1 à Q4 de la spec. PASS de lab sur la spec (DM 92561), dont les réponses à L1 et L2 sont écrites en D236 et D237. |
| Emplacement final | `docs/chantiers/38-chronologie-carte.md` sur `main`, dans le premier commit du chantier |
| Base | **c6b3554** (`origin/main`, PR #130). |
| Spec | `specs/chronologie-38.md`, révision 1 (dossier de travail, hors dépôt ; copie sur morzu-vps dans `~/work/aid-specs/`). |
| Organisation | Comme au 34. morzu-vps gère le chantier. Un agent Codex CLI écrit le code et les tests de chaque point, sur un brief tiré de ce plan. morzu-vps relit chaque diff, lance le gate, commite et ouvre la PR. |
| Validation | Julien valide le 38 (programme §5 bis), après sa recette. Le lab relit la spec seulement. Le merge suit la règle de Julien : la CI verte. |

## 1. Pourquoi

Ligne 38 du programme : « Historique d'une carte : chronologie construite côté client (`stage_history`, `events` des lignes du graphe, fil) ». Le 24 montre ces trois sources dans des blocs séparés, et le bloc « Historique » ne contient que les étapes. Le lab l'a noté (89633) : « Il n'y a pas de chronologie fusionnée. »

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| Le parseur | `src/shared/board.ts` | `parseStep` lit `row` par `int()`. Le gateway le renvoie sous forme d'objet, donc la valeur lue est `null`. `events` et `prior_rows` ne sont pas lus. `parseStageEntry` gère les entrées dérivées. |
| La fiche | `web/src/ecrans/CarteBoard.tsx` | Les blocs Corps, Graphe, Obligations, Fil, Historique (`Historique`, `:194`) et GitHub. Une partie en échec n'empêche pas les autres. |
| Les fixtures | `test/fixtures/board/` | `cards-graph-10{1,2}.json` : `row` entier ou `null`, et `events` vides. |
| Les tests | `test/board-parse.test.ts`, `test/web/carte-board.test.tsx`, `e2e/board.spec.ts` | Le parseur, la fiche, et l'e2e sur le faux swarph. |

## 3. Cible et hors-périmètre

**Cible.**
- Le bloc « Historique » devient « Chronologie ». C'est une seule liste, du plus récent au plus ancien, qui mêle les étapes, les événements des obligations et le fil.
- Trois filtres l'accompagnent, tous allumés par défaut.
- Les limites s'affichent en pied de liste.

**Hors-périmètre.**
- Toute nouvelle lecture swarph, toute écriture et tout stockage.
- Les événements des lignes antérieures (`prior_rows`) : seul leur nombre est montré.
- Une route serveur de chronologie (#1445).
- La vue « où est passé le temps ».

## 4. Décisions

### D235. Rien de nouveau côté swarph

Le 38 garde les mêmes six lectures que le 24, avec les mêmes arguments et le même délai. Seul le parseur de `cards graph` change.

### D236. Le parseur lit la ligne et ses événements

- `BoardStep.row` devient `BoardRow | null`, avec `BoardRow { id, holder, status, createdAt, takenAt, closedAt, closeOutcome }`.
  - Un objet est lu champ par champ.
  - Un entier donne `{ id }`, avec le reste à `null`, pour rester compatible avec les fixtures.
  - Toute autre valeur donne `null`.
  - `accept` n'est pas lu.
- `BoardStep.events` : `{ at, by, kind, holder, outcome }[]`.
  - `holder` et `outcome` viennent de `detail` (une chaîne JSON), lu par `JSON.parse` dans un `try`. Ils ne sont gardés que si ce sont des chaînes d'au plus 200 caractères. Le reste de `detail` est jeté.
  - Une entrée sans `kind` est ignorée.
- **La tolérance (L2 du lab).** Le format est celui du gateway, relayé par swarph sans contrat versionné. Un champ inconnu est ignoré. Un champ absent est affiché comme absent, sans faire échouer l'entrée. Un `status` hors de la liste connue (`open`, `closed`, `withdrawn`, `released`, `fallback_fired`, `declined`) s'affiche tel quel.
- `step.evidence` et `row.accept` sont des textes libres écrits par des cellules : le parseur ne les lit pas, et la chronologie ne les montre jamais.
- `BoardStep.priorRows` : le nombre d'identifiants dans `prior_rows`.

### D237. La fonction `chronologie`

`chronologie({ card, graph, thread })` est une fonction pure, dans `web/src/data/chronologie.ts`. Elle prend les trois `BoardResult` et renvoie :
- `{ entrees, limites }` ;
- `entrees` : `{ cle, date, source: 'etape' | 'obligation' | 'fil', auteur, texte }[]`, triées par date décroissante. Les entrées sans date ou à date illisible vont à la fin, dans l'ordre reçu. Le tri est stable ;
- les phrases de la spec : « Étape → build », « (déduite par le gateway, ligne N) », puis pour les obligations « Obligation <step> ouverte pour <holder> », « prise », « modifiée », « fermée : <outcome> ». Le lab (L1, DM 92561) donne les neuf sortes de la contrainte du gateway. Les cinq autres sont `decline` « déclinée », `reassign` « réattribuée », complétée par « à <holder> » si `holder` est lisible, `fallback` « échéance passée », `withdraw` « retirée » et `release` « rendue ». Toute autre sorte donne « événement <kind> ». Pour le fil, les 140 premiers caractères du message, suivis de « … » si le message est coupé ;
- `limites` : `fil-limite` si `capped`, `{ lignesAnterieures: N }` si N > 0, et `non-lu: 'etapes' | 'obligations' | 'fil'` pour chaque lecture en échec.
- *Révision D237, 10 novembre 2026 (recette du Mac en v0.6.0, DM 95722).* Le tri stable gardait l'ordre reçu à milliseconde égale. Or chaque source arrive du plus ancien au plus récent : trois événements d'obligation de la même milliseconde s'affichaient donc à l'envers. Désormais, à milliseconde égale, la fraction au-delà de la milliseconde départage, si la date en a une, avec ou sans fuseau. Ensuite vient l'ordre **inverse** de réception, y compris pour les entrées sans date, qui restent à la fin. L'ordre est total et déterministe.

### D238. Le bloc « Chronologie »

- Il remplace le bloc « Historique » dans `CarteBoard.tsx`. Il s'affiche même si une lecture a échoué, avec les limites en pied.
- Les filtres sont des cases « Étapes », « Obligations » et « Fil », allumées par défaut. Leur état est local au composant : il n'est pas gardé et ne passe pas dans l'URL.
- Chaque entrée affiche la date (courte, avec la date complète en `title`), un repère de source, l'auteur et le texte. Tout est du texte React.
- Les `data-node` sont `carte-board.chronologie`, `carte-board.chronologie.entree-<i>`, `carte-board.chronologie.filtre-<source>` et `carte-board.chronologie.limites`.

## 5. Points

### 38.1 Le parseur (D236)

`src/shared/board.ts` et les fixtures `cards-graph-102.json` (une ligne objet et des événements `mint`, `take`, `amend` et `close`, avec des noms de pairs d'exemple). Tests dans `test/board-parse.test.ts` :
- `row` en objet, en entier et invalide ;
- les événements, dont un `detail` illisible, un `detail` trop long et une entrée sans `kind` ;
- `prior_rows`.
- *Révision 38.1.* `BoardRow` et `BoardEvent` ; `row` est lu en objet, en entier ou à `null` ; `events` garde seulement `holder` et `outcome` de `detail` (au plus 200 caractères), et ignore une entrée sans `kind` ; `priorRows` ne compte que les identifiants entiers. `evidence` et `accept` ne sont pas lus. Lignes existantes modifiées : 6.

### 38.2 La fonction `chronologie` (D237)

`web/src/data/chronologie.ts`. Tests dans `test/web/chronologie.test.ts` :
- le tri, avec les dates égales et les entrées sans date ;
- chaque phrase, pour les neuf sortes et une sorte inconnue ;
- la coupe à 140 caractères ;
- chaque limite ;
- une lecture en échec n'empêche pas le reste.
- *Révision 38.2.* `chronologie()` fusionne les étapes, les événements des neuf sortes et le fil. Le tri est stable, par date décroissante, et les dates illisibles vont en fin de liste. Les limites sont `fil-limite`, `lignesAnterieures` et `non-lu`. Hors du chantier : le test « merge 202 » du 34.8 est rendu déterministe, avec les minuteries avancées dans `waitFor` (2 lignes remplacées), et il passe 20 fois sur 20 sous la charge du gate. Gate : 2491 tests passent ; `agents-pilotage`, déjà connu pour être instable, passe quand il est relancé seul.

### 38.3 Le bloc « Chronologie » (D238)

`web/src/ecrans/CarteBoard.tsx`, et la mise à jour de `test/web/carte-board.test.tsx` là où l'historique était vérifié. Tests :
- les filtres ;
- l'ordre affiché ;
- un `detail` ou un message contenant `<img src=x onerror=alert(1)>` n'est affiché qu'en texte ;
- les limites.
- *Révision 38.3.* Le bloc « Chronologie » remplace « Historique ». Il a trois cases de filtre locales et affiche, pour chaque entrée, la date (complète en `title`), la source, l'auteur et le texte, avec les limites en pied. Aucun CSS ajouté. Lignes existantes modifiées : 27 (le bloc Historique et ses deux tests). Gate 2497.

### 38.4 L'e2e et la fiche de recette

- `e2e/board.spec.ts` : la chronologie de la carte de test, les filtres, et le pied de liste quand le fil est limité.
- La fiche `docs/recette-chantier-38-chronologie.md`, pour Julien : sur son board réel, ouvrir une carte et comparer la chronologie au fil et aux obligations.
- *Révision 38.4 — fait.* E2e sur la carte 102 : ordre décroissant, phrases des obligations, filtre Fil et pied des deux lignes antérieures. Fiche de recette rédigée pour Julien ; recette réelle à effectuer.
- *Révision 38.4.* L'e2e de `e2e/board.spec.ts` vérifie la chronologie de la carte 102 : l'ordre, les phrases des obligations, le filtre Fil et les lignes antérieures. La fiche `docs/recette-chantier-38-chronologie.md` est pour Julien. Gate : 2496 tests passent ; `agents-pilotage`, déjà connu pour être instable, passe relancé seul. E2e 118.

## 6. Pièges

- Le `detail` est une chaîne JSON qui vient d'un pair : il ne s'affiche jamais en brut.
- Les dates du gateway ont des microsecondes et un fuseau : `Date.parse` les lit. Une date illisible part en fin de liste, sans faire échouer le reste.
- Le fil peut faire 1000 messages : le tri doit rester linéaire en mémoire, et le rendu ne doit pas bloquer. Un simple tri suffit.

## 7. Fini quand

- 38.1 à 38.4 sont commités, avec `npm run gate` et `npm run e2e` verts.
- La CI est verte.
- La recette de Julien est faite.
