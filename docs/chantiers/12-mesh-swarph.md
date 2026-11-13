# 12 — Mesh swarph : connecter ce Mac au mesh de peer-a depuis A-I-D

Branche : `feat/mesh-swarph`, depuis `main`.

## Index structurel : disponible depuis le 2026-10-20

Le plan a été rédigé le 2026-10-19 sans index (`.codegraph/` absent du worktree, MCP
`codegraph` injoignable) ; l'« État actuel » ci-dessous venait d'une lecture directe. Le
2026-10-20, la branche a été rebasée sur `main` (v0.2.2, après le chantier 13) et l'index
interrogé (`codegraph_explore`, provenance `candidate`, tree-sitter). Rayon d'impact des
symboles que les points touchent :

- `agentCommand`, `agentEnv`, `SpawnKind` (`src/daemon/pty/spawn.ts`) → `AgentManager.spawn`
  et `src/daemon/pty/reprise.ts` ; test `test/pty-spawn.test.ts`.
- `EVENT_SOURCES`, `EVENT_TYPES` (`src/shared/events.ts`) → `src/cli/commands/emit.ts`,
  `src/daemon/events/admit.ts` ; aucun test à moins de trois sauts — le test de 12.1 en est
  le premier.
- `StateSnapshot` (`src/shared/state.ts`) → 22 appelants : `src/cli/commands/status.ts`,
  `src/daemon/state/snapshot.ts`, `web/src/data/client.ts` ; tests `state`, `agents-routes`,
  `topic-create`, `topic-fetch` et 8 autres. Le champ `mesh` est optionnel pour ne rien y
  casser.
- `AgentKind` (`src/shared/model.ts`) → `Agent.kind` ; testé via `test/agents-routes.test.ts`,
  `test/web/boite.test.tsx` et 3 autres.
- `registerAgentRoutes` (`src/daemon/routes/agents.ts`) → `src/daemon/server.ts` ; test
  `test/securite.test.ts`.
- `AgentManager` (`src/daemon/pty/manager.ts`) → `reprise.ts`, `routes/agents.ts`,
  `ws/pty.ts`, `main.ts` (14 appelants) ; test `test/securite.test.ts`.
- `loadConfig` / `parseConfig` (`src/daemon/config.ts`) → `src/cli/commands/doctor.ts`,
  `src/daemon/main.ts` ; test `test/config.test.ts`.
- `runDoctor` (`src/cli/commands/doctor.ts`) → `src/cli/aid.ts` ; test `test/doctor.test.ts`.
- `Boite` → `Layout` → `Barre` (rendu) ; `App` rend `Boite` et `Notifieur`.

Ce que la relecture du 2026-10-20 change à l'« État actuel » (le reste est inchangé sur
`main` v0.2.2) :

- La liste des binaires de `aid doctor` est en `src/cli/commands/doctor.ts:126-130` (plus
  106-112) ; `runDoctor` à la ligne 334. Le chantier 13 y a ajouté le mode d'installation
  (`repo` / `release`) et la version : les vérifications mesh s'y ajoutent sans les toucher.
- `src/daemon/main.ts` construit aussi `StructuralService` et `MemoryService` à côté de
  `MemoryWorker` et `UpdateWatcher` (lignes 125-204) : le service mesh prend le même chemin.
- `migrations/` est toujours à 8 ; `009_mesh.sql` reste libre.
- La table des décisions du README s'arrête à D33 ; le chantier 13 n'en a pas numéroté :
  D34–D41 restent libres.
