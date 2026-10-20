# 08 — Index structurel : A-I-D porte la capacité `structural_index` du kernel

Branche : `feat/index-structurel`, depuis `main`.

## 1. Pourquoi

Direction prise le 2026-10-17 (agent-kernel, `docs/analyse-indexation-code-2026-10-17.md`
§9-10) : A-I-D est le centre, `aid mem` le socle commun de mémoire, et agent-kernel finira
en module d'aidboard. Le kernel nomme deux rôles, `memory` et `structural_index`
(`policy/routing.md`). Le chantier 06 a fait porter `memory` par le daemon. Ce chantier
fait la même chose pour `structural_index` : aujourd'hui le daemon ne connaît que la
*commande* `codegraph init`, et tout le reste de l'usage (explore, impact, affected) passe
par un serveur MCP tiers que chaque agent installe de son côté. Le moteur est donc soudé au
produit à trois endroits différents, sans état lisible par le board ni par `aid doctor`.

Le dossier conclut aussi que codegraph n'est pas définitif : Kivgraph (graphe fondé sur le
type-checker) mérite un banc d'essai sur myskooli, et les angles morts mesurés (Prisma :
2 148 sites `prisma.<modèle>.<op>` sans arête, chaîne HTTP partielle, homonymes fusionnés)
appellent des extracteurs maison. Tout cela n'est faisable proprement que si le daemon
parle à un **contrat** et non à un binaire : un adaptateur par moteur, un seul point
d'exposition (HTTP, MCP, board), une seule règle de dégradation.

Ce que ce chantier n'est pas : un pont mémoire ↔ code (table de liens, extracteurs
Prisma/HTTP) — chantier suivant ; ni l'absorption d'agent-kernel — chantier d'après.

## 2. État actuel

- `src/daemon/server.ts:43` — `codegraphBin?: string` dans `ServerDeps` ; `:118` et `:124`
  le passent avec repli `'codegraph'` à l'`Indexer` et aux routes sujets.
- `src/daemon/topics/index.ts:33` — `spawn(codegraphBin, ['init', '-y', topic.worktree])`,
  journal `<logs>/<topicId>-index.log`, délai 15 min, événement `topic.state`
  `{ indexState: 'ready' | 'failed' }`. Seule commande du moteur connue du daemon.
- `src/daemon/routes/topics.ts:105` — D6 : `existsSync(join(ws.root, '.codegraph'))` décide
  `indexing` ou `disabled` ; `:398` et `:485` exportent `AID_CODEGRAPH_BIN` aux scripts.
- `src/daemon/git/inspect.ts:14,42` — `RepoInfo.hasCodegraph`, même test de présence.
- `src/cli/commands/doctor.ts:96` — sonde binaire `codegraph` → « les sujets seront sans
  index : lecture directe ». Pas de version, pas d'état d'index.
- `src/shared/model.ts:5,77` — `IndexState = 'disabled' | 'indexing' | 'ready' | 'failed'`,
  seul champ d'index du `Topic`. Rien sur le moteur, la fraîcheur, la couverture.
- `src/cli/commands/mcp.ts` — serveur MCP `aid-memory`, quatre outils `memory_*`, chaque
  appel une requête HTTP par `client.ts`. Modèle à suivre pour les outils d'index.
- `src/daemon/config.ts:66` — `rejectUnknown(doc, ['host','port','editor','env','terminal','memory'])` :
  toute nouvelle clé doit être déclarée là **et** avoir son `parseX`.
- `test/fixtures/fake-codegraph.sh` — ne connaît que `init -y` et `FAKE_CODEGRAPH_EXIT`.
- `CLAUDE.md` / `AGENTS.md:171-202` — bloc `structural_index — codegraph` : plan → `impact`,
  dev → `explore`, review → `affected`. C'est l'usage réel à couvrir par le contrat.
- CLI codegraph 1.6.0 (épinglée par le bootstrap du kernel ; 1.6.2 publiée le 3 oct 2026) :
  `impact`, `callers`, `affected`, `query`, `status` ont `--json` ; `explore` et `node`
  n'ont **que** du texte. `status --json` donne `lastIndexed`, `fileCount`, `languages`,
  `pendingChanges`, `worktreeMismatch`, `index.builtWithVersion`, `index.state`.
- Le dépôt aidboard lui-même n'a pas de `.codegraph/` : ses propres sujets naissent
  `disabled` (D6).

