# 06 — Mémoire locale : A-I-D porte la capacité `memory` du kernel

## Pourquoi

La chaîne agent-kernel range sa mémoire dans gbrain, sur un Postgres Supabase, avec des
embeddings Voyage distants. Le 2026-10-16, `gbrain doctor` montrait trois sources sur cinq
hors d'état (jamais synchronisée, curseur bloqué, 47 % sans embedding), un binaire en
0.60.249 pour une épingle à 0.57, et des pages de phase lues par slug en entier au prix d'un
aller-retour réseau. Le noyau a décidé (agent-kernel `docs/chantiers/README.md`, 0.9.0) que
la capacité `memory` est portée par **le daemon A-I-D** : SQLite local, pages markdown dans
un dépôt git comme source de vérité, exposition par CLI `aid mem` et MCP, rien qui sorte de
la machine.

Ce chantier livre cette capacité. Il est **indépendant de la v0.2** (statuts, diff) et peut
se faire avant ou en parallèle. Il prépare la v0.3 : « Affiche plan, rayon d'impact,
handoff, review ; en déduit `topic.phase` » (brief §6) devient une lecture locale.

## État actuel

- `src/daemon/db.ts:33-41` : `openDb` ouvre `better-sqlite3` en WAL, `foreign_keys = ON`,
  `busy_timeout = 5000`, puis `migrate` (fichiers `migrations/NNN_*.sql`, `PRAGMA
  user_version`). FTS5 est compilé dans le SQLite embarqué (vérifié : 3.53.4).
- `migrations/001_init.sql` : tables `workspaces`, `topics`, `runs`, `agents`, `actions`,
  `events`. Pas de colonne `namespace` sur `workspaces`.
- `src/daemon/security.ts:11-31` : `Principal` (admin par cookie ou Bearer ; token de run
  `Map<token, runId>`), `issueRunToken`, `revokeRunTokens`. Un token de run n'ouvre que
  `POST /api/events` (`routes/events.ts:38`).
- `src/daemon/server.ts:94-113` : enregistrement des routes et sockets ; modèle à suivre
  pour une nouvelle famille de routes.
- `src/daemon/actions/queue.ts:2` : `WorkspaceQueue`, file d'exécution sérialisée par
  workspace (une par repo pour git). Modèle pour la file de commits du dépôt mémoire.
- `src/shared/slug.ts:1` : `SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/` — slug de **sujet**, à ne
  pas confondre avec le slug de page mémoire (segments séparés par `/`).
- `src/cli/aid.ts:38-94` : `switch (command)` avec import dynamique par commande ; modèle
  pour `mem` et `mcp`.