- Fondations vérifiées sur la branche rebasée : `npm run gate` vert en entier (une seule
  relance : `test/pty-spawn.test.ts` échoue si la session qui lance le gate exporte des
  `AID_*`, comme un agent lancé depuis A-I-D — relancer avec `env -u AID_HOME -u
  AID_NO_BROWSER`, le code n'est pas en cause).
- Prérequis 12.0 sur le Mac au 2026-10-20 : `swarph` absent (`uv` et `python3.12`
  présents), Tailscale installé mais **arrêté** (`gateway` bien dans la liste des pairs),
  gateway injoignable tant que Tailscale est arrêté, aucune cell ni token
  (`~/.config/swarph` absent). Rien n'a bougé depuis le constat du 19 : 12.1 à 12.6 se
  développent avec les faux binaires (D40) ; 12.7 attend 12.0.

## Pourquoi

Julien a une cell swarph (`cell-gestion`) sur son VPS, reliée au mesh de peer-a (gateway
`gateway` sur le tailnet `example.ts.net`). Il veut pouvoir, **de temps à autre**,
brancher ce Mac au même mesh — recevoir les DM qui lui sont adressés, voir ce qui attend,
y répondre — et que ce geste se fasse dans A-I-D, pas dans un terminal à côté.

swarph n'est pas Swairm : c'est un CLI Python tiers (example-org, Julien n'y
contribue pas) qui fait deux choses utiles ici : lancer un agent nommé et résumable
(`swarph spawn <cell>`, qui se remplace par `claude`) et le relier au mesh (DM, channels,
board, obligations) via un gateway HTTP. Le modèle d'intégration est celui que le brief §7
réserve à Swairm : **A-I-D suit un sous-processus CLI et des fichiers locaux, jamais l'état
distant directement.**

Constats du 2026-10-19 qui cadrent le chantier (vérifiés sur le VPS en lecture seule et sur
le Mac) :

| Constat | Effet |
| --- | --- |
| Le Mac (`my-mac`) est déjà sur le tailnet où `gateway` est partagé ; Tailscale est installé mais **arrêté** | « Se connecter au mesh » commence par Tailscale, puis le gateway répond en `http://gateway.example.ts.net:8788` |
| `swarph` n'est pas installé sur le Mac ; Python système 3.9, swarph exige ≥ 3.10 ; `uv` et `python3.12` sont présents | `uv tool install --python 3.12 swarph-cli` (prérequis humain, 12.0) |
| Le mesh exige **une identité par acteur** (règle 1 de son `architecture-overview.md`) ; lire une inbox la **consomme** (`swarph mesh inbox` marque lu, sauf `--peek`) | Le Mac ne peut pas réutiliser le token de `cell-gestion` : deux lecteurs se voleraient l'état de lecture. Il lui faut sa propre cell (D34) |
| Le monitor du VPS est **mort** (`monitor status --json` : `running: false`, pidfile périmé, 16 DM de `gateway` non livrés, dernier DM reçu le 2026-10-16 21:17) ; seul `swarph channel-serve` tourne, et il ne fait que suivre `inbox.log` | La cell `cell-gestion` est sourde depuis le 16/10. Hors périmètre du code A-I-D, mais c'est l'incident que ce chantier doit rendre visible côté Mac (D36 : état du monitor affiché) |
| Un DM de `gateway` (id 73544, 2026-10-16) demande à `cell-gestion` si A-I-D lira le board swarph « comme il lit `swairm inbox` » et si un JSON versionné lui conviendrait | Le contrat retenu ici (D35) est la réponse : A-I-D lit `inbox.log` localement ; le board viendra plus tard (hors périmètre) |

## État actuel

- `src/shared/model.ts:18` : `AgentKind` connaît `claude`, `codex`, `cursor`, `shell`,
  `swairm-drone`, `swairm-queen`, `grokbot-cloud` ; rien pour une cell swarph.
  `RunMode` est `standard | swairm`.
- `src/shared/events.ts:1-37` : `EVENT_SOURCES` a `swairm` mais pas `swarph` ;
  `EVENT_TYPES` n'a aucun type « mesh ». Le brief §4 présente la liste des types comme
  fermée en v1 — l'ajout est une décision (D36).
- `src/daemon/pty/spawn.ts:5-10` : `agentCommand(kind)` renvoie `[kind]` pour `claude` et
  `codex` ; `agentEnv` n'ajoute que `TERM`, `COLORTERM` et les `AID_*` (§2 du brief).
  `src/daemon/routes/agents.ts:10,35` restreint `kind` à `claude | codex | shell`.
- `src/daemon/config.ts:5-40` : sections `env`, `terminal`, `memory`, `structural` ; toute
  clé inconnue est refusée (`rejectUnknown`). Pas de section `mesh`.
- `src/daemon/structural/exec.ts` : le patron d'appel d'un binaire externe sans shell
  (`execFile`, tableau d'arguments, délai, `spawnErrorCode`) à réutiliser pour `swarph`.
- `src/daemon/main.ts` : les services longue durée (`MemoryWorker`, `UpdateWatcher`) sont
  construits ici et démarrés/arrêtés avec le daemon ; même emplacement pour un service mesh.
- `src/daemon/state/snapshot.ts` / `src/shared/state.ts:3-9` : `StateSnapshot` porte
  workspaces, topics, runs, agents, actions — rien de machine (le mesh n'est ni un workspace
  ni un sujet).
- `web/src/ecrans/Boite.tsx` : la Boîte agrège les agents en `needs_input` (lignes 35-51)
  et agit sur `/api/agents/:id/{input,answer}`. Un seul type d'élément : l'agent.
- `src/cli/commands/doctor.ts:106-112` : liste de binaires vérifiés (`claude`, `codex`,
  `codegraph`, `gh`, `ollama`) ; ni `swarph`, ni Tailscale.
- `migrations/` : 8 migrations, la dernière `008_topic_pr.sql`.
- `test/fixtures/` : `fake-agent.sh`, `fake-codegraph.sh`, `fake-gh.sh`… — la règle
  « jamais le vrai binaire dans un test » a déjà son patron ; pas de `fake-swarph.sh`.

Côté swarph (lu dans `~/Projects/swarph-cli`, version 0.72.25 ; le VPS est en 0.72.20) :

- `swarph monitor start --as <cell> --deliver pull` se **détache** (`fork`, pidfile dans
  le state dir), est **idempotent** (pidfile vivant ⇒ sortie 0 silencieuse ; pidfile périmé
  réclamé et journalisé), interroge le gateway toutes les 30 s et **écrit chaque DM en JSONL
  dans `<state>/<cell>/mesh-sidecar/inbox.log`**. `swarph monitor status --json` rend un
  vrai JSON (`running`, `pid`, `pidfile_status`, `observation_cursor`, `sinks[].pending`,
  `sinks[].pending_from`, `state_dir`). `swarph monitor stop` arrête le sien et jamais un
  autre PID.
- Le state dir est `$SWARPH_STATE` (ou `$SWARPH_STATE_ROOT`), sinon `~/swarph_state`
  (`channel.py:68-74`, `mesh.py:1244`). L'enregistrement d'`inbox.log` a pour champs
  `id` (entier global au gateway, croissant), `thread_id`, `from_node`, `to_node`, `kind`
  (`fyi | status | question | answer | unblock`), `content`, `created_at` (ISO, tz),
  `read_at`, `priority`, `reply_to`, `obligation_id`, `related_task_id`.
- `swarph mesh wait --once` et le plugin channel (`swarph channel-serve`) lisent ce même
  `inbox.log` sans réseau ni token : un lecteur de plus (A-I-D) ne gêne pas, tant qu'il n'y
  a qu'**un** monitor par cell.
- `swarph spawn <role|chemin.yaml> [--no-starter] [--no-banner] [--dry-run]` résout la
  cell (`~/.config/swarph/cells/<role>.yaml`, ou un chemin), pose `SWARPH_SELF=<cell>`,
  puis `os.execv` vers `claude --name <cell> --session-id <uuid persistant>`
  (`--resume` si la session existe déjà). Pas de tmux sur mac (la voie tmux est `win32`
  seulement). `starter_prompt_path` ajoute `--append-system-prompt` : à neutraliser par
  `--no-starter` (D38).
- Identité : `SWARPH_SELF` en priorité, jamais de nom par défaut (`identity.py`). Le token
  par cell est `~/.config/swarph/<cell>.peer_token`, posé par `swarph onboard`. Le gateway
  n'a **aucun hôte par défaut** (`gateway_default.py`) : il vient de `MESH_GATEWAY_URL`.
- Onboarding (`README.md` §`swarph onboard`) : `swarph onboard <peer>` a besoin d'un
  `MESH_GATEWAY_TOKEN` partagé pour enregistrer le peer, puis un témoin ratifié (côté
  peer-a) fait `swarph ratify <peer>`. Un peer non ratifié lit déjà son inbox et envoie des
  DM ; seule `task_claim` est bloquée.

## Cible et hors-périmètre

| Construit | Omis (et pourquoi) |
| --- | --- |
| Une section `mesh` dans `~/.aid/config.yaml` ; `aid doctor` vérifie swarph, la cell, Tailscale | Installer swarph ou créer la cell depuis A-I-D : prérequis humain (12.0), l'onboarding passe par un tiers |
| Deux actions machine `mesh.connect` / `mesh.disconnect` : Tailscale (lecture, et `up`/`down` seulement sur option), `swarph monitor start/stop`, suivi d'`inbox.log` | Piloter le monitor du VPS : autre machine, hors d'A-I-D |
| Chaque DM reçu devient un événement `mesh.dm` (source `swarph`) ; l'état du monitor devient `mesh.state` ; projection `mesh_inbox` ; Boîte : « à traiter » (question, unblock) et « informations » (fyi, status, answer) ; pastille d'état dans la barre ; notification sur `question`/`unblock` | Répondre depuis l'UI (`swarph mesh reply`) : l'identité qui répond est la cell, pas Julien (D38) ; reporté, comme l'écriture Swairm |
| Un agent `swarph-cell` : `swarph spawn <cell.yaml> --no-starter --no-banner` dans le PTY d'un sujet, pour **répondre** depuis la session Claude de la cell | Board et obligations (`swarph board … --json`) comme colonne « à démarrer » : même geste que grokbot v0.5, chantier à part — c'est la réponse à donner à `gateway` |
| | `brain-ask`, `memory`, `dreaming` (gbrain, décommissionné au chantier 10), `swarph codegraph` (son propre index), `swarph hooks`, lanes, `service serve`, plugin channel : hors du rôle cockpit |

Multi-mesh : voir le chantier 46 (D311, D312, D314, D316), qui remplace le mesh unique par un registre nommé, des identités de données par mesh et une Boîte fusionnée.

## Décisions à valider par Julien

La numérotation continue celle de `docs/chantiers/README.md` §1.

- **D34 — Le Mac a sa propre cell, `cell-aid`.** Jamais le token de `cell-gestion` : lire
  une inbox la consomme, et deux lecteurs sous la même identité se volent l'état de lecture
  (c'est le défaut contre lequel `--consume`/`--peek` ont été ajoutés). Coût : un onboarding
  côté peer-a (token partagé pour `swarph onboard cell-aid`, ou enregistrement du peer par
  lui, puis `swarph ratify`). Alternative écartée : suivre `cell-gestion` par SSH depuis le Mac
  — ce n'est pas « connecter le Mac au mesh », et ça n'enlève pas la surdité actuelle du VPS.
- **D35 — A-I-D ne parle jamais au gateway.** Il lance `swarph monitor start --as cell-aid
  --deliver pull` (détaché, idempotent), lit `monitor status --json` et suit
  `<state>/cell-aid/mesh-sidecar/inbox.log`. Il n'appelle jamais `swarph mesh inbox`
  (consomme), ne lit jamais `~/.config/swarph/*.peer_token`, n'envoie rien. Même contrat
  que §7 du brief pour Swairm, avec un fichier JSONL local à la place d'un `events --follow`.
- **D36 — Pas de faux agent : deux nouveaux types d'événement.** `mesh.dm` (un par
  enregistrement d'`inbox.log`, idempotent par `id` swarph) et `mesh.state` (état du
  monitor et de Tailscale, à chaque changement), source `swarph`, table de projection
  `mesh_inbox` + état courant dans le snapshot. Un DM n'est pas un `agent.status` : il n'y a
  pas d'agent tant que la cell n'est pas lancée, et un `needs_input` fabriqué sur un agent
  fictif violerait « seul le daemon dérive l'état » à rebours. **Ceci amende le brief §4**
  (liste des types v1) : à acter.
- **D37 — Tailscale : lu toujours, piloté sur option.** `mesh.connect` lit l'état
  (`Tailscale status --json`) et le montre. Il ne lance `Tailscale up`/`down` que si
  `mesh.tailscale.manage: true` (défaut `false`) : Tailscale sert aussi à autre chose
  (`ssh vps`), et un `down` automatique couperait une session en cours. Recommandation :
  laisser `false` ; la pastille dit « Tailscale arrêté » et le bouton explique quoi faire.
- **D38 — Répondre = ouvrir la cell, pas un formulaire.** L'agent `swarph-cell` est un
  `claude` lancé par `swarph spawn`, dans le PTY d'un sujet, avec `--no-starter` (A-I-D
  n'injecte rien dans un agent, §2) et `--no-banner`. C'est la session de la cell qui lit et
  répond (par `swarph mesh reply` ou le MCP swarph, sous son identité). A-I-D ajoute à
  l'environnement de ce seul agent `MESH_GATEWAY_URL` (une URL, pas un secret) ; `SWARPH_SELF`
  est posé par spawn lui-même. Un seul `swarph-cell` vivant par cell (session-id persistant).
- **D39 — Configuration dans `~/.aid/config.yaml`, section `mesh`.**
  `bin: swarph`, `cell: cell-aid`, `cellFile: ~/.config/swarph/cells/cell-aid.yaml`,
  `gateway: http://gateway.example.ts.net:8788`, `stateRoot: ~/swarph_state`,
  `tailscale: { manage: false, bin: /Applications/Tailscale.app/Contents/MacOS/Tailscale }`.
  `cell` vide ⇒ le mesh est désactivé et rien n'apparaît dans l'UI. Le token n'y figure
  jamais.
- **D40 — Tests sans swarph ni réseau.** `test/fixtures/fake-swarph.sh` répond à
  `monitor start|stop|status --json` et à `spawn --dry-run`, écrit un `inbox.log` de
  fixture sous un `SWARPH_STATE` temporaire ; `fake-tailscale.sh` répond à `status --json`.
  `AID_HOME` temporaire comme partout. Jamais le vrai `swarph`, jamais `claude`.
- **D41 — Pas d'annonce de présence au mesh en v1.** Se connecter ne fait aucun `mesh
  register --capability`. Les DM reçus pendant une absence attendent au gateway et le monitor
  les rattrape depuis son curseur : rien n'est perdu, mais un pair qui écrit à `cell-aid`
  hors connexion n'a aucun signal. La Boîte affiche « hors mesh depuis <durée> » pour que
  Julien, lui, le sache. À revoir avec peer-a si le mesh veut une capacité `presence`.

## Points

### 12.0 — Prérequis humains (aucun commit)

À faire par Julien avant 12.3 ; `aid doctor` (12.2) les vérifie ensuite.

- Mac : `uv tool install --python 3.12 swarph-cli` ; `swarph --version`.
- Mac : Tailscale démarré, puis `curl -s -m 5 http://gateway.example.ts.net:8788/health`
  → `200`.
- Identité : obtenir auprès de peer-a l'enregistrement de `cell-aid` (token partagé pour
  `swarph onboard cell-aid`, ou peer créé par lui) et sa ratification ; vérifier que
  `~/.config/swarph/cell-aid.peer_token` existe.
- Cell : `swarph init cell-aid --provider claude --role cell-aid` (cwd : un dossier de
  travail, pas un worktree A-I-D) ; `swarph spawn cell-aid --dry-run` affiche la commande
  `claude` attendue.
- VPS, hors A-I-D : relancer le monitor de `cell-gestion`
  (`MESH_GATEWAY_URL=… SWARPH_SELF=cell-gestion ~/.local/bin/swarph monitor start`), puis
  `monitor status --brief` ; 16 DM attendent.

### 12.1 — Schéma : source, types, modèle, migration

Fichiers : `src/shared/events.ts`, `src/shared/model.ts`, `src/shared/state.ts`,
`migrations/009_mesh.sql` (nouveau), `src/daemon/events/projectors.ts`,
`test/mesh-schema.test.ts` (nouveau).

- `EVENT_SOURCES` + `swarph` ; `EVENT_TYPES` + `mesh.dm`, `mesh.state` (D36).
- `MeshDm { id: number; threadId; from; to; kind; content; createdAt; replyTo; obligationId;
  seenAt: string | null }` et `MeshState { connected: boolean; tailscale: 'running' |
  'stopped' | 'absent'; monitor: 'running' | 'stopped' | 'stale' | 'absent'; pending: number;
  since: string | null; cell: string }` dans `src/shared/model.ts` ; `StateSnapshot.mesh?:
  { state: MeshState; inbox: MeshDm[] }`.
- `009_mesh.sql` : `mesh_inbox (id INTEGER PRIMARY KEY, thread_id, from_node, to_node, kind,
  content, created_at, reply_to, obligation_id, seen_at, event_id)` ; `mesh_state (k TEXT
  PRIMARY KEY, v TEXT)`.
- Projecteurs : `mesh.dm` ⇒ `INSERT OR IGNORE` dans `mesh_inbox` (idempotent par `id`
  swarph, en plus de l'ULID) ; `mesh.state` ⇒ `mesh_state`. Même transaction que
  l'insertion de l'événement (D10).
- Test : rejoue deux fois le même `mesh.dm` ⇒ une ligne ; reconstruit `mesh_inbox` depuis
  le journal et compare (patron du test D10).

Vérification : `npm run gate`.

### 12.2 — Configuration `mesh` et `aid doctor`

Fichiers : `src/daemon/config.ts`, `src/cli/commands/doctor.ts`, `test/config.test.ts`
(ajouts), `test/doctor.test.ts` (ajouts).

- `MeshConfig` par D39, `rejectUnknown` étendu, valeurs par défaut (`cell: ''` ⇒
  désactivé). `tailscale.bin` par défaut : chemin de l'app sur darwin, `tailscale` sur
  linux.
- `aid doctor` : `swarph` présent et version lisible (sinon « mesh désactivé : `uv tool
  install --python 3.12 swarph-cli` ») ; si `mesh.cell` est posé : `cellFile` lisible,
  `~/.config/swarph/<cell>.peer_token` **existe** (jamais lu), Tailscale `running |
  stopped | absent`. Niveau `warn` partout : le mesh est optionnel.
- Test : config minimale, config complète, clé inconnue refusée ; doctor avec
  `fake-swarph.sh` sur le PATH.

Vérification : `npm run gate`.

### 12.3 — Service mesh : connecter, suivre, déconnecter

Fichiers : `src/daemon/mesh/exec.ts`, `src/daemon/mesh/inbox.ts`, `src/daemon/mesh/service.ts`
(nouveaux), `src/daemon/main.ts`, `test/fixtures/fake-swarph.sh`, `test/fixtures/fake-tailscale.sh`
(nouveaux), `test/mesh-service.test.ts` (nouveau).

- `mesh/exec.ts` : `execFile` sans shell, délai, environnement = celui du daemon +
  `MESH_GATEWAY_URL`, `SWARPH_STATE` ; patron de `structural/exec.ts`.
- `mesh/inbox.ts` : suiveur d'`inbox.log`. Curseur = **plus grand `id` déjà projeté**
  (lu en base au démarrage), jamais un offset d'octets : le fichier peut être réécrit par un
  autre outil swarph. À chaque tick (fs.watch + repli 5 s) : lire les lignes, ignorer les
  lignes JSON invalides en les comptant, émettre `mesh.dm` pour `id` > curseur.
- `mesh/service.ts` : `connect()` = (1) Tailscale : `status --json`, puis `up` seulement si
  `manage: true` et arrêté ; (2) `swarph monitor start --as <cell> --deliver pull` ; (3)
  démarre le suiveur ; émet `mesh.state`. `disconnect()` = arrêt du suiveur, `swarph monitor
  stop`, `Tailscale down` seulement si `manage: true` et si c'est `connect()` qui l'avait
  monté ; émet `mesh.state`. `refresh()` toutes les 30 s pendant la connexion : `monitor
  status --json` ⇒ `pending`, `monitor` (`running`/`stale`), et `mesh.state` si changement.
- Au démarrage du daemon : si `mesh.cell` est posé, un seul `monitor status --json` décide
  de l'état affiché (un monitor détaché survit au daemon : on ne le relance pas, on le lit —
  cohérent avec « redémarrer le daemon ne tue pas les runs distants »). Pas de connexion
  automatique.
- Tests avec les deux faux binaires : connect ⇒ `start` appelé une fois ; `inbox.log` de
  fixture (3 DM) ⇒ 3 `mesh.dm` puis 0 au second passage ; fichier réécrit avec 2 DM
  nouveaux ⇒ 2 ; `manage: false` ⇒ `up`/`down` jamais appelés ; `status` qui répond
  `running: false, pidfile_status: stale` ⇒ `monitor: 'stale'`.

Vérification : `npm run gate`.

### 12.4 — Routes et snapshot

Fichiers : `src/daemon/routes/mesh.ts` (nouveau), `src/daemon/server.ts`,
`src/daemon/state/snapshot.ts`, `test/mesh-routes.test.ts` (nouveau).

- `GET /api/mesh` : `{ state, inbox }` (inbox triée par `created_at` décroissant, bornée à
  200). `POST /api/mesh/connect`, `POST /api/mesh/disconnect` (202 ; le résultat arrive par
  `mesh.state`). `POST /api/mesh/dm/:id/seen` : pose `seen_at` **localement** (marque de
  Julien dans A-I-D), ne touche jamais au `read_at` du gateway.
- `GET /api/state` inclut `mesh` quand `mesh.cell` est posé.
- Même garde-fous que les autres routes (`registerSecurity`, origine, token).
- Test : 404 quand le mesh est désactivé ; `seen` idempotent ; connect ⇒ événement.

Vérification : `npm run gate`.

### 12.5 — UI : pastille, section Mesh de la Boîte, notifications

Fichiers : `web/src/ui/Barre.tsx`, `web/src/ecrans/Boite.tsx`, `web/src/ui/Notifieur.tsx`,
`web/src/styles/app.css`, `test/web/boite.test.tsx` (ajouts).

- Barre : pastille « Mesh » à trois états — hors mesh (gris, « depuis <durée> »),
  connexion en cours, connecté (« N à traiter »). Clic ⇒ connect/disconnect ; si Tailscale
  est arrêté et `manage: false`, le bouton est désactivé avec l'explication.
- Boîte : section « Mesh · cell-aid » sous les agents. **À traiter** : `question`,
  `unblock`. **Informations** : `fyi`, `status`, `answer`. Chaque DM : émetteur, kind,
  horodatage, fil (`thread_id` tronqué), contenu rendu **en texte brut** dans un bloc
  encadré « donnée d'un pair du mesh » (jamais Markdown, jamais HTML — même raison que D30 :
  contenu tiers). Boutons : « Vu » (12.4) et « Ouvrir la cell » (12.6).