## 3. Cible et hors-périmètre

Cible : une capacité `structural` du daemon, derrière un contrat `StructuralIndex`, avec un
premier adaptateur `codegraph` qui reprend exactement ce que le daemon et les agents font
déjà. Exposée en HTTP (`/api/structural/*`), en MCP (outils `index_*` dans `aid mcp`), dans
`aid doctor` et dans l'état du board (moteur, fraîcheur, langages). Un second adaptateur
peut être branché par configuration sans toucher aux routes, au MCP ni au board : c'est ce
qui rend le banc Kivgraph possible.

Hors périmètre : second adaptateur réel (Kivgraph) ; extracteurs Prisma/HTTP ; table de
liens mémoire ↔ symboles dans `aid mem` ; écran dédié dans le web (seul l'état minimal
remonte dans `CarteSujet`) ; indexation incrémentale pilotée par le daemon (`sync` reste à
l'initiative des hooks git du moteur) ; remplacement du serveur MCP `codegraph` installé
chez les agents (il reste utilisable en parallèle le temps de la transition).

## 4. Décisions prises

- **DS1 — Un contrat, des adaptateurs.** `StructuralIndex` est une interface TypeScript du
  daemon ; `codegraph` en est la première implémentation, par sous-process du binaire
  injecté (`deps.codegraphBin` devient `config.structural.bin`). Aucune route, aucun outil
  MCP, aucun écran n'importe un adaptateur directement.
- **DS2 — Portée = worktree.** Chaque appel vise un chemin de projet (racine du workspace
  ou worktree du sujet). Un token de run ne peut viser que le worktree de son sujet ;
  l'admin vise ce qu'il veut par `?topic=` ou `?workspace=`. Même logique que `runWriteContext`
  (06.3), en lecture seule.
- **DS3 — Provenance explicite.** Toute relation rendue porte `provenance: 'exact' |
  'candidate' | 'heuristic'`. codegraph rend `candidate` pour ce qu'il lit dans l'arbre
  syntaxique (appels, imports, héritage — tree-sitter, pas de types) et `heuristic` pour ce
  qu'il synthétise par convention (liens client HTTP → nœud `route`, résolution par nom
  quand le symbole est ambigu) ; un moteur fondé sur le type-checker rendra `exact`. La
  valeur est posée par l'adaptateur, jamais par le service ; le board et les descriptions
  MCP distinguent les trois.
- **DS4 — Dégradation déclarative, jamais d'exception.** Index absent, binaire introuvable,
  délai dépassé → `status.state = 'unavailable'` avec `reason`, et les outils MCP rendent
  `isError` « index indisponible : lecture directe » (le texte de `routing.md`). Le daemon ne
  tombe jamais à cause du moteur.
- **DS5 — Rien de dérivable dans `aid mem`.** L'index est reconstruisible, local au
  worktree, jamais versionné ni exporté. Ce chantier n'écrit **aucune** page mémoire. La
  règle du kernel (« si c'est dérivable du code, ça n'a rien à faire dans la couche
  décisionnelle ») reste vraie même avec une surface MCP unique.
- **DS6 — `explore` reste un texte opaque.** codegraph ne le sert qu'en texte ; le contrat
  l'expose comme `{ text }` et ne tente pas de le parser. Les appels structurés
  (`impact`, `callers`, `affected`, `symbols`, `status`) passent par `--json`.
- **DS7 — L'état d'index n'est pas stocké.** Comme D16 pour git : moteur, `indexedAt`,
  `languages`, `stale` sont relus en direct (`status --json`, borné par un cache mémoire de
  30 s par chemin) à chaque `GET /api/state`. `Topic.indexState` garde ses quatre valeurs.
- **DS8 — Jamais de modèle sur le chemin de requête** (DM4 du chantier 06). Pas de
  résumé LLM des résultats côté daemon.
- **DS9 — Le moteur ne s'installe pas tout seul.** Pas de `codegraph upgrade`, pas de
  `install` : `aid doctor` constate et conseille.
- **DS10 — Le serveur MCP s'appelle `aid`.** Il s'appelait `aid-memory` (06.5), nom que les
  agents ont enregistré ; garder ce nom pour des outils d'index serait trompeur. Renommé
  `aid` (`McpServer({ name: 'aid' })`), et `aid doctor` avertit si la configuration Claude
  Code (`~/.claude.json`) pointe encore `aid-memory`. Les enregistrements existants cassent
  une fois ; c'est accepté (décidé le 2026-10-17).
