<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/marque/aid-logo-arrondi_with_text.svg">
  <img src="design/marque/aid-logo-arrondi_with_text-sombre.svg" alt="A-I-D Board" height="60">
</picture>

Cockpit local pour piloter des agents de code (Claude Code, Codex, un shell) sur plusieurs sujets en parallèle.
Un **sujet** est une branche git et son worktree ; chaque agent tourne dans un terminal persistant du navigateur :
fermer l'onglet n'arrête rien.

## Prérequis

| Plateforme | À installer avant                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS      | Node 22 à 24, git                                                                                                                                                                                                                                                                                                                                                                                             |
| Linux      | Node 22 à 24, git, **`sudo apt install build-essential python3`** (node-pty n'a pas de binaire précompilé pour Linux)                                                                                                                                                                                                                                                                                         |
| Windows    | **Le daemon reste WSL2 uniquement, jamais en natif** (node-pty n'y est pas fiable hors WSL2). Dans WSL2 : comme Linux, plus `sudo apt install wslu` pour que le navigateur Windows s'ouvre tout seul. Garder les dépôts dans le système de fichiers Linux (`~/…`), pas sous `/mnt/c` : c'est lent. L'app native (`app/`, voir ci-dessous), elle, tourne nativement sur Windows et pilote le daemon dans WSL2. |

Facultatifs : `claude`, `codex` (les agents), `codegraph` (index structurel), `gh` (utile à partir de la v0.3), `swarph` et Tailscale (mesh, voir plus bas).

Pour compiler l'app native (`app/`, une vraie fenêtre sans navigateur — voir plus bas) : Rust
(`mise install` le récupère, sinon <https://rustup.rs>), et sur Linux les paquets système de la
WebView (`sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`). Rien
de plus sur Windows : le runtime WebView2 est déjà présent par défaut depuis Windows 10 1803+/11.

## Installation et lancement

Deux produits, publiés ensemble sur la [page des releases](https://github.com/morzu117/aidboard/releases) :

- **AID Board**, l'app de bureau (`.dmg` macOS, `.AppImage`/`.deb` Linux, `.msi` Windows). À la
  première ouverture, elle installe AID Server si besoin, le lance et affiche le board. Elle se met
  à jour toute seule. macOS : l'app n'est ni signée ni notarisée en 0.x — au premier lancement,
  clic droit → Ouvrir (Gatekeeper refuse le double-clic).
- **AID Server**, le daemon seul, sans Node ni git à installer :

```bash
curl -fsSL https://github.com/morzu117/aidboard/releases/latest/download/install-server.sh | sh
~/.aid/server/current/bin/aid     # lance le daemon s'il ne tourne pas, ouvre le navigateur
```

L'installeur pose la release sous `~/.aid/server/<version>/` (Node embarqué, archive vérifiée par
SHA-256) et fait pointer `~/.aid/server/current` dessus ; ajouter `~/.aid/server/current/bin` au
PATH pour avoir `aid`. Sous Windows, tout ça se passe dans WSL2 (le Board s'en charge). Mise à
jour : le bandeau du board, ou `aid server install` ; `aid server use <version>` revient en arrière.

| Commande                       | Effet                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `aid`                          | démarre le daemon (détaché, ses agents survivent au terminal) et ouvre le navigateur                    |
| `aid open`                     | rouvre le navigateur sur le daemon qui tourne                                                           |
| `aid status`                   | pid, port, nombre de sujets et d'agents vivants                                                         |
| `aid stop`                     | arrête le daemon ; **refusé tant que des agents tournent** (code 2)                                     |
| `aid stop --force`             | arrête le daemon et tous ses agents                                                                     |
| `aid doctor`                   | vérifie la machine et dit quoi corriger                                                                 |
| `aid server …`                 | l'installation AID Server : `status`, `install [version]` (depuis les releases), `use <version>`        |
| `aid kernel install [--check]` | matérialise le noyau multi-agents (`kernel/`) dans `~/.agent-kernel` ; `--check` ne touche rien         |
| `aid mem …`                    | lit, écrit et cherche dans la mémoire locale (`get`, `put`, `search`, `list`, `rm`, `export`, `import`) |
| `aid mcp`                      | serveur MCP « aid » (stdio) : mémoire locale et index structurel (`index_*`) pour un agent              |

Enregistrement auprès de Claude Code : `claude mcp add --scope user aid -- aid mcp`.

Premier pas : « Nouveau sujet » dans la barre. Sans dépôt enregistré, A-I-D demande d'abord le chemin de la racine d'un
dépôt git (qui doit avoir un remote `origin`).

Au premier lancement de `claude` ou de `codex` dans un worktree neuf, l'agent affiche **son propre** dialogue de
confiance : c'est normal, A-I-D n'y touche pas.

## Ce qu'A-I-D fait et ne fait pas

- Il écoute **uniquement sur `127.0.0.1`** et refuse de démarrer ailleurs. Le lien d'ouverture porte un token aléatoire
  échangé contre un cookie `HttpOnly`, `SameSite=Strict` ; `Host` et `Origin` sont vérifiés sur REST et WebSocket.
- Un agent ne reçoit qu'un droit d'émettre des événements pour son run : il ne peut ni lancer une action, ni ouvrir un
  shell, ni valider ses propres demandes.
- `ANTHROPIC_API_KEY` et `ANTHROPIC_AUTH_TOKEN` sont **retirés de l'environnement des agents** : leur présence ferait
  basculer `claude` de l'abonnement vers la facturation à l'API. Réglable (`env.strip`).
- Aucun code, diff ni journal ne quitte la machine.
- Il n'ajoute rien dans les dépôts : seuls les worktrees, créés sous `~/.aid/worktrees/`, y sont visibles.
- `topic.cleanup` ne supprime jamais de travail : refus si le worktree a des modifications non commitées, et si des
  commits ne sont pas dans `origin/<base>` il faut confirmer en répétant leur nombre exact.

## Où sont les données

```
~/.aid/
  config.yaml      réglages facultatifs (port 4870, éditeur, rétention des journaux…)
  state.db         sujets, runs, agents, journal d'événements (SQLite)
  daemon.json      pid, port et token du daemon qui tourne (0600)
  daemon.log       journal du daemon
  logs/            sortie brute de chaque terminal (0600, supprimée au-delà de 30 jours)
  worktrees/       un dossier par workspace puis par sujet
  memory/          mémoire locale, en markdown, sous git (dépôt séparé des workspaces)
```

`AID_HOME` change ce dossier. Les journaux de terminaux peuvent contenir des secrets : ne pas les partager.

## Le noyau multi-agents

`kernel/` (adapters, policy, roles, gabarit, commande `/sync`) est la
politique de routage de la connaissance, des phases et des rôles d'agent —
embarquée dans ce paquet, ancien dépôt séparé `agent-kernel` (fusionné,
chantier 09). `aid kernel install` la matérialise sur `~/.agent-kernel` et
installe `/sync` dans `~/.claude/commands/`. Dans un projet rattaché,
`/sync` résout le manifeste (`agent.yml`) et rend le bloc d'instructions
entre les marqueurs `<!-- agentkit:start --> … <!-- agentkit:end -->` de
`CLAUDE.md`/`AGENTS.md`. Le détail : `kernel/policy/routing.md`,
`kernel/commands/sync.md`.

### La connaissance : trois couches, un seul point d'entrée

Le noyau range ce qu'un agent peut savoir en trois couches, et donne à chaque question **un
seul** premier appel : interroger deux couches « au cas où » double le coût au lieu de le
diviser.

| Couche        | Contenu                                                                     | Où                                                   | Qui l'écrit                                       |
| ------------- | --------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| Structurelle  | ce que le code fait _maintenant_ : symboles, appels, impact d'un changement | l'index structurel, `.codegraph/` de chaque worktree | personne : régénéré par le moteur, jamais commité |
| Décisionnelle | ce qui n'est pas dans le code : pourquoi, ce qui a été tenté, les handoffs  | la mémoire locale `~/.aid/memory/` (`aid mem`)       | les agents, aux frontières de phase seulement     |
| Normative     | comment on travaille, quelle phase fait quoi                                | le bloc `agentkit` de `CLAUDE.md`/`AGENTS.md`        | `/sync`, depuis le noyau                          |

| La question porte sur                                                          | Premier appel           | Interdit                                           |
| ------------------------------------------------------------------------------ | ----------------------- | -------------------------------------------------- |
| Ce que le code fait, où c'est défini, qui appelle quoi, impact d'un changement | l'index (`index_*`)     | grep, lecture de fichier, sous-agent d'exploration |
| Pourquoi une décision, ce qui a été tenté, l'état d'un cycle                   | la mémoire (`memory_*`) | relire l'historique git                            |
| Comment on travaille                                                           | déjà en contexte (bloc) | tout appel                                         |
| Rien ne répond                                                                 | lecture directe, nommée | —                                                  |

La règle d'hygiène qui tient l'ensemble : **ce qui est dérivable du code ne va pas en
mémoire.** « X est appelée par Y » écrit dans une page sera faux dans deux semaines, et
l'index le donne à jour gratuitement.

### L'index structurel (codegraph)

Le rôle `structural_index` est tenu aujourd'hui par [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph) :
un graphe local des symboles et des appels (tree-sitter), en SQLite sous `.codegraph/`.
Un seul appel `explore` rend le source verbatim des symboles utiles, les chemins d'appel
entre eux et le rayon d'impact — ce qu'une boucle grep + lecture reconstruirait en dizaines
d'allers-retours. Langages couverts et limites (dispatch dynamique compris) : voir la
documentation de CodeGraph, qui fait foi.

**Mise en place** — une fois par machine, puis une fois par dépôt :

```bash
npm install -g @colbymchenry/codegraph@1.6.0   # version épinglée comme dans scripts/bootstrap-machine.sh
codegraph telemetry off            # active par défaut
cd <dépôt> && codegraph init       # construit .codegraph/, à mettre dans .gitignore
```

Avant le premier `init`, vérifier qu'aucun fichier de secret ne traîne hors `.gitignore` : ce
qui est ignoré n'est pas indexé, un secret commité le serait et serait servi aux agents.
`aid doctor` signale un `codegraph` absent et un décalage entre la version du CLI et celle qui
a bâti l'index.

**Ce qu'A-I-D en fait, sujet par sujet** :

- À la création d'un sujet, son worktree est indexé **si le dépôt principal a déjà un
  `.codegraph/`** — sinon le sujet reste sans index. L'indexation tourne à part : le sujet est
  utilisable tout de suite (journal : `~/.aid/logs/<sujet>-index.log`).
- Au démarrage du daemon, rattrapage sujet par sujet : `codegraph sync` là où le worktree a son
  index (ce qui a bougé daemon arrêté), `init` là où le dépôt a adopté l'index depuis.
- La carte du sujet affiche l'état relu en direct, jamais stocké : `codegraph · à jour`,
  `codegraph · 3 fichiers en retard`, ou `index indisponible`.
- `topic.cleanup` ne compte pas `.codegraph/` comme du travail non commité, arrête le démon
  d'index du worktree et supprime l'index avec lui.

**Comment un agent l'interroge** — tout passe par le daemon, qui ne connaît le moteur qu'à
travers un contrat (`src/daemon/structural/`) :

| Accès                                                                                                                       | Pour qui                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| MCP `aid` (`aid mcp`) : `index_explore`, `index_impact`, `index_affected`, `index_callers`, `index_symbols`, `index_status` | l'agent principal (Claude Code : `claude mcp add --scope user aid -- aid mcp`) |
| CLI `codegraph explore "<symboles ou question>"`                                                                            | sous-agents et harnais sans MCP                                                |
| MCP `codegraph` tiers (`codegraph_explore`)                                                                                 | toléré en transition là où il est déjà enregistré                              |

Un agent lancé par A-I-D n'interroge que **son** sujet : le daemon résout le worktree depuis le
token du run, et refuse un sujet étranger. L'usage est fixé par phase :

| Phase  | Appel                      | Ce qu'il produit                                                  |
| ------ | -------------------------- | ----------------------------------------------------------------- |
| plan   | `index_impact { symbol }`  | le rayon d'impact déclaré, écrit dans la page de plan             |
| dev    | `index_explore { query }`  | la compréhension du code avant de le modifier                     |
| review | `index_affected { files }` | les tests à lancer ; le diff est comparé au rayon déclaré au plan |

Trois règles que les agents violent naturellement, d'où leur place dans le bloc commité plutôt
que dans les seules instructions MCP (qui n'atteignent que l'agent principal) :

- **Le source rendu est déjà lu.** Le re-vérifier au grep annule le gain et double le coût.
- **Jamais d'exploration déléguée à un sous-agent** : il lirait des fichiers et contournerait
  l'index.
- **Un résultat de l'index ne se note jamais en mémoire** : il est dérivé du code.

Chaque relation rendue porte sa `provenance` : `candidate` pour codegraph (lu dans l'arbre
syntaxique, sans type-checker : des homonymes peuvent se mêler dans `callers`), `heuristic`
quand elle est déduite par convention ; `exact` est réservé à un futur moteur fondé sur un
type-checker. Sur du code très dynamique (pipelines chaînés, logique pilotée par
configuration) ou au-delà d'un appel réseau, le rayon d'impact est un plancher, pas un
périmètre.

**Quand l'index ne répond pas** — binaire absent, délai dépassé, index non initialisé, moteur
coupé : tout converge vers `unavailable` avec un motif, et l'outil MCP rend « index
indisponible : lecture directe ». Juste après une écriture, l'index est `stale` le temps de
rattraper, avec le nombre de fichiers en retard. Le repli sur la lecture directe est permis,
**le silence sur le repli ne l'est pas** : l'agent le dit dans son handoff, sinon une lecture
de fichiers passerait pour un rayon d'impact et la review croirait vérifier un contrat.

**Réglages** — côté daemon, `~/.aid/config.yaml` :

```yaml
structural:
  engine: codegraph # ou off : aucun sujet indexé
  bin: codegraph
  timeoutMs: 60000
  exclude: [dist] # segments de chemin retirés des résultats
```

Côté projet, `capabilities.structural_index` dans `agent.yml` (défaut `codegraph`). `null` est
un choix légitime — le bloc retombe alors sur la lecture directe — ; le déclarer sans l'outil
installé ne l'est pas : le bloc interdirait le grep sans rien offrir à la place. Brancher un
autre moteur : `docs/structural-engines.md`.

## Le mesh swarph (facultatif)

Chantier 12 : ce poste peut rejoindre, **par intermittence**, un mesh [swarph](https://github.com/BrainSurfing-tech/swarph-cli)
(messages directs entre cells, via un gateway sur un tailnet) sans quitter A-I-D. Désactivé tant que
`mesh.cell` est vide : rien n'apparaît dans l'interface.

Ce que ça donne quand c'est configuré :

- une **pastille « mesh »** dans la barre : un clic lance `swarph monitor start --as <cell> --deliver pull`
  (connexion), un second l'arrête (« hors mesh depuis … ») ; le monitor tourne détaché, un redémarrage du
  daemon le retrouve ;
- les **DM reçus dans la Boîte**, section « Mesh · <cell> » : les `question` et `unblock` dans « À
  traiter » (et comptés sur la pastille, avec une notification du navigateur), les `fyi`/`status`/`answer`
  dans « Informations » ; « Vu » retire le message de la Boîte sans toucher au ledger de swarph ;
- **répondre = ouvrir la cell** : « Ouvrir la cell » (ou « Ouvrir la cell swarph » dans le menu de
  lancement d'un sujet) démarre un agent `swarph-cell` dans le terminal du sujet, c'est-à-dire la
  session Claude de la cell (`swarph spawn <cell> --no-starter --no-banner`), une seule par cell.

Ce qu'A-I-D ne fait pas : il ne parle **jamais** au gateway lui-même (il lit
`<stateRoot>/<cell>/mesh-sidecar/inbox.log`, écrit par le monitor), il ne lit jamais le token de la cell
(`~/.config/swarph/<cell>.peer_token` reste à swarph : seuls `MESH_GATEWAY_URL` et `SWARPH_STATE` sont
ajoutés à l'environnement de la cell), et il n'appelle jamais `swarph mesh inbox` (la lire la consomme).
Le contenu d'un DM est une donnée tierce : affiché en texte brut, jamais injecté dans un agent.
Tailscale est seulement lu (`tailscale status`) ; A-I-D ne le démarre ni ne l'arrête sans
`tailscale.manage: true`.

**Réglages** — `~/.aid/config.yaml`, avec sa propre cell (jamais l'identité d'une autre machine : deux
lecteurs sous le même token se volent l'état de lecture) :

```yaml
mesh:
  cell: morzu-mac # vide = désactivé
  gateway: http://mesh-gw.example.ts.net:8788 # MESH_GATEWAY_URL, pas un secret
  # bin: swarph, cellFile: ~/.config/swarph/cells/<cell>.yaml, stateRoot: ~/swarph_state (dérivés)
  # tailscale: { manage: false }
```

Prérequis : `swarph` installé (`uv tool install --python 3.12 swarph-cli`), Tailscale connecté au tailnet
du gateway, la cell enrôlée (`swarph onboard`, `swarph init`). `aid doctor` vérifie les cinq lignes
(swarph trouvé, cell lisible, token présent, gateway configuré, Tailscale connecté). La recette et ce
qu'il reste à faire par acteur : `docs/recette-v0.4-mesh.md`, `docs/chantiers/12-mesh-swarph-actions.md`.
Tous les tests passent par les faux binaires `test/fixtures/fake-swarph.sh` et `fake-tailscale.sh` :
jamais le vrai swarph, jamais Tailscale, aucun réseau.

## Développer

Le mode « repo » : un clone sur `main`, `npm link` pour avoir `aid` sur le PATH, et le bandeau du
board parle d'`origin/main` (« Mettre à jour » fait pull et build). Rien de ce qui suit ne touche
`~/.aid/server` ; AID Board prend `aid` du PATH quand il n'y a pas d'installation release.

```bash
mise install            # Node 22
npm install
npm run gate            # typecheck, lint, build, tests
npm run gate:e2e        # gate + installation depuis le tarball + Playwright
npm run dev:daemon      # daemon au premier plan sur le build
npm run dev:web         # Vite sur 127.0.0.1:5173, proxy vers le daemon
```

En dev, lancer le daemon avec `AID_DEV_ORIGIN=http://127.0.0.1:5173` : sans cela, toute écriture depuis Vite répond 403.
Les plans de développement sont dans `docs/chantiers/`, les maquettes de référence dans `design/maquettes/`.

### Signature des mises à jour d'AID Board

L'app se met à jour par l'updater Tauri : chaque release publie `latest.json` et des bundles signés
(minisign). La paire de clés se génère **une fois**, hors du dépôt :

```bash
npm run tauri -- signer generate -w ~/.tauri/aidboard.key
```

La clé **publique** (affichée par la commande, aussi dans `~/.tauri/aidboard.key.pub`) va dans
`app/src-tauri/tauri.conf.json`, champ `plugins.updater.pubkey`. La clé **privée** ne va nulle part
dans le dépôt : secret GitHub `TAURI_SIGNING_PRIVATE_KEY` (contenu du fichier) et, si un mot de
passe a été choisi, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Sans signature valide, l'updater refuse la
mise à jour et le dit dans le journal de l'app ; une clé perdue impose de republier l'app à la main
(les installations existantes ne sauront plus se mettre à jour).

## Licence

[MIT](LICENSE).