- Notifieur : une notification par `mesh.dm` de kind `question`/`unblock`, jamais pour les
  autres kinds.
- Variables CSS des maquettes uniquement, pas de nouvelle maquette (D13).
- Test : rendu des deux groupes, tri, bouton désactivé quand Tailscale est arrêté.

Vérification : `npm run gate`.

### 12.6 — Agent `swarph-cell`

Fichiers : `src/daemon/pty/spawn.ts`, `src/daemon/routes/agents.ts`, `src/shared/model.ts`
(`AgentKind` + `swarph-cell`), `src/daemon/pty/manager.ts` (refus si une cell vit déjà),
`web/src/ecrans/Sujet.tsx` (choix d'agent), `test/spawn.test.ts` (ajouts).

- `SpawnKind` + `swarph` ⇒ `agentCommand` renvoie
  `[mesh.bin, 'spawn', mesh.cellFile, '--no-starter', '--no-banner']` (D38). `agentEnv`
  reçoit en plus `MESH_GATEWAY_URL` pour ce kind seulement ; `SWARPH_SELF` n'est **pas**
  posé par A-I-D (spawn le pose). Les hooks `AID_HOOK` s'appliquent comme à tout `claude` :
  les statuts fins marchent sans rien de plus.
- Refus (409) si un agent `swarph-cell` est déjà vivant pour cette cell : une session par
  cell (session-id persistant côté swarph).
- « Ouvrir la cell » depuis la Boîte : sans sujet choisi, propose la liste des sujets
  actifs ; la cell tourne dans le worktree du sujet mais son `cwd` swarph reste celui du
  `cell.yaml` (c'est `claude` qui démarre dans le PTY, cwd = worktree, comme tout agent).
- Test : commande construite ; `fake-swarph.sh spawn --dry-run` ; env contient
  `MESH_GATEWAY_URL` pour `swarph` et pas pour `claude`.

Vérification : `npm run gate`.

### 12.7 — Recette

Fichiers : `docs/recette-v0.4-mesh.md` (nouveau), `e2e/mesh.spec.ts` (nouveau, avec les
faux binaires).

- e2e : daemon avec `fake-swarph.sh`/`fake-tailscale.sh`, connect depuis la barre, 3 DM de
  fixture apparaissent, « Vu » sur l'un, disconnect ⇒ pastille « hors mesh ».
- Recette manuelle (vrai swarph, vrai mesh, à faire par Julien) : Tailscale up, connect
  dans A-I-D, peer-a ou `cell-gestion` envoie un DM à `cell-aid`, il apparaît en moins d'une
  minute ; ouvrir la cell, répondre depuis la session, le fil se complète ; disconnect ;
  reconnect une heure plus tard, les DM envoyés entre-temps arrivent.

Vérification : `npm run gate` et `npm run gate:e2e`.

## Pièges

- **Jamais `swarph mesh inbox` depuis le daemon** : sans `--peek`, il marque lu et avance le
  ledger du monitor ; la cell ne verrait plus ces DM. La seule lecture est `inbox.log`.
- **Un seul monitor par cell.** `start` est idempotent par pidfile ; ne jamais le lancer
  avec un `--state-dir` différent de celui que lit le suiveur, et ne jamais `kill` un PID
  lu dans un fichier : `swarph monitor stop` sait ne tuer que le sien.
- **Curseur par `id`, pas par offset** : `inbox.log` peut être réécrit par un outil swarph ;
  un offset d'octets rejouerait ou sauterait des DM. Le `id` est global au gateway et
  croissant.
- **Le token n'entre jamais dans A-I-D** : ni lu, ni copié, ni dans `config.yaml`, ni dans
  l'environnement d'un PTY (swarph le lit lui-même dans `~/.config/swarph/`).
- **Contenu d'un DM = donnée tierce** : texte brut dans l'UI (D30), jamais injecté dans un
  agent par A-I-D — c'est le rôle des mécanismes swarph (`mesh wait`, plugin channel), pas
  du cockpit.
- **`--json` de swarph a deux sens** : `monitor status --json` rend du JSON strict ;
  `swarph "<prompt>" --json` passe par un harnais LLM qui peut sortir en code 1 avec du texte
  brut. Ne consommer que le premier.
- **`Tailscale down` coupe `ssh vps`** : d'où `manage: false` par défaut (D37). Même avec
  `manage: true`, ne descendre que ce que `connect()` a monté.
- **Version du VPS ≠ version du clone** (0.72.20 contre 0.72.25) : le format d'`inbox.log`
  est stable sur la plage lue, mais vérifier `swarph --version` sur le Mac dans `doctor` et
  ne pas supposer les flags récents (`--peek` existe depuis la 0.6x).
- **Python système 3.9** : `uv tool install --python 3.12` ; un `pip install` système
  échouerait en silence sur `requires-python`.
- **Ne pas confondre** `swairm` (ruche, §7 du brief, mode `swairm`) et `swarph` (mesh) :
  deux sources d'événement distinctes, deux CLI, aucune réutilisation de `hive`.
- Index structurel indisponible à l'écriture de ce plan : le dev requête `index_impact`
  lui-même avant 12.1.

## Fini quand

- Depuis la barre d'A-I-D, « Mesh » se connecte et se déconnecte ; un DM envoyé à
  `cell-aid` par un pair apparaît dans la Boîte sans ouvrir de terminal.
- Un DM de kind `question`/`unblock` déclenche une notification ; les autres non.
- « Ouvrir la cell » lance `swarph spawn` dans un PTY et la session répond sous l'identité
  `cell-aid`, visible côté pair.
- Redémarrer le daemon pendant une connexion ne relance ni ne tue le monitor ; l'état
  affiché est relu depuis `monitor status --json`.
- `aid doctor` nomme chaque prérequis manquant (swarph, cell, token, Tailscale) sans jamais
  afficher le token.
- `npm run gate` et `npm run gate:e2e` verts en entier ; aucun test des chantiers 02 à 11
  n'a changé de résultat.
