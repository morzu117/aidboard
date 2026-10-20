# 13 — AID Server et AID Board : deux produits, un dépôt, des releases GitHub

Branche : `feat/releases`, depuis `main`.

## Index structurel : disponible

Plan rédigé avec l'index (`index_explore`, `index_impact`) sur le worktree de
`a-i-d` indexé le 2026-10-20. Rayon d'impact des symboles touchés (provenance `candidate`,
tree-sitter) :

- `pullAndBuild`, `spawnRespawnWatcher` (`src/daemon/selfUpdate.ts`) → `main` de
  `src/cli/aid.ts`, `test/self-update.test.ts`.
- `checkForUpdate` (`src/daemon/updateCheck.ts`) → `UpdateWatcher`, `main` de `aid.ts`,
  `test/update-check.test.ts`.
- `readVersion` (`src/cli/version.ts`) → `runDoctor`, `main` de `aid.ts`,
  `test/doctor.test.ts`, `test/smoke.test.ts`.
- `spawn_cycle` (`app/src-tauri/src/daemon_bridge.rs`) → `run` de `lib.rs`,
  `handle_restart_request`, `start_restart_bridge`.

## 1. Pourquoi

Aujourd'hui, A-I-D ne s'installe pas : il se clone. La commande `aid` est un `npm link` vers
le `dist/` d'un clone, le daemon qui tourne est le build de ce clone, et « Mettre à jour »
fait `git pull --ff-only origin main` puis `npm run build` dedans. L'app native est une
coquille Tauri qui lit `repo-path.txt`, un chemin de clone gravé au build de l'app. Ça marche
pour un développeur sur sa machine, et ça a déjà produit deux clones qui se marchaient
dessus (incident du 2026-10-18, second clone « installé » `aidboard` créé en réponse).

Décision du 2026-10-20 : **deux produits, un seul dépôt, des exécutables à télécharger dans
les releases GitHub du dépôt `morzu117/aidboard` (public).**

- **AID Server** : le daemon, la CLI `aid`, le serveur MCP, et l'interface web qu'il sert.
  Une archive par plateforme, sans prérequis : son Node est dedans.
- **AID Board** : l'app Tauri. Elle installe AID Server si besoin, le lance, affiche son
  interface, et se met à jour elle-même.

Ce que le développeur garde : il travaille dans le dépôt, fusionne sur `main`, et son
daemon local continue de se mettre à jour par pull et build. Publier une release est un
clic, pas une procédure. Le redémarrage du daemon tue les agents : assumé (D8), la reprise
par résumé (`gracefulInterrupt` / `resumeFromManifest`) reste ce qu'elle est.

## 2. État actuel

- `package.json:5` — `"private": true`, jamais publié sur npm (`npm view aidboard` → 404)
  alors que `README.md:28` promet `npm i -g aidboard`. `files:74` liste ce qu'un tarball
  contient : `dist`, `migrations`, `kernel`, `scripts/git`, `scripts/hooks`, `README.md`.
  `test/pack.test.ts:20` vérifie ce contenu et qu'un `aid doctor` passe depuis le tarball
  installé (gate:e2e).
- `tsup.config.ts:11` — `external: ['node-pty', 'better-sqlite3']` : les deux natifs ne sont
  jamais dans le bundle. Tout le reste (fastify, xterm headless…) y est. Les seules
  dépendances à l'exécution sont donc ces deux paquets et leurs dépendances propres.
- `src/cli/version.ts:19` — `readVersion()` remonte jusqu'au `package.json` du paquet.
  `aid --version` (`src/cli/aid.ts:60-65`) et `aid doctor` l'affichent.
- `src/daemon/updateCheck.ts:9,27` — `repoRootFrom` cherche un `.git` en remontant ;
  `checkForUpdate` compare `HEAD` à `git ls-remote origin main`. `UpdateWatcher`
  (`src/daemon/updateWatcher.ts:6`) le relance toutes les 30 min. **Sans `.git`, le
  watcher ne fait rien et `GET /api/daemon/update` répond `available: false` à jamais.**