- `src/cli/commands/doctor.ts:88-92` : table des binaires sondés (`claude`, `codegraph`).
- `src/daemon/config.ts:5-11` : `AidConfig` (`host`, `port`, `editor`, `env`, `terminal`).
- Brief §6 : « Un arbitrage rendu dans A-I-D s'écrit dans la page de plan du sujet (`gbrain
  put`) » et « gbrain pas à la version épinglée = bloquant » — deux lignes à amender après
  ce chantier (point 06.11).
- Poste : Ollama en `/opt/homebrew/bin/ollama`, `qwen3:8b` présent, aucun modèle
  d'embeddings. Node 24.21.

## Cible

- Module `src/daemon/memory/` : store SQLite (pages, FTS5, jobs), miroir markdown
  `~/.aid/memory/` sous git, recherche FTS5 avec vecteurs facultatifs (Ollama + sqlite-vec,
  fusion RRF), file de jobs asynchrones (embed, entretien).
- Routes `/api/memory/*` ; autorisations par namespace pour les tokens de run.
- CLI `aid mem …` et `aid mcp` (serveur MCP stdio) au **contrat** de la section
  « Contrat » ci-dessous.
- `aid doctor` : état de la mémoire.
- UI : panneau « Mémoire » dans la fiche d'un sujet (liste et lecture de ses pages).
- Entretien par modèle local : **propositions** seulement, jamais appliquées sans clic.

Hors périmètre : déduction de `topic.phase` depuis les pages (v0.3) ; réponse à un
arbitrage depuis l'UI (v0.3) ; synchronisation entre deux daemons (le second poste travaille
sur un clone, ou pointe le daemon principal : documenté côté kernel) ; publication npm.

## Contrat `aid mem` (ce chantier en est propriétaire ; le kernel le documente)

| Commande | Effet | Codes de sortie |
| --- | --- | --- |
| `aid mem get <slug>` | Page en markdown (frontmatter YAML puis corps) sur stdout | 0 ; 3 absente ; 4 daemon injoignable |
| `aid mem put <slug> [--title T] [--append \| --expected-revision N \| --force]` | Contenu sur stdin. Création si absente. Page existante sans option : refus `revision_conflict` ; `--append` ajoute à la fin, atomiquement ; `--expected-revision` remplace si la révision correspond ; `--force` remplace. Sortie `{"slug","revision"}` | 0 ; 2 conflit ; 5 interdit ; 4 |
| `aid mem search "<termes>" [--scope <ns>\|all] [--limit N] [--json]` | FTS5, plus vecteurs si disponibles (RRF). `--scope <ns>` = `<ns>` **et** `lesson` ; défaut `all`. Rend slug, titre, extrait, score, et `mode: fts\|hybrid` | 0 ; 4 |
| `aid mem list <prefix> [--json]` | Slugs commençant par `<prefix>` | 0 ; 4 |
| `aid mem rm <slug>` | Supprime la page (fichier supprimé, commité) | 0 ; 3 ; 5 ; 4 |
| `aid mem export --scope <ns>\|all --dir <dir>` | Un `.md` par page, chemin = slug | 0 ; 4 |
| `aid mem import --dir <dir> [--namespace <ns>]` | Slug = chemin relatif sans `.md`, préfixé de `<ns>` s'il est donné ; pages existantes refusées (code 2 par page, bilan en fin) | 0 ; 4 |
| `aid mem reindex` | Reconstruit `memory_pages` et l'index depuis `~/.aid/memory/` | 0 ; 4 |
| `aid mcp` | Serveur MCP stdio : `memory_get`, `memory_put`, `memory_search`, `memory_list` | — |

**Slug de page** : `^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)+$`, 200 caractères au plus,
au moins deux segments. Le premier segment est le **namespace**. `lesson` est le namespace
transverse du kernel.

**Autorisations** : admin (cookie ou Bearer du `daemon.json`) : tout. Token de run : lecture
de tout ; écriture dans le namespace du workspace du run ; écriture dans `lesson/` seulement
si l'agent du run a `role = 'retro'` ; tout autre `put`/`rm` → 403 (CLI : 5).

## Décisions prises

- **DM1 — Source de vérité : les fichiers.** `~/.aid/memory/<slug>.md`, dépôt git initialisé
  par le daemon. SQLite est un index reconstructible (`reindex`). Une écriture passe par la
  base **puis** le fichier, dans cet ordre, sous une file sérialisée ; le commit git est
  différé (2 s, regroupé), message `mem: <slug> r<revision>`. `memory.git.push` (défaut
  `false`) : si `true` et qu'un remote `origin` existe, `git push` après commit, en tâche de
  fond, échec journalisé jamais bloquant.
- **DM2 — Namespace de workspace.** Colonne `workspaces.namespace`, remplie à
  l'enregistrement : `project.namespace` d'un `agent.yml` à la racine si présent, sinon
  slug du nom du repo ; modifiable par `PATCH /api/workspaces/:id`. C'est ce namespace qui
  borne l'écriture des tokens de run.
- **DM3 — Append côté serveur.** `--append` ajoute `\n\n<contenu>` au corps, révision +1,
  dans une transaction. Le kernel en fait le geste normal des pages de phase (incident du
  2026-09-24 : un `--force` qui a effacé un handoff).
- **DM4 — Jamais de modèle sur le chemin d'une requête.** `put` répond dès que base et
  fichier sont écrits. L'embedding et l'entretien sont des jobs (`memory_jobs`) traités par
  un worker du daemon, un à la fois, hors transaction, avec `attempts` et `error`.
- **DM5 — FTS d'abord, vecteurs ensuite.** Le point 06.7 est séparé et derrière
  `memory.embeddings.provider: 'off' | 'ollama'` (défaut `'ollama'` si `ollama` est joignable
  au démarrage, sinon `'off'` et une ligne de journal). Sans vecteurs, `search` rend
  `mode: 'fts'`. Modèle d'embeddings par défaut : `bge-m3` (multilingue). Extension
  `sqlite-vec` chargée par `db.loadExtension`, en `external` dans tsup comme
  `better-sqlite3`.
- **DM6 — MCP par processus séparé.** `aid mcp` est un process stdio qui parle au daemon en
  HTTP : `AID_TOKEN` s'il est dans l'environnement (agent lancé par A-I-D), sinon le token de
  `~/.aid/daemon.json`. A-I-D n'écrit rien dans `~/.claude.json` : la déclaration
  (`claude mcp add … -- aid mcp`) est faite par le bootstrap du kernel.
- **DM7 — Entretien : des propositions.** Le worker peut appeler un modèle local
  (`memory.maintenance.model`, défaut `qwen3:8b`) pour proposer tags, doublons, découpage
  d'une leçon longue (`a_decouper: true`). Résultat dans `memory_proposals`, affiché dans
  le panneau Mémoire avec « Appliquer » / « Rejeter ». **Rien n'est appliqué sans clic.**
  Désactivé par défaut (`memory.maintenance.enabled: false`) : **à valider** par Julien
  avant d'activer sur son poste (D-ouverte 1 ci-dessous).
- **DM8 — Événements.** Un nouveau type `memory.page` (`data: {slug, revision, author,
  op: 'put'|'append'|'rm'}`), `source: 'daemon'`. C'est un ajout à la liste fermée du brief
  §4 : amendement du brief au point 06.11.
- **DM9 — Pas d'écriture directe des fichiers par un agent.** Le repli du kernel (daemon
  arrêté) est la **lecture** de `~/.aid/memory/<slug>.md`. Une écriture faite à la main
  n'est pas indexée ; `reindex` la reprend si elle est commitée, sinon elle est écrasée.
  Documenté côté kernel.

### Décisions ouvertes (à valider par Julien)

| N° | Question | Recommandation |
| --- | --- | --- |
| DO1 | Activer l'entretien par modèle local sur le poste principal ? | Oui, après une semaine d'usage en FTS seul, pour comparer. `memory.maintenance.enabled: true`, fenêtre nocturne `memory.maintenance.window: "02:00-06:00"`. |
| DO2 | Les propositions d'entretien vont-elles dans la boîte de réception (raison `needs_input` nouvelle) ou dans le panneau Mémoire seulement ? | Panneau seulement. La boîte de réception est pour ce qui bloque un sujet ; une proposition de tag ne bloque rien. |
| DO3 | `memory.git.push` activé avec un remote privé dès ce chantier ? | Oui si Julien crée le dépôt privé ; c'est la durabilité hors machine qui remplace Supabase. Le daemon ne crée jamais le remote. |

## Points

Branche : `feat/memoire-locale`, depuis `feat/cli-recette`.

### 06.1 — Schéma et store

Fichiers : `migrations/002_memory.sql`, `src/daemon/memory/slug.ts`,
`src/daemon/memory/store.ts`, `src/shared/memory.ts`, `test/memory-store.test.ts`.

```sql
ALTER TABLE workspaces ADD COLUMN namespace TEXT;             -- DM2, rempli au 06.6
CREATE TABLE memory_pages (
  slug TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  title TEXT NOT NULL,
  frontmatter TEXT NOT NULL,          -- JSON
  body TEXT NOT NULL,
  revision INTEGER NOT NULL,
  author TEXT NOT NULL,               -- 'admin' | 'run:<runId>' | 'import' | 'reindex'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX memory_pages_ns ON memory_pages(namespace, slug);
CREATE VIRTUAL TABLE memory_fts USING fts5(slug UNINDEXED, title, body, tags,
  content='', tokenize='unicode61 remove_diacritics 2');
CREATE TABLE memory_jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('embed','maintain')),
  slug TEXT, state TEXT NOT NULL CHECK (state IN ('pending','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX memory_jobs_pending ON memory_jobs(state, created_at);
```

`memory_fts` est en mode *contentless* : le store l'alimente lui-même (`insert` avec
`rowid` stable = `rowid` de `memory_pages`, suppression par la commande `'delete'`) ; c'est
ce qui rend `reindex` simple.

```ts
// src/shared/memory.ts
export const MEM_SLUG_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/;
export interface MemoryPage { slug: string; namespace: string; title: string;
  frontmatter: Record<string, unknown>; body: string; revision: number; author: string;
  createdAt: string; updatedAt: string }
export interface SearchHit { slug: string; title: string; snippet: string; score: number }
export type PutMode = { kind: 'create' } | { kind: 'append' } | { kind: 'replace'; expectedRevision: number } | { kind: 'force' };
export class RevisionConflict extends Error { constructor(public readonly slug: string, public readonly revision: number) { super('revision_conflict'); } }

// src/daemon/memory/slug.ts
export function isValidMemSlug(slug: string): boolean;         // regex + longueur ≤ 200
export function namespaceOf(slug: string): string;             // premier segment

// src/daemon/memory/store.ts
export function parseMarkdown(text: string): { frontmatter: Record<string, unknown>; body: string; title: string };
export function renderMarkdown(p: Pick<MemoryPage, 'frontmatter' | 'body'>): string;   // frontmatter YAML trié + corps
export class MemoryStore {
  constructor(db: Db);
  get(slug: string): MemoryPage | undefined;
  put(slug: string, text: string, mode: PutMode, author: string, title?: string): MemoryPage;  // transaction ; RevisionConflict
  remove(slug: string): boolean;
  list(prefix: string): string[];
  searchFts(q: string, scope: string | 'all', limit: number): SearchHit[];   // scope ns → WHERE namespace IN (ns, 'lesson')
  all(): Iterable<MemoryPage>;
}
```

`title` : option explicite, sinon premier `# ` du corps, sinon dernier segment du slug.
`tags` indexés = `frontmatter.tags` joints par espace. `searchFts` utilise `bm25()` et
`snippet()`, requête passée en *phrase* par mot (chaque terme entre guillemets) pour
qu'une entrée utilisateur ne soit jamais interprétée comme syntaxe FTS.

Tests : création ; `put` sans option sur page existante → `RevisionConflict` avec la
révision courante ; `append` ajoute en fin et incrémente ; `replace` avec mauvaise révision
→ conflit ; `force` ; slug invalide → erreur nommant la règle ; `searchFts('wal', 'aid')`
trouve une page `aid/…` et une page `lesson/…`, pas une page `autre/…` ; requête avec `"`
ou `*` ne jette pas ; `reindex` d'un store vidé depuis `all()` sérialisé redonne le même
`searchFts`.

Dépendance : `yaml` (déjà présente).

### 06.2 — Miroir fichiers et git

Fichiers : `src/daemon/memory/mirror.ts`, `src/daemon/memory/service.ts`,
`src/daemon/paths.ts` (ajout de `memory: string`), `test/memory-mirror.test.ts`.

```ts
// mirror.ts
export class MemoryMirror {
  constructor(root: string, exec: GitExec, log: Logger);  // GitExec = celui de git/exec.ts
  async init(): Promise<void>;        // mkdir 0700, `git init -q` si pas de .git, .gitignore vide
  async write(slug: string, text: string): Promise<void>;   // écrit <root>/<slug>.md (mkdir -p), 0600
  async remove(slug: string): Promise<void>;
  scheduleCommit(message: string): void;    // debounce 2 s, regroupe ; `git add -A && git commit -q -m`
  async flush(): Promise<void>;             // pour les tests et l'arrêt propre
  async *readAll(): AsyncIterable<{ slug: string; text: string }>;   // pour reindex
  async pushIfConfigured(): Promise<void>;  // DM1
}

// service.ts — l'unique point d'entrée des routes et du worker
export class MemoryService {
  constructor(deps: { store: MemoryStore; mirror: MemoryMirror; events: EventStore; jobs: JobQueue; queue: SerialQueue });
  get(slug): MemoryPage | undefined;
  put(slug, text, mode, principal): Promise<MemoryPage>;   // store.put → mirror.write → scheduleCommit → event memory.page → job embed
  remove(slug, principal): Promise<boolean>;
  list(prefix): string[];
  search(q, scope, limit): Promise<{ mode: 'fts' | 'hybrid'; hits: SearchHit[] }>;  // 'fts' jusqu'au 06.7
  reindex(): Promise<{ pages: number }>;    // vide memory_pages + fts, relit le miroir
  export(scope, dir): Promise<number>;
  import(dir, ns?): Promise<{ imported: number; skipped: string[]; failed: string[] }>;
}
```

`SerialQueue` : une file unique pour toutes les écritures mémoire (réutiliser
`WorkspaceQueue` avec une clé fixe `'memory'` plutôt qu'écrire une nouvelle file).
L'arrêt propre du daemon appelle `mirror.flush()`.

Tests (avec `AID_HOME` temporaire et un vrai `git`) : `put` crée le fichier et, après
`flush`, un commit dont le message contient le slug ; deux `put` en 100 ms → un seul commit ;
`remove` supprime le fichier et commite ; `reindex` depuis un dossier préparé à la main
retrouve les pages, frontmatter compris ; fichier au slug invalide dans le miroir → ignoré
et journalisé, pas d'exception.

### 06.3 — Routes HTTP et autorisations

Fichiers : `src/daemon/routes/memory.ts`, `src/daemon/security.ts` (insertion),
`src/daemon/server.ts` (insertion), `test/memory-routes.test.ts`.

| Route | Admin | Token de run |
| --- | --- | --- |
| `GET /api/memory/pages/*` (slug dans le reste du chemin) | oui | oui |
| `PUT /api/memory/pages/*` body `{ text, mode, title? }` | oui | si namespace autorisé (DM2, rôle `retro` pour `lesson`) |
| `DELETE /api/memory/pages/*` | oui | idem |
| `GET /api/memory/pages?prefix=` | oui | oui |
| `GET /api/memory/search?q=&scope=&limit=` | oui | oui |
| `POST /api/memory/reindex`, `/export`, `/import` | oui | non (403) |

Réponses : `404` absente ; `409 { error: 'revision_conflict', revision }` ; `403 {
error: 'forbidden', namespace }` ; `400` slug invalide (message nommant la règle).

`security.ts` : aujourd'hui un token de run n'ouvre que `POST /api/events`. Insérer une
exception pour `/api/memory/*` et exposer, pour la route, le `runId` du principal ; la
route lit `runs → topics → workspaces.namespace` et `agents.role` (de l'agent du run dont
le token a servi, sinon le premier agent du run) pour décider.

Tests : admin lit, écrit, supprime ; run écrit dans son namespace (200) et dans un autre
(403) ; run avec agent `role: 'retro'` écrit `lesson/x/y` (200), avec `role: 'dev'` (403) ;
`PUT` sans mode sur page existante → 409 avec la révision ; `GET` d'un slug invalide → 400 ;
`reindex` par un token de run → 403 ; l'événement `memory.page` apparaît sur `/ws/events`.

### 06.4 — CLI `aid mem`

Fichiers : `src/cli/commands/mem.ts`, `src/cli/aid.ts` (insertion `case 'mem'`),
`src/cli/client.ts` (client HTTP commun : token de `daemon.json` ou `AID_TOKEN`), `test/cli-mem.test.ts`.

Sous-commandes et codes au contrat. `put` lit **tout stdin** ; refuse un stdin vide (code 1,
« contenu vide : rien à écrire »). `search` en texte : une ligne par résultat
`<score>  <slug>  <titre>` puis l'extrait indenté ; `--json` rend `{ mode, hits }`. Code 4
si le daemon ne répond pas, message « daemon injoignable : lancer `aid` ».

`aid.ts` : ajouter `mem` à `HELP` et au `switch`, import dynamique comme les autres.

Tests (daemon de test en mémoire, comme `cli.test.ts`) : aller-retour `put`/`get` ; `put`
sur existante → code 2 et message `revision_conflict r<N>` ; `--append` → code 0 ; `get`
absente → 3 ; daemon arrêté → 4 ; `search --json` parse ; `list` préfixe.

### 06.5 — Serveur MCP `aid mcp`

Fichiers : `src/cli/commands/mcp.ts`, `src/cli/aid.ts` (insertion `case 'mcp'`),
`test/mcp.test.ts`.

Dépendance : `@modelcontextprotocol/sdk` (transport stdio). Outils :

| Outil | Entrée | Sortie |
| --- | --- | --- |
| `memory_get` | `{ slug }` | texte markdown, ou `isError` « page absente » |
| `memory_put` | `{ slug, text, mode: 'create'\|'append'\|'force', expectedRevision?, title? }` | `{ slug, revision }` ; conflit → `isError` avec la révision |
| `memory_search` | `{ query, scope?, limit? }` | `{ mode, hits }` |
| `memory_list` | `{ prefix }` | `{ slugs }` |

Descriptions d'outils en français, courtes, et qui disent la règle du kernel : « une page
de phase se complète (`append`), elle ne se remplace pas ». Le process ne garde aucun état ;
chaque appel est une requête HTTP au daemon par `client.ts`. Daemon injoignable → `isError`
« daemon injoignable », jamais une exception qui tue le serveur MCP.

Tests : lancer `aid mcp` en sous-process avec le client stdio du SDK contre un daemon de
test ; `tools/list` rend les quatre ; `memory_put` puis `memory_get` ; conflit → `isError`.

### 06.6 — Namespace de workspace, import, export

Fichiers : `src/daemon/routes/workspaces.ts` (insertion : remplissage à la création,
`PATCH /api/workspaces/:id { namespace }`), `src/daemon/git/inspect.ts` (ajout
`readProjectNamespace(root): string | undefined` lisant `project.namespace` d'`agent.yml`
avec `yaml`), `src/cli/commands/mem.ts` (`import`, `export`), `test/workspaces.test.ts`
(insertions), `test/memory-import-export.test.ts`.

Réconciliation au démarrage : un workspace sans `namespace` en reçoit un (même règle) ;
journalisé.

Tests : workspace avec `agent.yml` → namespace du manifeste ; sans → slug du nom ; `PATCH`
invalide (majuscules) → 400 ; `export` puis `import` dans un store vide → mêmes pages,
mêmes frontmatters ; `import` sur pages existantes → bilan `skipped` sans écriture.

### 06.7 — Embeddings Ollama et recherche hybride

Fichiers : `migrations/003_memory_vectors.sql`, `src/daemon/memory/embed.ts`,
`src/daemon/memory/worker.ts`, `src/daemon/memory/service.ts` (insertion dans `search`),
`src/daemon/config.ts` (insertion), `tsup.config.ts` (external `sqlite-vec`),
`test/memory-embed.test.ts`.

```ts
// config.ts — insertion dans AidConfig et DEFAULT_CONFIG
memory: {
  embeddings: { provider: 'off' | 'ollama'; model: string; url: string };   // 'ollama', 'bge-m3', 'http://127.0.0.1:11434'
  maintenance: { enabled: boolean; model: string; window: string };         // false, 'qwen3:8b', '02:00-06:00'
  git: { push: boolean };                                                    // false
}
```

```sql
CREATE VIRTUAL TABLE memory_vectors USING vec0(slug TEXT PRIMARY KEY, embedding float[1024]);
```

(1024 = dimension de `bge-m3` ; la dimension est lue au premier embedding et vérifiée ; un
changement de modèle exige `reindex`, qui recrée la table.)

```ts
// embed.ts
export interface Embedder { embed(texts: string[]): Promise<Float32Array[]>; dimension(): number; ready(): Promise<boolean> }
export function ollamaEmbedder(url: string, model: string): Embedder;
// worker.ts
export class MemoryWorker { constructor(deps); start(): void; stop(): Promise<void>; }  // boucle : job pending → run → done/failed (3 tentatives, backoff 10 s, 60 s, 300 s)
```

`search` : si `provider: 'ollama'` et `ready()`, calcule l'embedding de la requête, prend
les 2×`limit` voisins (`vec_distance_cosine`) et fusionne avec FTS par RRF (k = 60) ;
`mode: 'hybrid'`. Sinon FTS seul, `mode: 'fts'`. Un `put` enfile un job `embed` ; le
`reindex` enfile un job par page.

Au démarrage, si `provider` est `'ollama'` et que `ready()` échoue : passer en `'off'` pour
la session et journaliser une ligne (« ollama injoignable : recherche FTS5 seule »). Ne pas
réessayer en boucle.

Tests : avec un faux `Embedder` déterministe (hash → vecteur) : `put` crée un job, le
worker le passe en `done` et `memory_vectors` a une ligne ; `search` rend `hybrid` et un
résultat sémantiquement proche qui n'a aucun mot commun remonte ; `Embedder.ready()` faux →
`fts` ; échec d'embedding → `failed` après 3 tentatives, le `put` a répondu bien avant.

### 06.8 — `aid doctor`

Fichiers : `src/cli/commands/doctor.ts` (insertions), `test/doctor.test.ts` (insertion).

Lignes ajoutées : `ollama` dans la table des binaires (« la recherche sera FTS5 seule ») ;
si le daemon tourne, `GET /api/memory/health` (nouvelle route admin, 06.3 ou ici) rend
`{ pages: { [ns]: n }, fts: true, vectors: 'ollama'|'off', pendingJobs, failedJobs,
mirrorDirty: boolean }` ; `mirrorDirty` (fichiers non commités dans `~/.aid/memory`) ou
`failedJobs > 0` → ⚠ avec la commande (`aid mem reindex`, ou `aid mem jobs --retry` si
elle est ajoutée, sinon la ligne de journal).

Test : daemon de test avec deux pages → la ligne « mémoire : 2 pages (aid 1, lesson 1) ».

### 06.9 — Panneau « Mémoire » dans la fiche d'un sujet

Fichiers : `web/src/ecrans/…` (le composant de fiche existant), `web/src/ui/Memoire.tsx`,
`web/src/data/memory.ts` (appels `GET /api/memory/pages?prefix=` et `GET
/api/memory/pages/*`), `e2e/memoire.spec.ts`.

Le panneau liste `<namespace du workspace>/*/<slug du sujet>` (plan, dev-handoff, review,
retro) et, au clic, affiche la page **en texte** (pas de rendu markdown en v1 : `<pre>`
avec retour à la ligne ; aucune insertion HTML, règle `react/no-danger`). Révision et date
visibles. Une page absente dit « pas encore écrite ». Rafraîchissement sur événement
`memory.page` dont le slug correspond.

Test e2e : créer un sujet, `aid mem put <ns>/plan/<slug>` par le CLI, le panneau l'affiche
sans recharger.

### 06.10 — Entretien par modèle local (propositions)

Fichiers : `migrations/004_memory_proposals.sql`, `src/daemon/memory/maintain.ts`,
`src/daemon/memory/worker.ts` (insertion kind `maintain`), `src/daemon/routes/memory.ts`
(insertion `GET /api/memory/proposals`, `POST /api/memory/proposals/:id/apply|reject`),
`web/src/ui/Memoire.tsx` (insertion : liste des propositions), `test/memory-maintain.test.ts`.

```sql
CREATE TABLE memory_proposals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('tags','duplicate','split')),
  slug TEXT NOT NULL, payload TEXT NOT NULL, rationale TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','applied','rejected')),
  created_at TEXT NOT NULL, decided_at TEXT
);
```

Trois tâches, chacune un prompt court avec **schéma JSON de sortie** (validé par TypeBox,
réponse non conforme → `failed`, jamais appliquée) :

- `tags` : pour une page sans `tags` — proposer 1 à 5 tags parmi les tags existants du
  namespace d'abord, nouveaux ensuite.
- `duplicate` : pour une nouvelle `lesson/` — comparer aux 5 plus proches (`search`),
  proposer « doublon de <slug> » avec justification.
- `split` : pour une leçon `a_decouper: true` ou de plus de 15 lignes — proposer 2 à 4
  pages atomiques (slug, frontmatter, corps) ; l'application crée les pages et marque
  l'originale `remplacee_par: [...]` sans la supprimer.

Modèle : `POST <ollama>/api/chat` avec `format: 'json'`, `memory.maintenance.model`.
Planification : seulement si `enabled` et dans la fenêtre `window` ; un job `maintain` par
page éligible, 1 à la fois, 20 pages par nuit au plus.

`apply` : exécute la modification par `MemoryService.put` avec `author: 'maintenance'` et
l'événement `memory.page`. `reject` : état `rejected`, la page gagne `entretien_rejete:
[<kind>]` dans son frontmatter pour ne pas être reproposée.

Tests : avec un faux client Ollama rendant un JSON fixe : une page sans tags → une
proposition `open`, rien n'a changé dans la page ; `apply` → tags écrits, révision +1 ;
réponse JSON invalide → job `failed`, aucune proposition ; hors fenêtre → aucun job créé.

### 06.11 — Documentation et brief

Fichiers : `README.md` (section « Où sont les données » : `memory/` ; table des commandes :
`aid mem`, `aid mcp`), `brief.md` §6 (deux lignes **remplacées** : « s'écrit dans la page
de plan du sujet (`aid mem put --append`) » et « A-I-D porte la capacité `memory` du kernel
depuis agent-kernel 0.9.0 ; un kernel qui déclare encore gbrain est signalé dans la santé
machine »), `brief.md` §4 (insertion de `memory.page` dans les types v1 — DM8),
`docs/chantiers/README.md` (insertion d'une section « Chantiers hors v0.1 »).

Vérification : `npm run gate` vert ; `grep -n gbrain brief.md README.md` ne rend que la
phrase de transition du §6.

## Pièges

- **Deux regex de slug.** `SLUG_RE` (sujet, 48 caractères, sans `/`) et `MEM_SLUG_RE`
  (page, segments). Ne jamais réutiliser l'une pour l'autre ; le sujet `<task>` est le
  dernier segment de la page de phase.
- **FTS5 et la syntaxe de requête.** `"` non fermée, `*`, `NEAR`, `-` sont interprétés.
  Toujours construire la requête en termes cités : `"mot1" "mot2"`, et `OR` entre eux si
  l'on veut du rappel. Tester avec des entrées hostiles.
