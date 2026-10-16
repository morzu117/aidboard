# 06 — Statuts réels, Accueil et Boîte de réception (v0.2)

## Pourquoi

Après la v0.1, Julien a relevé deux écarts :

1. L'Accueil ne suit pas la maquette 1.1. Une section « Projets » inventée a été ajoutée,
   alors que les cartes, les filtres de statut, la consigne et la légende manquent. La
   Boîte de réception (1.2) n'existe pas.
2. Un dépôt sans remote `origin` ne peut pas devenir un projet : le daemon répond 422.

Le 2026-10-16, Julien a fixé le périmètre :

- **« Maquettes + backend v0.2 »** :
  - la barre complète, avec Boîte de réception, Consignes, Réglages et la recherche ⌘K ;
  - des cartes fidèles à la maquette : aperçu du terminal, message à l'agent, Agrandir,
    demandes avec leurs boutons ;
  - les filtres de statut, la légende et la consigne à tous les agents ;
  - l'écran 1.2 ;
  - les hooks Claude Code, pour que statuts et demandes soient réels.
- **« Accepter sans origin »** : un dépôt purement local devient un projet. Sa base est une
  branche locale, ses worktrees en partent, et le nettoyage compare à cette branche.

Ce chantier livre le critère de la v0.2 du brief (§11) : *un agent qui attend une
permission est repéré sans ouvrir son terminal*.

## État actuel