- `src/daemon/selfUpdate.ts:26,49` — `pullAndBuild(repoDir)` puis `spawnRespawnWatcher(pid,
  entry, home)` : un process détaché attend la mort du daemon et relance
  `process.execPath entry daemon`. **`process.execPath` est le Node du daemon courant** :
  pour une release qui embarque son propre Node, ce n'est pas le bon.
- `src/cli/aid.ts:80-150` — `updateRequested` (bouton de l'UI) et `cycleRequested` (ouverture
  d'AID.app) : les deux passent par `repoRootFrom(dirname(entry))` ; `cycle` relance
  toujours, `update` seulement si pull et build réussissent.
- `src/daemon/routes/daemon.ts:35,58,74` — `GET /api/daemon/update` (`available`,
  `localSha`, `remoteSha`, `lastError`), `POST /api/daemon/update` (409 si agents vivants
  sans `force`), `POST /api/daemon/cycle`.
- `web/src/ecrans/Accueil.tsx:35,197-228` — bandeau « Nouvelle version d'aidboard disponible :
  origin/main a avancé (sha) », bouton « Mettre à jour », sondage de `lastError`. Le texte
  parle de git, pas de version.
- `src/cli/commands/start.ts:12` — `spawnDetachedDaemon` relance `process.execPath` +
  `realpathSync(process.argv[1])` : même dépendance au Node courant.
- `app/src-tauri/tauri.conf.json` — `frontendDist: ../loading` (une page d'attente), `bundle.targets:
  all`, `resources: ["repo-path.txt"]`. Pas de plugin updater, pas de clé de signature.
- `app/src-tauri/src/daemon_bridge.rs:54,102,119` — `repo_path()` lit `repo-path.txt` et fait
  `cd <repo> && aid --cycle` dans un `zsh -i -l` ; sous Windows, la même commande dans
  `wsl.exe`. `README.md:16` : le daemon ne tourne jamais en natif sous Windows.
- `scripts/build.sh` — pull, `mise install`, `npm install`, build, puis `tauri build` et copie
  dans `/Applications/AID.app`. C'est l'« installation » actuelle, réservée à cette machine.
- `.github/` — **aucun workflow**. Pas de CI, aucune release publiée (`gh release list` vide).
- `mise.toml` — `node = "22"` ; `engines` `>=22.12 <25` (D4).
- Modèle à portée de main : codegraph 1.6.0 s'installe par un paquet par plateforme
  (`@colbymchenry/codegraph-darwin-arm64`…) qui contient **son propre binaire `node`**
  (115 Mo), `lib/dist` et ses natifs. Zéro prérequis chez l'utilisateur.

## 3. Cible et hors-périmètre

Cible :

- Une page de releases où l'on télécharge **AID Board** (`.dmg` macOS arm64 et x64,
  `.AppImage` et `.deb` Linux x64, `.msi` Windows x64) et **AID Server**
  (`aid-server-<version>-<os>-<arch>.tar.gz` pour darwin-arm64, darwin-x64, linux-x64,
  linux-arm64), avec `SHA256SUMS`, `install-server.sh` et `latest.json` (updater Tauri).
- AID Server installé dans `~/.aid/server/<version>/` avec un lien `current` ; `aid` est
  `~/.aid/server/current/bin/aid`. Le daemon sait dans quel **mode** il tourne : `repo`
  (un `.git` au-dessus du build, comportement d'aujourd'hui) ou `release` (sous
  `~/.aid/server/`). En mode `release`, « Mettre à jour » télécharge la release suivante,
  la vérifie, bascule `current` et relance. En mode `repo`, rien ne change.
- AID Board sans `repo-path.txt` : au lancement, il prend `~/.aid/server/current/bin/aid`
  s'il existe, sinon `aid` sur le PATH (le développeur), sinon il installe la dernière
  release d'AID Server puis la lance. Il se met à jour lui-même par l'updater Tauri.
- Un workflow « Release » déclenché à la main avec un numéro de version : il fixe la version
  dans `package.json` et `tauri.conf.json`, commite, pose le tag `v<version>`, construit les
  deux familles d'artefacts et publie la release. Un workflow « CI » lance le gate sur
  chaque PR et sur `main`.

Hors périmètre : publication sur npm (le README cesse de la promettre) ; AID Server natif
Windows (WSL2 reste la règle, le Board y installe `linux-x64`) ; signature et notarisation
Apple (DR14) ; téléchargement authentifié ou dépôt privé ; canal « beta » ; migration des
données `~/.aid` (inchangées, `migrations/` fait déjà ce travail) ; séparation du superviseur
de PTY (les agents meurent au redémarrage, assumé).

## 4. Décisions prises

- **DR1 — Un dépôt, deux produits, une seule version.** `package.json.version` est la source ;
  le workflow de release la recopie dans `tauri.conf.json`. Board et Server portent le même
  numéro à chaque release ; le Board tolère un Server d'une autre version et affiche les
  deux dans Réglages. Pas de second dépôt : le contrat HTTP/WS entre les deux est dans
  `src/shared`, il reste testé au même endroit.
- **DR2 — Une release est un tag, mais personne ne gère de tag.** Le workflow `release.yml`
  (`workflow_dispatch`, entrée `version`) fait le bump, le commit sur `main`, le tag et la
  publication. Aucun `git tag` à la main, aucun bump de version dans une PR ordinaire (règle
  d'exécution inchangée : ne bump aucune version).
- **DR3 — AID Server embarque son Node.** Archive = `node/` (binaire officiel de la version
  LTS 22 épinglée par `mise.toml`, lue au packaging), `dist/`, `node_modules/` des seules
  dépendances d'exécution (`npm ci --omit=dev` depuis le tarball `npm pack`, natifs compilés
  **sous ce même Node** sur le runner cible), `migrations/`, `kernel/`, `scripts/git`,
  `scripts/hooks`, `README.md`, `VERSION`, et un lanceur `bin/aid` (shell) qui exécute
  `node/bin/node dist/cli/aid.js "$@"`. Pas de Node SEA ni de `pkg` : les deux natifs ne s'y
  embarquent pas proprement, et le modèle codegraph prouve que l'archive suffit.
- **DR4 — Disposition sur disque.** `~/.aid/server/<version>/` (une archive extraite),
  `~/.aid/server/current` → lien symbolique vers la version active, les deux dernières
  versions gardées (retour arrière par `aid server use <version>`), les plus anciennes
  purgées à l'installation suivante. Jamais d'écriture dans `/usr/local` ni de `sudo`.
- **DR5 — Deux modes, détectés, jamais configurés.** `installMode(entry)` : `release` si le
  chemin réel du build est sous `~/.aid/server/`, `repo` si `repoRootFrom` trouve un `.git`,
  `inconnu` sinon (mise à jour désactivée, `aid doctor` le dit). Le mode gouverne la
  vérification (`git ls-remote` ou API GitHub), l'action (pull+build ou télécharger+basculer)
  et le texte du bandeau.
- **DR6 — Vérification des releases par l'API GitHub publique.** `GET
  https://api.github.com/repos/morzu117/aidboard/releases/latest`, sans jeton (dépôt public,
  60 requêtes/h/IP largement au-dessus d'un sondage toutes les 30 min), `User-Agent` posé,
  délai 5 s, hors-ligne → `null` comme aujourd'hui. Comparaison semver avec la version
  courante. Un seul endroit : `src/daemon/releaseCheck.ts`.
- **DR7 — Installation vérifiée, bascule atomique.** Télécharger l'archive de la plateforme
  dans `~/.aid/server/<version>.partial/`, vérifier son SHA-256 contre `SHA256SUMS` de la
  même release, extraire, renommer en `<version>/`, puis remplacer `current` par un nouveau
  lien (`rename` d'un lien temporaire : atomique). Toute étape qui échoue laisse `current`
  intact et le daemon courant en vie, avec `lastError` renseigné, comme pour pull+build.
- **DR8 — Le relanceur relance la nouvelle version avec son Node.** `spawnRespawnWatcher`
  prend `{ execPath, entry }` explicites au lieu de `process.execPath` implicite. En mode
  `release`, c'est `~/.aid/server/<nouvelle>/node/bin/node` et son `dist/cli/aid.js`. En
  mode `repo`, les valeurs d'aujourd'hui. `spawnDetachedDaemon` suit la même règle.
- **DR9 — Un seul installeur, pour les humains et pour le Board.** `install-server.sh`
  (publié comme asset de release, servi aussi par l'URL stable
  `releases/latest/download/install-server.sh`) : détecte os/arch, télécharge l'archive et
  `SHA256SUMS`, vérifie, installe selon DR4, affiche la commande à ajouter au PATH. Le
  Board l'exécute tel quel (`curl -fsSL … | sh`, dans WSL2 sous Windows) : aucune logique
  d'installation dupliquée en Rust.
- **DR10 — Le Board se met à jour par l'updater Tauri.** `tauri-plugin-updater` avec
  `latest.json` et les bundles signés (paire de clés minisign générée une fois, clé privée
  en secret GitHub `TAURI_SIGNING_PRIVATE_KEY`, publique dans `tauri.conf.json`).
  Sans signature valide l'updater refuse : c'est voulu.
- **DR11 — Le Board ne lit plus `repo-path.txt`.** Ordre de résolution : `AID_SERVER_BIN`
  (variable d'environnement, pour tester), `~/.aid/server/current/bin/aid`, `aid` sur le
  PATH, sinon installation (DR9). La ressource Tauri disparaît ; `scripts/build.sh` ne
  l'écrit plus.
- **DR12 — Linux : construit sur le plus vieux Ubuntu supporté par les runners (22.04)**
  pour la compatibilité glibc ; `arm64` sur le runner `ubuntu-22.04-arm`. macOS : `macos-14`
  (arm64) et `macos-13` (x64). Pas d'universal : deux `.dmg`.
- **DR13 — Les tests ne touchent jamais le réseau ni le vrai `~/.aid`.** API GitHub et
  téléchargements passent par une fonction `fetch` injectée ou un serveur HTTP local du
  test ; `AID_HOME` temporaire partout, comme pour le reste du dépôt.

Ce que l'exécutant ne décide pas : le format des noms d'assets ci-dessus, la liste des
cibles, l'emplacement `~/.aid/server`, l'ordre de résolution DR11, le nom des clés de
config (aucune nouvelle clé dans `config.yaml` : tout est détecté).

Décisions tranchées le 2026-10-20 (anciennes DO1 à DO3) :

- **DR14 — Pas de notarisation Apple en 0.x.** Pas de Developer ID : Gatekeeper affiche
  « application non vérifiée » à la première ouverture du `.dmg`, le README documente le
  clic droit → Ouvrir. L'updater Tauri a sa propre signature (DR10) et ne dépend pas
  d'Apple. À reconsidérer quand il y aura des utilisateurs hors du cercle.
- **DR15 — Windows : `.msi` seul.** Pas de bundle NSIS.
- **DR16 — Les releases `0.x` ne sont pas marquées `prerelease`.** `releases/latest` doit
  toujours répondre : c'est ce que sondent DR6 et l'updater, et ce que télécharge
  `install-server.sh` par défaut.

## 5. Contrat

```ts
// src/shared/model.ts (insertion)
export type InstallMode = 'repo' | 'release' | 'inconnu';
export interface UpdateInfo {
  mode: InstallMode;
  version: string;                 // version qui tourne
  available: boolean;
  latest: string | null;           // mode release : version ; mode repo : sha court
  lastError: string | null;
}

// src/daemon/install.ts (nouveau)
export function installMode(entry: string, home: string): InstallMode;
export function serverDir(home: string): string;               // ~/.aid/server
export function currentServer(home: string): { version: string; dir: string } | null;
export function assetName(version: string, platform = process.platform, arch = process.arch): string;
//   aid-server-<version>-<darwin|linux>-<arm64|x64>.tar.gz ; lève pour toute autre plateforme

// src/daemon/releaseCheck.ts (nouveau)
export interface Release { version: string; assets: Record<string, string> } // nom → URL
export function latestRelease(fetchFn?: typeof fetch): Promise<Release | null>;   // null hors ligne
export function newerThan(current: string, latest: string): boolean;             // semver, pré-release ignorée

// src/daemon/selfUpdate.ts (évolution)
export interface Launch { execPath: string; entry: string }
export function spawnRespawnWatcher(pid: number, launch: Launch, home: string): void;
export function installRelease(
  release: Release, home: string,
  opts: { fetchFn?: typeof fetch; log?: (l: string) => void },
): Promise<{ ok: true; launch: Launch } | { ok: false; step: 'download' | 'verify' | 'extract' | 'switch'; error: string }>;
export function pruneServers(home: string, keep = 2): string[];                 // versions supprimées

// src/daemon/updateWatcher.ts (évolution)
constructor(opts: { mode: InstallMode; from: string; branch?: string; fetchFn?: typeof fetch })

// CLI (src/cli/commands/server.ts, nouveau)
aid server status                 // mode, version, dossier, versions installées
aid server install [version]      // depuis les releases (défaut : latest) — mode release uniquement
aid server use <version>          // bascule current (retour arrière), demande un redémarrage
```

HTTP : `GET /api/daemon/update` rend `UpdateInfo` (les champs `localSha`/`remoteSha`
disparaissent ; `web/` est le seul client, mis à jour au même point). `POST
/api/daemon/update` et `/cycle` gardent leur signature ; leur effet dépend du mode.

Archive (DR3), à la racine :

```
bin/aid               # #!/bin/sh — exec "$(dirname "$0")/../node/bin/node" "$(dirname "$0")/../dist/cli/aid.js" "$@"
node/bin/node
dist/  node_modules/  migrations/  kernel/  scripts/git/  scripts/hooks/  README.md  VERSION
```

## 6. Points

### 13.1 — CI : le gate sur chaque PR et sur `main`

Fichiers : `.github/workflows/ci.yml` (nouveau : `ubuntu-22.04` × Node `22` et `24` selon
D4, `npm ci`, `npm run gate` ; `apt install build-essential python3` pour node-pty),
`docs/chantiers/README.md` (ligne 13 dans le tableau §9).

Pas de test (c'est la CI elle-même). Vérification : le workflow passe au vert sur la PR du
chantier avant tout autre point.

### 13.2 — Mode d'installation et version exposés

Fichiers : `src/shared/model.ts` (insertion `InstallMode`, `UpdateInfo`),
`src/daemon/install.ts` (nouveau : `installMode`, `serverDir`, `currentServer`,
`assetName`), `src/daemon/routes/daemon.ts` (`GET /api/daemon/update` rend `UpdateInfo`),
`src/cli/aid.ts` (passe `mode` et `version` au daemon), `src/cli/commands/doctor.ts`
(ligne « installation : mode repo (clone) / release 0.2.0 (~/.aid/server) / inconnue »),
`web/src/ecrans/Accueil.tsx` et `Reglages.tsx` (lecture de `UpdateInfo` : le bandeau
affiche « version X disponible » ou « origin/main a avancé » selon `mode` ; Réglages
affiche la version qui tourne), `test/install.test.ts` (nouveau), `test/daemon-routes.test.ts`,
`test/doctor.test.ts` (insertions).

Tests : `installMode` sur un faux `~/.aid/server/1.2.3/dist/cli/aid.js` → `release` ;
sur un dossier avec `.git` → `repo` ; ailleurs → `inconnu`. `assetName('0.2.0', 'darwin',
'arm64')` → `aid-server-0.2.0-darwin-arm64.tar.gz` ; `win32` lève. La route rend `mode` et
`version`. Vérification : `npm run gate`.

### 13.3 — Packaging d'AID Server

Fichiers : `scripts/package-server.sh` (nouveau : `npm pack` → staging → `npm ci
--omit=dev` sous le Node courant → téléchargement du Node officiel de la version lue dans
`mise.toml` pour `<os>-<arch>` (cache dans `.cache/node/`) → assemblage DR3 → `tar.gz` dans
`release/` + ligne `SHA256SUMS`), `scripts/server-launcher.sh` (le `bin/aid`),
`package.json` (`"package:server": "scripts/package-server.sh"`), `.gitignore` (`release/`,
`.cache/`), `test/package-server.test.ts` (nouveau, lent et réseau : lancé par `gate:e2e`
comme `pack.test.ts`).

Tests : l'archive contient `bin/aid`, `node/bin/node`, `dist/cli/aid.js`,
`dist/web/index.html`, `node_modules/node-pty/build/Release/pty.node`,
`node_modules/better-sqlite3/build/Release/better_sqlite3.node`, `migrations/001_init.sql`,
`VERSION` ; rien de `src/`, `test/`, `.codegraph/`, `node_modules/.bin/tsup` ; extraite dans
un dossier vierge, `bin/aid doctor` avec `AID_HOME` temporaire passe **avec le PATH vidé de
tout Node** (c'est la preuve que l'archive se suffit). Vérification : `npm run gate:e2e`.

### 13.4 — Vérification des releases

Fichiers : `src/daemon/releaseCheck.ts` (nouveau : `latestRelease`, `newerThan`),
`src/daemon/updateWatcher.ts` (stratégie par mode : `repo` → `checkForUpdate` comme
aujourd'hui ; `release` → `latestRelease` ; `inconnu` → rien), `src/cli/aid.ts` (branchement),
`test/release-check.test.ts` (nouveau), `test/update-check.test.ts` (insertion : watcher en
mode release avec `fetchFn` factice).

Tests : réponse GitHub factice (`tag_name: v0.3.0`, assets avec `browser_download_url`) →
`{ version: '0.3.0', assets }` ; `fetch` qui rejette → `null` ; 403 (quota) → `null` ;
`newerThan('0.2.0', '0.3.0')` vrai, `newerThan('0.3.0', '0.3.0-rc1')` faux. Jamais de
réseau réel. Vérification : `npm run gate`.

### 13.5 — Installation d'une release et bascule

Fichiers : `src/daemon/selfUpdate.ts` (`Launch`, `spawnRespawnWatcher(pid, launch, home)`,
`installRelease`, `pruneServers`), `src/cli/commands/start.ts` (`spawnDetachedDaemon`
relance par `Launch` du mode courant), `src/cli/aid.ts` (`updateRequested` et
`cycleRequested` : en mode `release`, `installRelease` puis relance de la nouvelle version ;
en mode `repo`, inchangé), `src/cli/commands/server.ts` (nouveau : `status`, `install`,
`use`), `src/cli/aid.ts` (sous-commande `server`, aide), `test/self-update.test.ts`
(insertions), `test/server-cli.test.ts` (nouveau).

Tests : serveur HTTP local du test qui sert une archive factice (un `bin/aid` shell qui
répond à `--version`) et son `SHA256SUMS` → `installRelease` crée `<version>/`, bascule
`current`, rend `launch` pointant dans la nouvelle version ; somme fausse → `step: 'verify'`,
`current` intact, `.partial` nettoyé ; `pruneServers` garde `current` et la précédente ;
`aid server use` refuse une version absente ; `spawnRespawnWatcher` reçoit l'`execPath` de
la nouvelle version (vérifié par un faux `node` qui écrit ses arguments dans un fichier).
Vérification : `npm run gate`.

### 13.6 — Installeur `install-server.sh`

Fichiers : `scripts/install-server.sh` (nouveau : `set -eu`, `uname` → os/arch, refus
explicite hors darwin/linux, `AID_SERVER_VERSION` facultatif sinon `releases/latest`,
`AID_SERVER_BASE_URL` facultatif pour les tests, `curl -fsSL`, vérification `sha256sum`
ou `shasum -a 256`, disposition DR4, message final « ajoute `~/.aid/server/current/bin` à ton
PATH, ou lance AID Board »), `test/install-server.test.ts` (nouveau : serveur HTTP local +
`AID_SERVER_BASE_URL` + `AID_HOME` temporaire).

Tests : installation dans un `AID_HOME` vierge → `current/bin/aid --version` répond ;
seconde installation de la même version → no-op ; somme fausse → code 1 et rien
d'installé. Vérification : `npm run gate`.

### 13.7 — AID Board : résolution du Server et amorçage

Fichiers : `app/src-tauri/src/daemon_bridge.rs` (`resolve_server()` selon DR11 ;
`bootstrap_server()` exécute l'installeur par `curl … | sh` dans `zsh -l` ou `wsl.exe` ;
`spawn_cycle` utilise le binaire résolu, sans `cd` ni `repo-path.txt`), `app/loading/index.html`
(états « Installation d'AID Server… » et « Mise à jour… »), `app/src-tauri/tauri.conf.json`
(retrait de `resources`), `scripts/build.sh` (n'écrit plus `repo-path.txt`), `.gitignore`.

Pas de test automatique côté Rust (pas de banc Tauri dans le dépôt) ; vérification
manuelle documentée dans le point : `AID_SERVER_BIN` vers un faux script → le Board le
lance ; `~/.aid/server` absent et PATH sans `aid` → le Board installe puis lance ; mode
développeur (`aid` du clone sur le PATH, pas de `~/.aid/server`) → inchangé. `cargo build`
et `cargo clippy` verts. Vérification : `npm run gate` puis `npm run tauri -- build`.

### 13.8 — AID Board : mise à jour par l'updater Tauri

Fichiers : `app/src-tauri/Cargo.toml` (`tauri-plugin-updater`, `tauri-plugin-process`),
`app/src-tauri/tauri.conf.json` (`plugins.updater`: `endpoints`
`https://github.com/morzu117/aidboard/releases/latest/download/latest.json`, `pubkey`),
`app/src-tauri/capabilities/default.json` (permissions updater et process),
`app/src-tauri/src/lib.rs` (vérification au lancement, après l'ouverture de la fenêtre ;
proposition par dialogue natif ; installation puis relance), `README.md` (clé publique et
procédure de génération de la paire, clé privée jamais dans le dépôt).

Vérification : `cargo build` vert ; avec un `latest.json` local et une version inférieure
dans `tauri.conf.json`, le dialogue apparaît ; signature absente → refus journalisé.

### 13.9 — Workflow « Release »

Fichiers : `.github/workflows/release.yml` (nouveau, `workflow_dispatch` entrée `version` ;
jobs : `version` (vérifie semver et absence du tag, bump `package.json` + `package-lock.json`
+ `tauri.conf.json`, commit « release: v<version> », tag, push), `server` (matrice DR12,
`npm ci`, `npm run build`, `npm run package:server`, upload artefacts), `board` (matrice
macos-14, macos-13, ubuntu-22.04, windows-latest ; `tauri-apps/tauri-action` avec
`TAURI_SIGNING_PRIVATE_KEY` ; génère `latest.json`), `publish` (concatène `SHA256SUMS`,
ajoute `install-server.sh`, crée la release `v<version>` avec notes générées, jamais
`prerelease` (DR16))), `docs/chantiers/README.md`.

Pas de test ; vérification : une release `v0.2.0` publiée depuis le workflow, avec les
13 assets attendus ; `curl -fsSL …/install-server.sh | sh` sur une machine sans Node
installe et `aid doctor` passe.

### 13.10 — Documentation

Fichiers : `README.md` (« Installation » : télécharger AID Board, ou `install-server.sh`
seul ; retrait de `npm i -g aidboard` et `npx aidboard` ; « Développer » : mode `repo`,
inchangé ; DR14 : ouvrir une app non notarisée), `docs/chantiers/README.md` (§9, registre
des risques : « archive corrompue ou tronquée » → SHA-256 avant bascule ; « nouvelle
version qui ne démarre pas » → `aid server use <précédente>`), `scripts/build.sh`
(en-tête : outil du développeur, pas une installation).

Pas de test ; vérification : `npm run gate` (prettier sur le markdown).

## 7. Pièges

- **ABI des natifs.** `pty.node` et `better_sqlite3.node` doivent être compilés par le
  Node embarqué, pas par celui du runner : `package-server.sh` installe les dépendances
  avec le Node téléchargé (ou vérifie que `node -p process.versions.modules` coïncide).
  Un décalage donne « was compiled against a different Node.js version » au premier
  `aid`, visible seulement chez l'utilisateur.
- **`realpathSync(process.argv[1])` à travers `current`.** Après la bascule, le daemon
  courant tourne encore depuis l'ancien dossier réel ; `Launch` doit être construit depuis le
  dossier **cible**, pas depuis `argv[1]` résolu.
- **Quarantaine macOS.** Un `node` téléchargé par un navigateur porte
  `com.apple.quarantine` et Gatekeeper le bloque ; `curl` ne pose pas l'attribut. Si le
  Board télécharge autrement que par `curl`, retirer l'attribut après extraction.
- **Quota API GitHub.** 60 requêtes/h/IP sans jeton : un sondage toutes les 30 min par
  daemon tient, un `tick()` au démarrage aussi ; ne jamais sonder depuis le web (chaque
  onglet serait un client). `403` est un « on ne sait pas », pas une erreur affichée.
- **Updater Tauri sans signature valide = pas de mise à jour, silencieusement.** Vérifier
  `latest.json` (`signature` par plateforme) dans le job `publish` avant de publier.
- **WSL2 : `~/.aid/server` vit dans WSL2.** `install-server.sh` doit y tourner (`wsl.exe -e
  bash -lc`), et l'archive est `linux-x64` même sur un Windows arm64 tant que WSL2 y est
  x64 ; détecter avec `uname -m` **dans** WSL2.
- **`npm ci --omit=dev` depuis le tarball** : `prepack` lance `npm run build` ; passer
  `--ignore-scripts` au `pack` (comme `pack.test.ts`) et builder avant.
- **Le gate existant ne touche pas le réseau** ; 13.3 et 13.9 en ont besoin : ils restent
  dans `gate:e2e` et la CI, jamais dans `gate`.
- **`rejectUnknown` de `config.yaml`** : ce chantier n'ajoute aucune clé ; si l'exécutant
  en ressent le besoin (URL de base, dossier), c'est une escalade, pas une clé de plus.
- **Secrets** : clé privée Tauri uniquement en secret GitHub ; aucun jeton GitHub nécessaire
  pour lire les releases d'un dépôt public.

## 8. Fini quand

- Une machine sans Node, sans git, sans clone : télécharger AID Board depuis les releases,
  l'ouvrir, il installe AID Server, le lance et affiche le board. `aid doctor` depuis
  `~/.aid/server/current/bin/aid` passe.
- La même machine, release suivante publiée : le bandeau annonce « version X disponible »,
  « Mettre à jour » installe, bascule, relance ; `aid server status` montre les deux
  versions ; `aid server use <précédente>` revient en arrière. Le Board propose sa propre
  mise à jour et l'applique.
- Le développeur : clone sur `main`, `npm link`, `aid` ; le bandeau parle toujours
  d'`origin/main`, « Mettre à jour » fait toujours pull et build. Rien n'a changé pour lui.
- Publier une release = un `workflow_dispatch` avec un numéro ; aucun tag ni bump à la main.
- `npm run gate` vert et CI verte sur chaque PR ; `gate:e2e` couvre l'archive.
- Plus aucune mention de `npm i -g aidboard`, `npx aidboard` ni `repo-path.txt` dans le
  dépôt.