- **Contentless FTS.** Avec `content=''`, la suppression doit passer par la commande
  spéciale `INSERT INTO memory_fts(memory_fts, rowid, title, body, tags) VALUES('delete', …)`
  avec **les mêmes valeurs** que l'insertion ; d'où le `reindex` plutôt que de jongler.
- **`sqlite-vec` est un module natif.** `external` dans tsup, comme `better-sqlite3` et
  `node-pty` (fait de `stack` du manifeste). Sous Linux et WSL2, prébuild disponible ; sinon
  le daemon démarre avec `provider: 'off'` et le dit, il ne plante pas.
- **Dimension des vecteurs.** Changer de modèle sans `reindex` mélange des espaces
  incompatibles : stocker `model` et `dimension` dans une table `memory_meta` et refuser
  d'embarquer si ça ne correspond pas.
- **Jamais Ollama dans une requête HTTP.** Même `search` : l'embedding de la requête est un
  appel court (quelques dizaines de ms), accepté ; mais si `ready()` est faux, ne pas
  attendre un timeout à chaque recherche — mémoriser l'indisponibilité 60 s.
- **Commit git et worktrees.** `~/.aid/memory` est un dépôt **séparé** des repos des
  workspaces : jamais de `git` lancé dans un worktree pour la mémoire. Utiliser
  `git -C <root>` explicitement.