- **DS11 — Le daemon relance le moteur à son démarrage** (08.8, demandé le 2026-10-20). Sur
  chaque sujet vivant (`active`, `review`) dont le worktree existe : `sync` si le worktree a
  déjà son index, `init` s'il est `disabled` mais que le dépôt principal a adopté l'index
  depuis (D6 appliquée après coup — c'est ce qui manquait à `a-i-d`, indexé après la création
  de ses sujets). Un sujet à la fois, en tâche de fond après `listen`, jamais bloquant.
  Entre deux démarrages, `sync` reste à l'initiative des hooks git du moteur (§3).

Ce que l'exécutant ne décide pas : le nom des outils MCP ci-dessous, le nom de la clé de
config `structural`, la portée d'un token de run.

Décisions ouvertes (à valider par Julien) :

- **DO1 — Un index par worktree ou par workspace.** Aujourd'hui chaque sujet relance un
  `init` complet (myskooli : 106 Mo, ~1 500 fichiers). Partager l'index du dépôt principal
  et `sync` dans le worktree serait moins coûteux mais codegraph expose un
  `worktreeMismatch` : à mesurer avant de décider. Ce chantier garde un index par worktree.
- **DO2 — `dist/` dans l'index.** Sur myskooli, `apps/api/dist/` est indexé. Si codegraph
  ne lit pas de liste d'exclusion, le contrat prévoit `config.structural.exclude` passé à
  l'adaptateur, qui le fera respecter comme il peut (filtre des résultats au pire).

## 5. Contrat

```ts
// src/shared/structural.ts
export type Provenance = 'exact' | 'candidate' | 'heuristic';
export type IndexEngine = 'codegraph' | 'off';           // 'kivgraph' au banc, plus tard
export interface SymbolRef { name: string; kind: string; file: string; line: number }
export interface Relation { from: SymbolRef; to: SymbolRef; kind: 'calls' | 'imports' | 'extends' | 'references'; provenance: Provenance }
export interface IndexStatus {
  engine: IndexEngine; state: 'ready' | 'indexing' | 'stale' | 'unavailable';
  reason?: string;                       // state unavailable
  indexedAt: string | null; files: number; symbols: number; languages: string[];
  pending: number;                       // fichiers modifiés depuis indexedAt
  engineVersion: string | null; builtWith: string | null;   // décalage CLI / index
  capabilities: Capability[];
}
export type Capability = 'explore' | 'symbols' | 'callers' | 'impact' | 'affected' | 'types';

// src/daemon/structural/types.ts
export interface StructuralIndex {
  readonly engine: IndexEngine;
  detect(root: string): boolean;                             // remplace hasCodegraph
  init(root: string, log: number): ChildProcess;             // ce que fait Indexer.start
  status(root: string): Promise<IndexStatus>;
  explore(root: string, query: string, opts?: { maxFiles?: number }): Promise<{ text: string }>;
  symbols(root: string, q: string, opts?: { kind?: string; limit?: number }): Promise<SymbolRef[]>;
  callers(root: string, symbol: string, limit?: number): Promise<Relation[]>;
  impact(root: string, symbol: string, depth?: number): Promise<{ affected: SymbolRef[]; provenance: Provenance }>;
  affected(root: string, files: string[]): Promise<{ tests: string[] }>;
}
```

Correspondance codegraph : `detect` → `.codegraph/` présent ; `init` → `init -y` ;
`status` → `status --json` (`pending` = somme de `pendingChanges`, `stale` si > 0,
`builtWith` = `index.builtWithVersion`) ; `explore` → `explore --max-files` ; `symbols` →
`query -j -k -l` ; `callers` → `callers -j -l` ; `impact` → `impact -j -d` ; `affected` →
`affected -j --stdin`. Délai par appel 60 s, `cwd = root`, `--path root` explicite.
Capacités déclarées : toutes sauf `types`.

Limites connues exposées, pas cachées : `callers` fusionne les homonymes (le résultat
rend les occurrences telles quelles, `provenance: 'candidate'`) ; les liens vers les nœuds
`route` synthétisés par codegraph sortent en `provenance: 'heuristic'` (DS3) ; pas d'arête
pour `prisma.<modèle>.<op>` ni pour la chaîne complète `hook → api-client → fetch → route`
(documenté dans la description des outils MCP, c'est le chantier des extracteurs qui
comblera).