- v0.1 mergée sur `main` (PR #1 à #7). La branche `feat/selecteur-dossier` ajoute
  l'explorateur de dossiers, un correctif du terminal, la relation projets 0..N et le rôle
  « libre ». La branche `feat/maquettes-v0.2` en part (branches empilées).
- Statuts : seuls `agent.spawned` et `agent.exited` sont projetés. Un agent vivant reste
  en `starting`, affiché « Lancé · statut non suivi » (D14).
- `POST /api/events` accepte déjà les événements d'un agent, avec le token de run
  (`AID_TOKEN`). Il les limite aux sources `hook:claude`, `codex:json`, `heuristic` et aux
  types `agent.status`, `agent.tool`, `approval.requested`, `files.changed`, `cost`,
  `run.command`.
- Le daemon garde un miroir headless de chaque terminal (`TerminalMirror`, avec
  `screen()` et `allLines()`).
- Maquettes de référence : `design/maquettes/aid-1-1-accueil.html` et
  `aid-1-2-boite-de-reception.html`, états default, empty, loading, error et hover.

## Faits vérifiés sur les hooks Claude Code (doc code.claude.com/docs/en/hooks, 2026-10-16)

- Les hooks sont déclarés dans `~/.claude/settings.json`, sous cette forme :
  `{"hooks": {"<Event>": [{"matcher": "*", "hooks": [{"type": "command", "command": "…", "timeout": 5}]}]}}`.
  `UserPromptSubmit` et `Stop` ignorent le `matcher`. Pour `Notification`, le `matcher`
  porte sur `notification_type`.
- La commande est lancée par un shell et hérite de l'environnement de la session `claude`,
  donc des `AID_*` du PTY.
- Le hook reçoit un JSON sur stdin. Champs communs : `session_id`, `cwd`, `hook_event_name`.
  - `PreToolUse` : `tool_name`, `tool_input`, `tool_use_id`. Pour `AskUserQuestion`,
    `tool_input.questions[]` contient `question`, `header`, `options[].label` et
    `multiSelect`.
  - `PermissionRequest` : `tool_name`, `tool_input`, `permission_suggestions`.
  - `Notification` : `message`, `title`, et `notification_type` parmi `permission_prompt`,
    `idle_prompt`, `elicitation_dialog`, …
  - `Stop` : `stop_hook_active`, `last_assistant_message`.
  - `SessionEnd` : `reason` parmi `clear`, `resume`, `logout`, `prompt_input_exit`,
    `other`.
- Pour rester silencieux : sortir en 0, sans rien écrire sur stdout ni stderr. Un hook
  `PermissionRequest` qui ne répond rien laisse le dialogue s'afficher normalement.
- Claude Code lit ses hooks au démarrage. Une session déjà ouverte ne voit pas un hook
  ajouté ensuite.

## Décisions prises dans ce plan (à montrer à Julien, non bloquantes)

| N° | Décision | Pourquoi |
| --- | --- | --- |
| E1 | **Commande de hook neutre hors A-I-D.** `aid hooks install` écrit `[ -z "$AID_HOOK" ] \|\| "$AID_HOOK" <Event>`. Le daemon injecte `AID_HOOK` dans chaque PTY : c'est le chemin absolu de `scripts/hooks/aid-hook.sh` livré dans le paquet. Ce script lance `"$AID_NODE" "$AID_CLI" hook "$1"`, deux chemins absolus injectés eux aussi. | Hors A-I-D, la variable est vide : le hook ne lance rien et ne coûte rien. Pas de dépendance au `PATH` ni à `npm i -g`. Une mise à jour du paquet ne casse pas la configuration. |
| E2 | **Événements utilisés** : `UserPromptSubmit` → `working` ; `PreToolUse` → `working` + `agent.tool` (et `needs_input/question` pour `AskUserQuestion`) ; `PostToolUse` → `working` ; `PermissionRequest` → `needs_input/permission` ; `Notification` `elicitation_dialog` → `needs_input/question` ; `Stop` → `idle`. On n'utilise **pas** `SessionEnd` : la spec en fait `stopped`, mais un `/clear` le déclenche sans que le process s'arrête. `agent.exited` (daemon) reste la seule fin. | Sans `PostToolUse`, une permission accordée laisserait l'agent en « Attend une réponse » jusqu'au prochain outil. |
| E3 | **Sous-sessions** : la première `session_id` reçue d'un agent devient la sienne. Un événement venu d'une autre session (un `claude -p` lancé par l'agent hérite de ses `AID_*`) ne compte que comme `agent.tool`. Il ne change jamais le statut. | Sinon, le `Stop` d'un agent de phase ferait passer l'orchestrateur en « À relire ». |
| E4 | **Répondre à une demande** se fait au clavier, dans le PTY. Une permission : `1` pour Autoriser une fois, `2` pour « Toujours … », `Échap` pour Refuser. Une question : le chiffre de l'option. Avant d'envoyer une touche, le daemon vérifie sur le miroir que l'écran montre bien cette option (par exemple `1. Yes`, ou `2. <libellé>`). Sinon : 409, « l'écran ne montre plus cette demande : ouvrir le terminal ». « Toujours … » n'est proposé que si `permission_suggestions` n'est pas vide. Une question multiple ou à choix multiples n'a pas de boutons : seulement « Ouvrir le terminal ». | Le terminal reste la vérité. Un hook `PermissionRequest` bloquant qui attendrait le clic empêcherait de répondre dans le terminal. La vérification d'écran évite qu'un `1` arrive dans la zone de saisie. |
| E5 | **Pause = SIGSTOP** du groupe de process, **Reprendre = SIGCONT**. Il ne s'agit pas d'un nouveau statut : un champ `pausedAt` s'ajoute. L'affichage « En pause » l'emporte sur le statut, et le statut d'origine est retrouvé à la reprise. `stop()` envoie SIGCONT avant ses signaux d'arrêt. | Les statuts de la spec restent fermés. Un process stoppé ne traite pas SIGINT ni SIGTERM avant d'être relancé. |
| E6 | **Consigne à tous les agents** : elle est envoyée tout de suite aux agents `claude` et `codex` vivants et inactifs (`idle`, réel ou estimé). Jamais à un shell, qui exécuterait le texte. La case « Ajouter aux consignes globales » est **absente**, et l'aide devient « Envoyée maintenant aux agents inactifs. » | La spec interdit à A-I-D d'ajouter une option de lancement ou d'écrire un fichier de consignes : il n'existe donc pas de « reçue au démarrage par les suivants ». À rouvrir avec Julien. |
| E7 | **Consignes et Réglages ne sont pas maquettés.** Ce sont deux pages sobres, construites avec les classes existantes. Réglages : projets (liste, ajout, retrait d'un projet sans sujet ouvert), hooks (état, installation), notifications. Consignes : pour chaque projet, en lecture seule, la présence de `CLAUDE.md` et `AGENTS.md`, la version du bloc agentkit et `~/.agent-kernel/VERSION`. | La nav les montre dans les maquettes. Les liens ne doivent pas mener nulle part. |
| E8 | **L'heuristique ne s'applique qu'aux agents `claude` et `codex` sans signal de hook.** Elle passe à « En cours · estimé » quand une sortie a eu lieu dans les 5 dernières secondes. Après 30 s de silence, « Inactif · estimé » (« À relire · estimé » sur la carte 1.1). Si la dernière ligne non vide ressemble à une invite (`(y/n)`, `[Y/n]`, `❯ 1.`, une fin en `?`), elle passe à « Attend une réponse · estimé », raison `question`. Un shell n'est jamais estimé : il s'affiche « shell », en gris. Dès le premier événement de hook, l'heuristique se tait pour cet agent. | La légende de la maquette définit « estimé » : un statut déduit du terminal, sans signal sûr. |
| E9 | **Hors de ce chantier** : `notify` de Codex, la vue diff, la reprise `claude --resume`, la colonne « À démarrer · issues GitHub », « Sujet distant à adopter », le filtre « Inclure grokbot », le relais `aid-inbox`, et tout ce qui concerne les PR et `distant`. Ces éléments sont absents du DOM, ni grisés ni désactivés (règle du plan 04). | Le périmètre choisi par Julien. Ces éléments n'ont pas de données avant les v0.3 à v0.5. |
| E10 | **L'installation des hooks modifie la configuration de Julien.** `aid hooks install` (ou le bouton des Réglages, après confirmation) sauvegarde d'abord `settings.json` en `settings.json.aid-<horodatage>.bak`. Il fusionne ensuite les entrées sans toucher au reste, et ne fait rien de plus si elles y sont déjà. `aid hooks uninstall` retire exactement ces entrées. Aucun test ni agent de dev ne touche au vrai `~/.claude` : tout passe par `CLAUDE_CONFIG_DIR` ou par un `HOME` de test. | C'est une action sur la machine de Julien. Elle exige son clic ou sa commande. |

## Points

Un point = un commit, avec la gate complète verte (`npm run gate`). Pour les points qui
touchent l'UI, `npm run gate:e2e` aussi. Pas de bump de version.

### 06.1 — Dépôts sans origin

- Migration `002_depot_local.sql` : `ALTER TABLE workspaces ADD COLUMN remote TEXT DEFAULT 'origin'`.
  `NULL` désigne un dépôt purement local.
- `inspectRepo` rend `currentBranch` (`symbolic-ref --short HEAD`). Dans
  `POST /api/workspaces`, sans origin, la base vaut la branche précisée ou, à défaut, la
  branche courante. Elle doit exister dans `refs/heads`. L'enregistrement réussit avec un
  avertissement : « dépôt sans remote origin : les sujets partiront de la branche locale X ».
- `Workspace.remote` (modèle, instantané). Les scripts reçoivent `AID_REMOTE` (vide si
  local). `topic-create.sh` ne lance `fetch` que si un remote existe, et part de
  `$AID_REMOTE/$AID_BASE` ou de `$AID_BASE`. `topic-cleanup.sh` compare à la même référence.
- En-tête 1.3 : la base s'affiche `origin/main`, ou `main` pour un projet local.
- Amender le §5 du brief.
- Tests : enregistrement sans origin (base = branche courante, `remote: null`,
  avertissement) ; base absente refusée ; création et nettoyage d'un sujet dans un dépôt
  local ; migration 002 sur une base existante ; pastille de base.

### 06.2 — Statuts projetés

- Migration `003_statuts.sql` sur `agents` : `status_reason`, `status_message`,
  `status_source`, `status_at`, `session_id`, `last_tool`, `pending` (JSON de la demande
  en cours), `paused_at`.
- `Agent` dans `src/shared/model.ts` gagne `statusReason`, `statusMessage`,
  `statusSource` (`'hook' | 'heuristic' | 'daemon' | null`), `statusAt`, `lastTool`,
  `pending` (`{ id, kind: 'permission' | 'question', question, options: {label, key}[] } | null`)
  et `pausedAt`. L'instantané les rend.
- Projecteur `agent.status` :
  - ignoré si l'agent est `done`, `error` ou `stopped` (rejeu tardif) ;
  - venu d'une source agent, `status` doit valoir `working`, `needs_input` ou `idle`, sinon
    il est ignoré ;
  - E3 : si l'événement porte un `sessionId` différent de la `session_id` connue, seul
    `last_tool` est mis à jour ;
  - `heuristic` est ignoré quand `status_source = 'hook'` ;
  - `needs_input` enregistre `pending` depuis `data.pending` ; tout autre statut le vide ;
  - le champ `paused` n'est lu que si la source est `daemon` (E5).
- Projecteur `agent.tool` : `last_tool` (`"Bash(npm test)"`, tronqué à 200 caractères).
  `approval.resolved` vide `pending`.
- Le test de reconstruction des projections depuis le journal couvre les nouvelles colonnes.

### 06.3 — `aid emit` et spool

- `aid emit <type> [--status s] [--reason r] [--message m] [--data json]`. Sans
  `AID_AGENT`, ne fait rien et sort en 0. Sinon, complète l'enveloppe (`v`, `id` ULID,
  `ts`, `source` par défaut `hook:claude`, `agentId`, `runId`) et la poste à
  `$AID_URL/api/events` avec `Authorization: Bearer $AID_TOKEN`, délai de 2 s. En cas
  d'échec réseau, écrit `~/.aid/spool/<id>.json` (dossier en 0700, fichier en 0600) et sort
  en 0.
- Au démarrage, le daemon rejoue le spool. Chaque fichier passe par les mêmes contrôles que
  `POST /api/events` pour un principal `run` : source et type autorisés, agent qui
  appartient au `runId` de l'enveloppe. Il est ajouté au journal (l'`id` rend l'ingestion
  idempotente), puis supprimé. Un fichier invalide est déplacé dans `spool/rejet/`.
- Tests : no-op sans `AID_AGENT` ; poste réussi ; daemon absent → spool ; rejeu ; rejet d'un
  type réservé.

### 06.4 — Hooks Claude Code

- Le daemon injecte `AID_HOOK`, `AID_NODE` et `AID_CLI` dans chaque PTY (E1).
  `scripts/hooks/aid-hook.sh` est livré dans le paquet (`files` de `package.json`).
- `aid hook <Event>` lit stdin (64 Kio au plus, coupé à 1 s), applique la table E2,
  appelle la logique d'`emit`, n'écrit jamais rien et sort toujours en 0.
  - `PermissionRequest` : `pending = { id: tool_use_id ou ULID, kind: 'permission',
    question: "autoriser <Outil>(<résumé>) ?", options }`.
  - `AskUserQuestion` avec une seule question à choix unique : `kind: 'question'`, options
    tirées de `tool_input`.
  - Le résumé de l'entrée : `command` pour Bash, `file_path` pour Edit, Write et Read,
    `pattern` pour Grep et Glob, sinon rien. 120 caractères au plus.
- `aid hooks install | status | uninstall` agit sur `$CLAUDE_CONFIG_DIR/settings.json`
  (par défaut `~/.claude/settings.json`), selon E10. Les entrées sont reconnues à la
  sous-chaîne `AID_HOOK`.
- Routes (principal admin seulement) : `GET /api/hooks` rend
  `{ installed, missing[], path }` ; `POST /api/hooks/install` exige `{ confirm: true }`.
- `aid doctor` ajoute une ligne : hooks Claude Code installés, ou absents (« statuts
  estimés seulement »).
- Tests : table des événements sur des charges réelles (fixtures JSON) ; silence et code
  0 quand le daemon est absent ; installation idempotente qui préserve les autres clés et
  les autres hooks ; sauvegarde créée ; désinstallation exacte ; `HOME` de test.

### 06.5 — Heuristique

- `AgentManager` note pour chaque agent l'heure de sa dernière sortie. Un minuteur de 2 s
  applique E8 et n'émet `agent.status` (source `heuristic`) qu'**aux transitions**. Les
  données portent `silenceMs`, `lastLine` (200 caractères au plus) et `promptDetected`, pour
  l'infobulle.
- Tests avec de fausses horloges : sortie → en cours ; silence → inactif ; invite →
  attend ; un hook coupe l'heuristique ; un shell n'est jamais estimé.

### 06.6 — Routes de pilotage des agents

Toutes ces routes exigent un principal admin. Elles répondent 409 si l'agent est terminé.

- `GET /api/agents/:id/screen?lines=6` : dernières lignes non vides du miroir (au plus 40).
  Hors process vivant, depuis le journal (`TerminalMirror.fromLog`).
- `POST /api/agents/:id/input { text }` : 4000 caractères au plus. Une ligne seule est
  envoyée telle quelle ; plusieurs lignes passent en collage encadré (`ESC[200~…ESC[201~`).
  Puis `\r`. Refus en 409 si une demande est en cours (« répondre d'abord à la demande »).
- `POST /api/agents/:id/answer { pendingId, option }` : E4. Émet
  `approval.resolved { pendingId, option, by: 'human' }` (source `daemon`).
- `POST /api/agents/:id/pause` et `/resume` : E5, émettent `agent.status` source
  `daemon` avec `{ paused: true | false }`.
- Tests : chaque route ; refus d'un token de run ; vérification d'écran (option absente →
  409, rien n'est écrit) ; pause et reprise réelles sur un `sleep` (état `T` dans `ps`) ;
  arrêt d'un agent en pause.

### 06.7 — Barre complète et palette

- `Barre` suit la maquette :
  - `nav-accueil` mène à `/` ;
  - `nav-boite` mène à `/boite`, avec `compte`, le nombre d'agents en `needs_input`,
    caché à 0 ;
  - `nav-consignes` mène à `/consignes` ;
  - `nav-reglages` mène à `/reglages` ;
  - `est-actif` et `aria-current` suivent la route ;
  - `recherche` ouvre la palette ;
  - `relais` est absent (E9).
- Palette ⌘K / Ctrl+K : un champ et une liste filtrée. Elle propose : les sujets ouverts
  (ouvrir), « Nouveau sujet », « Ajouter un projet », et les quatre écrans. Navigation aux
  flèches, Entrée, Échap.
- Tests : liens et état actif ; compteur ; raccourci clavier ; filtrage ; Échap.

### 06.8 — Réglages et Consignes (E7)

- `/reglages` :
  - projets : nom, chemin, base, remote ou « local », nombre de sujets ouverts ;
    « Ajouter un projet » ; « Retirer » si aucun sujet ouvert, par
    `DELETE /api/workspaces/:id` qui répond 409 sinon ;
  - hooks : état, bouton « Installer les hooks » avec confirmation, et rappel « relancer
    les sessions claude ouvertes » ;
  - notifications : bouton qui demande l'autorisation du navigateur.
- `/consignes` : `GET /api/workspaces/:id/consignes` rend `{ claudeMd, agentsMd,
  blockVersion, kernelVersion }`, en lecture seule.
- **On retire la section « Projets » de l'Accueil** et ses styles (`.projets`, `.projet*`,
  `.entete-droite`).

### 06.9 — Accueil selon la maquette 1.1

- Entête : `resume.sujets` et `resume.en-attente` (« N sujets ouverts · M attendent ta
  réponse »).
- Filtres :
  - `statut-attente`, `-erreur`, `-relire`, `-cours`, `-pause`, chacun avec son compte et
    `aria-pressed`, un seul actif à la fois ;
  - séparateur ;
  - `workspace-tous` et `workspace-N` pour **tous** les projets, y compris ceux sans
    sujet.

  Un projet filtré sans sujet affiche l'état vide avec « Nouveau sujet », projet
  présélectionné. C'est la relation 0..N demandée, sans section inventée.
- Carte :
  - les agents sont des boutons qui choisissent le destinataire (`aria-pressed`,
    `est-destinataire`). Par défaut, l'agent le plus urgent ;
  - `terminal` : aperçu de `/screen` de l'agent choisi. Il se recharge à chaque nouvel
    instantané et toutes les 3 s tant que l'agent vit et que l'onglet est visible. Les
    lignes sont du texte, jamais du HTML ; les plus anciennes portent `ligne--ancienne` ;
  - `demande` si `pending` : question et options (`option-N`), réponse par `/answer`.
    Erreur 409 → message et lien « Ouvrir le terminal » ;
  - `message` : « Message à <type>… », envoyé par `/input`. Absent pour un agent
    terminé ;
  - actions :
    - `agrandir` ouvre un dialogue plein écran avec le `Terminal` de l'agent ;
    - `pause` (« Pause » ou « Reprendre ») ;
    - `ouvrir`.
  - activité : `depuis(statusAt)`, ou « en pause depuis … ».
- Statut estimé : la pastille porte `badge--estime` et `point--estime`, avec le texte
  « · estimé » (`estime`). Au survol ou au focus, l'`infobulle` montre `titre`, `source`,
  `silence`, `derniere-ligne` et `invite`.
- Consigne à tous les agents (E6) et légende (sans `distant`).
- États : `vide.message`, `vide.aide`, `vide.creer` (`vide.issues` absent), squelettes,
  bandeau d'erreur, carte d'erreur de worktree (comme en v0.1).
- `Statut.tsx` :
  - `starting` devient « Démarrage » ;
  - `idle` reste « À relire » sur la carte et devient « Tour terminé » dans la 1.2 (ou
    « Inactif · estimé » si l'heuristique en est la source) ;
  - le shell affiche « shell » en gris, ne compte pas dans l'agrégat s'il y a un autre
    agent, et n'a pas de rôle affiché ;
  - pause → « En pause ».

### 06.10 — Boîte de réception (1.2)

- `/boite` :
  - entête « N éléments sur M sujets · triés par urgence » et filtres de projet ;
  - groupes `attente`, `erreur`, `relire`, `cours`, `pause`, chacun avec titre et compte.
    Un groupe vide est absent.
- Un élément par agent vivant, plus les agents sortis en erreur d'un sujet encore ouvert :
  - `type` : Permission, Question, Tour terminé, Inactif · estimé, En cours, En pause,
    Erreur ;
  - `agent`, `workspace` / `branche`, `moment` ;
  - `question` ou `detail` : la demande, `last_tool`, le dernier message de `Stop`
    (première ligne), ou « Sortie en erreur (code N) » ;
  - actions :
    - les `option-N` d'une demande ;
    - « Ouvrir le terminal → », qui mène à `/sujets/:id?agent=:agentId`, onglet de cet
      agent sélectionné ;
    - « Reprendre » pour un agent en pause.
- Le tri à l'intérieur d'un groupe : le plus ancien `statusAt` d'abord pour l'attente et
  les erreurs, le plus récent d'abord pour les autres.
- La colonne de droite est absente (E9). `app.css` ramène `.boite-colonnes` à une colonne.
- États empty (« Rien à traiter : aucun agent n'attend ta réponse. », sans la phrase sur
  les issues), loading et error.

### 06.11 — Notifications

- Quand un agent passe en `needs_input` et que l'onglet est caché, une `Notification` du
  navigateur s'affiche si elle est autorisée. Titre « <type> attend ta réponse », corps =
  la question. Un clic mène à la carte ou au terminal. On ne notifie qu'une fois par
  `pending.id`.
- Le titre de l'onglet préfixe le compte : « (2) A-I-D ».
- Tests : une seule notification par demande ; aucune quand l'onglet est visible ; titre.

### 06.12 — e2e et recette

- e2e :
  - un shell lance `"$AID_HOOK" PermissionRequest < fixture.json`. On vérifie la carte
    (« Attend une réponse », la demande), la 1.2 et le compteur de la barre, puis `Stop`
    → « À relire ». C'est toute la chaîne : PTY → hook → daemon → UI, sans vrai `claude` ;
  - message envoyé à un shell par `/input` (écho visible) ;
  - pause et reprise ;
  - palette ;
  - projet sans origin enregistré puis sujet créé.
- `docs/recette-v0.2.md`, à faire par Julien avec un vrai `claude` : installer les hooks,
  déclencher une permission, répondre depuis la 1.2, une question `AskUserQuestion`,
  `claude -p` imbriqué (E3), une notification avec l'onglet caché.
- Brief : §4, amender les événements utilisés (E2) et la pause (E5) ; §11, la v0.2 livre
  la boîte et les statuts, mais la vue diff et le `notify` de Codex sont reportés.

## Pièges

- `PreToolUse` d'`AskUserQuestion` arrive **avant** que la question s'affiche. La
  vérification d'écran de E4 protège la réponse. Ne jamais envoyer une touche sans elle.
- Un process en SIGSTOP ne lit plus son PTY. Une saisie envoyée pendant la pause
  s'accumule et part à la reprise. `/input` refuse donc en 409 un agent en pause.
- Le rejeu du spool peut arriver après `agent.exited` : le projecteur ignore ce statut
  (06.2).
- Les tests de hooks ne doivent jamais lire ni écrire le vrai `~/.claude` (E10).
- L'aperçu du terminal vient d'un texte venu d'un agent. Il se rend comme du texte,
  jamais par `dangerouslySetInnerHTML` (§9 du brief).
- Dans la palette, ⌘K ne doit pas être capté quand le focus est dans un terminal xterm.
  Sinon, Ctrl+K n'arrive plus au shell (effacement de fin de ligne). La palette ne
  s'ouvre au clavier que hors `.xterm`.

## Fini quand

- Avec les hooks installés, un `claude` qui demande une permission apparaît en « Attend
  une réponse » sur l'Accueil et dans la 1.2. Le compteur de la barre suit. On peut
  répondre depuis la carte, sans ouvrir le terminal.
- L'Accueil et la 1.2 reprennent les éléments des maquettes, hors E9. La section
  « Projets » n'existe plus.
- Un dépôt sans origin s'enregistre, et ses sujets se créent et se nettoient.
- Les gates unitaire et e2e sont vertes.
