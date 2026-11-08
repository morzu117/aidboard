# Chantier 38 : la chronologie d'une carte du board

| Champ | Valeur |
|---|---|
| État | **Révision 0, 8 novembre 2026.** Julien a retenu Q1 à Q4 de la spec. La spec a été envoyée au lab pour relecture (DM 92559). Rien n'est construit. |
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
- `BoardStep.priorRows` : le nombre d'identifiants dans `prior_rows`.

### D237. La fonction `chronologie`

`chronologie({ card, graph, thread })` est une fonction pure, dans `web/src/data/chronologie.ts`. Elle prend les trois `BoardResult` et renvoie :
- `{ entrees, limites }` ;
- `entrees` : `{ cle, date, source: 'etape' | 'obligation' | 'fil', auteur, texte }[]`, triées par date décroissante. Les entrées sans date ou à date illisible vont à la fin, dans l'ordre reçu. Le tri est stable ;
- les phrases de la spec : « Étape → build », « (déduite par le gateway, ligne N) », puis pour les obligations « Obligation <step> ouverte pour <holder> », « prise », « modifiée », « fermée : <outcome> », et « événement <kind> » pour une sorte inconnue. Pour le fil, les 140 premiers caractères du message, suivis de « … » si le message est coupé ;
- `limites` : `fil-limite` si `capped`, `{ lignesAnterieures: N }` si N > 0, et `non-lu: 'etapes' | 'obligations' | 'fil'` pour chaque lecture en échec.

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

### 38.2 La fonction `chronologie` (D237)

`web/src/data/chronologie.ts`. Tests dans `test/web/chronologie.test.ts` :
- le tri, avec les dates égales et les entrées sans date ;
- chaque phrase, y compris une sorte inconnue ;
- la coupe à 140 caractères ;
- chaque limite ;
- une lecture en échec n'empêche pas le reste.

### 38.3 Le bloc « Chronologie » (D238)

`web/src/ecrans/CarteBoard.tsx`, et la mise à jour de `test/web/carte-board.test.tsx` là où l'historique était vérifié. Tests :
- les filtres ;
- l'ordre affiché ;
- un `detail` ou un message contenant `<img src=x onerror=alert(1)>` n'est affiché qu'en texte ;
- les limites.

### 38.4 L'e2e et la fiche de recette

- `e2e/board.spec.ts` : la chronologie de la carte de test, les filtres, et le pied de liste quand le fil est limité.
- La fiche `docs/recette-chantier-38-chronologie.md`, pour Julien : sur son board réel, ouvrir une carte et comparer la chronologie au fil et aux obligations.

## 6. Pièges

- Le `detail` est une chaîne JSON qui vient d'un pair : il ne s'affiche jamais en brut.
- Les dates du gateway ont des microsecondes et un fuseau : `Date.parse` les lit. Une date illisible part en fin de liste, sans faire échouer le reste.
- Le fil peut faire 1000 messages : le tri doit rester linéaire en mémoire, et le rendu ne doit pas bloquer. Un simple tri suffit.

## 7. Fini quand

- 38.1 à 38.4 sont commités, avec `npm run gate` et `npm run e2e` verts.
- La CI est verte.
- La recette de Julien est faite.