## 6. Points

### 08.1 — Contrat et adaptateur codegraph

Fichiers : `src/shared/structural.ts`, `src/daemon/structural/types.ts`,
`src/daemon/structural/codegraph.ts`, `src/daemon/structural/exec.ts` (sous-process avec
délai, stdout borné 4 Mo, `--path`), `test/fixtures/fake-codegraph.sh` (étendu),
`test/structural-codegraph.test.ts`.

Le faux binaire répond à `status --json`, `query -j`, `callers -j`, `impact -j`,
`affected -j --stdin` par des fichiers de `test/fixtures/codegraph/*.json`, à `explore` par
un texte fixe, et garde le comportement `init -y` / `FAKE_CODEGRAPH_EXIT`. `init` fait
toujours `exit 0` pour une commande inconnue, les tests existants ne bougent pas.

Tests : `detect` ; `status` sur fixture → `ready`, `languages`, `builtWith` ; fixture avec
`pendingChanges` → `stale` ; binaire absent → `unavailable` + `reason` ; délai dépassé
(fixture `FAKE_CODEGRAPH_SLEEP`) → `unavailable`, le process est tué ; `impact` rend des
`SymbolRef` typés avec `provenance: 'candidate'` ; sortie JSON invalide → `unavailable`,
jamais d'exception. Vérification : `npm run gate`.

### 08.2 — Service, registre et branchement de l'existant

Fichiers : `src/daemon/structural/service.ts` (`StructuralService` : choix du moteur par
config, cache de `status` 30 s par chemin, résolution de portée DS2), `src/daemon/server.ts`
(insertion : `structural?: StructuralService`, `codegraphBin` retiré de `ServerDeps` au
profit du service), `src/daemon/main.ts` (construction depuis la config ; `opts.codegraphBin`
reste accepté en test et devient `config.structural.bin`), `src/daemon/topics/index.ts`
(`Indexer` reçoit `engine.init` au lieu de `codegraphBin`), `src/daemon/routes/topics.ts`
(`engine.detect(ws.root)` à la place d'`existsSync` ; `AID_CODEGRAPH_BIN` conservé pour les
scripts, alimenté par `config.structural.bin`), `src/daemon/git/inspect.ts`
(`hasCodegraph` → `hasStructuralIndex`, calculé par le service), `test/helpers/daemon.ts`,
`test/helpers/topics.ts`, `test/helpers/git.ts` (adaptations minimales).

Tests existants (`topic-create`, `topic-cleanup`, `doctor`) verts sans changement de
scénario ; `engine: 'off'` → sujets `disabled`, `Indexer` jamais appelé ; portée : un run
visant un autre sujet → 403 `{ error: 'forbidden', topic }`. Vérification : `npm run gate`.

### 08.3 — Configuration et `aid doctor`

Fichiers : `src/daemon/config.ts` (clé `structural` : `engine: 'codegraph' | 'off'`
(défaut `codegraph`), `bin` (défaut `codegraph`), `timeoutMs`, `exclude: string[]` ; liste
`rejectUnknown` et modèle `DEFAULT_FILE` mis à jour), `src/cli/commands/doctor.ts`
(`Probes.structural(): Promise<IndexStatus | null>` via `GET /api/structural/status?workspace=`
sur le premier workspace ; la sonde binaire actuelle affiche en plus la version et signale
un décalage CLI / index, ex. « CLI 1.6.0, index bâti par 1.6.2 : reindex conseillé » ;
nouvelle sonde `Probes.mcpRegistration()` qui lit `~/.claude.json` et avertit « serveur MCP
enregistré sous `aid-memory` : ré-enregistrer sous `aid` » (DS10)), `test/config.test.ts`,
`test/doctor.test.ts` (insertions).

Tests : clé inconnue `structural.foo` → `ConfigError` nommant la clé ; `engine: 'kivgraph'`
→ erreur « moteur inconnu (disponibles : codegraph, off) » ; doctor daemon arrêté →
ligne `warn` sans plantage ; `~/.claude.json` de fixture avec `aid-memory` → ligne `warn`
nommant le bon nom. Vérification : `npm run gate`.

### 08.4 — Routes HTTP