- **Transactions courtes.** `store.put` est une transaction synchrone `better-sqlite3` ;
  l'écriture fichier et le commit sont **après**, hors transaction. Ne rien `await` dans
  `db.transaction`.
- **Un seul écrivain.** Les tests n'ouvrent jamais `state.db` par une seconde connexion
  pour écrire. Lire par une seconde connexion est acceptable (WAL).
- **Les agents ne touchent pas aux fichiers.** Si un test est tenté d'écrire dans
  `~/.aid/memory` pour préparer un cas, il passe par `MemoryMirror` puis `reindex`.
- **Pas de `claude` ni `codex` dans les tests** (règle du dépôt). Le serveur MCP se teste
  avec le client stdio du SDK.
- **Texte d'une page dans l'UI** : `<pre>`, jamais `dangerouslySetInnerHTML`.

## Fini quand

- `npm run gate` et `npm run gate:e2e` verts, sous Node 22 et 24.
- Depuis un worktree de sujet, un agent lancé par A-I-D (`AID_TOKEN`) fait
  `echo "## Plan" | aid mem put <ns>/plan/<slug>` puis `aid mem put … --append`, et
  `aid mem get` rend les deux sections ; le même agent échoue en 5 sur `lesson/x/y`.
- Depuis le shell : `aid mem search "concurrence sqlite" --scope <ns>` trouve une page
  `lesson/…` ; `mode` est `hybrid` si Ollama tourne, `fts` sinon, et `aid doctor` le dit.
- `~/.aid/memory` a un commit par rafale d'écritures ; `aid mem reindex` depuis un clone de
  ce dépôt sur un autre `AID_HOME` redonne les mêmes résultats de recherche FTS.
- `claude mcp list` (déclaré par le bootstrap du kernel) montre `aid-memory`, et une
  session Claude Code voit les quatre outils.
- Le panneau Mémoire d'un sujet affiche sa page de plan dès qu'elle est écrite.
- Aucune proposition d'entretien n'a modifié une page sans clic.