Fichiers : `src/daemon/routes/structural.ts`, `src/daemon/server.ts` (insertion),
`src/daemon/security.ts` (exception lecture `/api/structural/*` pour un token de run,
comme `/api/memory/*`), `test/structural-routes.test.ts`.

| Route | Admin | Token de run |
| --- | --- | --- |
| `GET /api/structural/status?topic=\|workspace=` | oui | son sujet seulement |
| `GET /api/structural/explore?q=&maxFiles=` | oui | idem |
| `GET /api/structural/symbols?q=&kind=&limit=` | oui | idem |
| `GET /api/structural/callers?symbol=&limit=` | oui | idem |
| `GET /api/structural/impact?symbol=&depth=` | oui | idem |
| `POST /api/structural/affected` body `{ files }` | oui | idem |
| `POST /api/structural/reindex?topic=` | oui | non (403) |

Réponses : `503 { error: 'index_unavailable', reason }` quand `state = 'unavailable'` ;
`400` paramètre manquant ; `404` sujet inconnu. Schémas TypeBox comme les routes mémoire.
`reindex` relance `Indexer.start` et repasse le sujet en `indexing`.

Tests : admin lit l'état d'un workspace et d'un sujet ; run lit son sujet (200), un autre
(403) ; moteur `off` → 503 avec `reason` ; `reindex` par un run → 403 ; `reindex` admin
→ événement `topic.state { indexState: 'indexing' }` puis `ready` avec le faux binaire.
Vérification : `npm run gate`.

### 08.5 — Outils MCP `index_*`

Fichiers : `src/cli/commands/mcp.ts` (insertion), `test/mcp.test.ts` (insertion).

| Outil | Entrée | Sortie |
| --- | --- | --- |
| `index_status` | `{}` | `IndexStatus` du sujet du run (admin : premier workspace) |
| `index_explore` | `{ query, maxFiles? }` | texte du moteur |
| `index_symbols` | `{ query, kind?, limit? }` | `SymbolRef[]` |
| `index_callers` | `{ symbol, limit? }` | `Relation[]` |
| `index_impact` | `{ symbol, depth? }` | `{ affected, provenance }` |
| `index_affected` | `{ files }` | `{ tests }` |

Descriptions en français, courtes, qui disent la règle du kernel : « plan → `impact`, dev →
`explore`, review → `affected` ; le résultat est dérivé du code, il ne se note pas en
mémoire ». Index indisponible → `isError` « index indisponible : lecture directe ». Le
serveur est renommé `aid` (DS10) dans le même point : `McpServer({ name: 'aid' })`, et
l'aide de `aid mcp` / le README donnent la commande d'enregistrement
`claude mcp add --scope user aid -- aid mcp`.

Tests : `tools/list` rend les quatre `memory_*` et les six `index_*` sous le serveur `aid` ;
`index_status` sur faux binaire ; moteur `off` → `isError` au texte exact ; daemon arrêté
→ `isError` inchangé. Vérification : `npm run gate`.

### 08.6 — État du board

Fichiers : `src/shared/model.ts` (ajout sur `Topic` : `index: { engine, indexedAt, stale,
languages } | null`, relu en direct, DS7), `src/daemon/routes/state.ts` (insertion),
`web/src/ecrans/CarteSujet.tsx` (pastille : moteur + « à jour / N fichiers en retard /
indisponible »), `test/state.test.ts` (insertion).

Tests : sujet `ready` → `index.engine = 'codegraph'` ; faux binaire avec `pendingChanges` →
`stale: true` ; moteur `off` → `index: null` et `indexState: 'disabled'`. Vérification :
`npm run gate`.

### 08.7 — Documentation et prérequis du banc

Fichiers : `CLAUDE.md`, `AGENTS.md` (bloc `structural_index` : outils `index_*` à la place
de l'usage direct du MCP codegraph, qui reste toléré), `docs/chantiers/README.md` (ligne 08
dans le tableau §9, risque « daemon codegraph orphelin » complété par « un `reindex` admin
par sujet »), `docs/structural-engines.md` (nouveau : ce qu'un second adaptateur doit
fournir pour entrer au banc — `detect`, `init`, `status`, `explore` au minimum ; les
capacités manquantes se déclarent ; métrique du banc = « coût à tâche terminée », pas
tokens par réponse).

Pas de test ; vérification : `npm run gate` (lint markdown inclus s'il y en a un).

### 08.8 — Rattrapage de l'index au démarrage du daemon

Fichiers : `src/daemon/structural/types.ts` et `codegraph.ts` (`sync(root, log)` :
`codegraph sync -q <chemin>`, même cycle de vie que `init`), `src/daemon/structural/service.ts`
(`sync`), `src/daemon/topics/index.ts` (`init`/`sync` rendent une promesse `ready | failed`,
`start` reste l'appel ignoré des routes ; le descripteur du journal est fermé à la fin),
`src/daemon/topics/rattrapage.ts` (nouveau : `rattraperIndex`, DS11), `src/daemon/main.ts`
(construit l'`Indexer`, le passe à `buildServer`, lance le rattrapage après `listen` comme
`resumeFromManifest`), `src/daemon/server.ts` (`deps.indexer` facultatif),
`test/fixtures/fake-codegraph.sh` (`sync` dépose `.codegraph/synced`),
`test/structural-rattrapage.test.ts` (nouveau).

Tests : worktree indexé → `indexing` puis `ready` et marqueur déposé, sans `init` ; sujet
`disabled` dont le dépôt principal gagne `.codegraph/` → `init` au redémarrage, `ready` ;
`sync` en échec → `failed` ; moteur `off` → aucun événement ; sujet sans index ni dépôt
indexé, ou worktree disparu → ignoré. Vérification : `npm run gate`.

## 7. Pièges

- Le bootstrap d'agent-kernel enregistre encore l'ancien nom
  (`scripts/bootstrap-machine.sh` : `claude mcp add --scope user aid-memory -- aid mcp`) :
  à passer à `aid` dans le même temps que 08.5, sinon `aid doctor` avertira sur chaque
  machine fraîchement amorcée.
- `explore` n'a pas de `--json` : ne pas inventer un parseur de son texte, il changera.
- `explore` et `--json` sur `impact`/`callers` sont récents : lire la version au premier
  `status` et déclarer la capacité absente (pas `unavailable` global) sous 1.6.0, plutôt
  que de parser une erreur d'usage.
- `status --json` peut annoncer `builtWithVersion` > version CLI (vu sur myskooli : index
  bâti par 1.6.2, CLI 1.6.0). Ce n'est pas une erreur, c'est à afficher.
- Daemon codegraph orphelin (`.codegraph/daemon.pid`) : le registre de risques du README
  s'applique ; `reindex` doit d'abord tuer ce pid comme le script de nettoyage.
- `rejectUnknown` : oublier la clé dans la liste racine fait échouer **tout** le démarrage
  avec une config existante qui l'aurait déjà.
- `worktreeMismatch` non nul dans `status` : l'index a été copié d'un autre chemin ;
  rendre `stale` avec `reason`, ne pas réindexer d'office.
- Sortie `impact` sur un gros symbole : borner la lecture stdout (4 Mo) et rendre
  `unavailable` au-delà, plutôt qu'un JSON tronqué.
- Ne jamais lancer `codegraph` réel dans les tests : le faux binaire ou rien.

## 8. Fini quand

- Un sujet créé sur un workspace indexé passe `indexing → ready` sans qu'aucun fichier hors
  `src/daemon/structural/` ne nomme `codegraph` autrement que comme valeur de `engine`.
- `aid mcp` s'annonce comme serveur `aid` et expose `index_*` et `memory_*` ; Claude Code
  configuré sur ce seul serveur obtient `impact`, `explore`, `affected` sur le worktree de
  son sujet, et un message de dégradation lisible quand l'index manque.
- `aid doctor` affiche moteur, version, état du premier workspace, le décalage CLI / index,
  et avertit si `~/.claude.json` enregistre encore `aid-memory`.
- `GET /api/state` porte `index` par sujet ; `CarteSujet` l'affiche.
- `config.yaml` avec `structural.engine: off` donne un daemon sans aucune trace du moteur.
- Un daemon redémarré sur des sujets indexés les repasse `indexing → ready` sans action
  humaine ; un sujet `disabled` d'un dépôt indexé depuis se met à jour de même (08.8).
- `npm run gate` vert ; aucune page `aid mem` écrite par le chantier.
- README §9 liste le chantier 08 avec sa base, sa dépendance (06) et ce qu'il prépare
  (pont mémoire ↔ code, banc Kivgraph).
