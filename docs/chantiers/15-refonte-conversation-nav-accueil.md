# Chantier 15 — Conversation native, barre gauche, accueil

Branche `fix/irritants-aid`, base `main`. Trois changements d'interface demandés ensemble
(brief du 2026-10-26, maquettes `design/aid-refacto-agent-ui/`) : remplacer le terminal
embarqué par un espace de conversation pour `claude` et `codex` (pilotes extensibles), avec
reprise de session transparente ; une disposition 1/4 · 2/4 · 1/4 avec barre gauche
permanente ; une nouvelle page d'accueil. Document unique, groupes A (conversation), D
(disposition), B (barre gauche), C (accueil), dans cet ordre de livraison, chacun livrable et mergeable seul.

**Base de vérité du groupe A** : les formes de protocole citées ici ont été **observées** le
2026-10-26 en lançant les CLI réelles (claude 2.1.280, codex-cli 0.157.0) dans un dossier
jetable, pas déduites d'une documentation. Les extraits sont dans « Protocoles observés »
ci-dessous ; les tests automatiques n'appellent jamais ces CLI (faux agents, cf. CLAUDE.md).

## Pourquoi

Le terminal embarqué (xterm.js + PTY) pose trois irritants nommés par l'opérateur : (1) ce
n'est pas un espace de conversation — pas de bulles, pas de regroupement d'appels d'outils,
pas de carte de décision, juste des octets ANSI ; (2) la reprise de session n'est pas
transparente — quand `claude` s'arrête de lui-même, l'opérateur doit relancer à la main avec
l'ID de session qu'il affiche ; (3) la barre de navigation actuelle ne retient rien d'un écran
à l'autre et l'accueil ne dit pas directement ce qui attend une décision.

## État actuel

Index structurel : interrogé via `codegraph explore` (CLI puis MCP une fois le verrou libéré).

| Sujet | Fichier:ligne | Constat |
|---|---|---|
| Spawn des agents | `src/daemon/pty/spawn.ts:5,13-31` | `SpawnKind` = `claude \| codex \| shell \| swarph-cell \| swairm-cell`. `agentCommand()` retourne `[kind]` pour `claude` et `codex` : ce sont des binaires CLI lancés tels quels, aucun mode bibliothèque. |
| Variables de session déjà filtrées | `src/daemon/pty/spawn.ts:52-53` | `SESSION_MARKERS` retire déjà `CLAUDE_AGENT_SDK_.+` et `CLAUDE_CODE_*` de l'environnement hérité — pour éviter qu'un `claude` lancé dans un sujet se croie sous-processus de la session qui a démarré le daemon. Le SDK est donc déjà *connu* du code, jamais *utilisé* pour lancer un agent. |
| Lancement réel | `src/daemon/pty/manager.ts:190-256` (`AgentManager.spawn()`) | Chaque agent, quel que soit son `kind`, est un process `node-pty` (`getPty().spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env })`). Aucun protocole structuré nulle part dans ce chemin. |
| Terminal frontend | `web/src/terminal/Terminal.tsx:1-132` | Une instance `@xterm/xterm` par agent, montée une fois, masquée (jamais démontée) au changement d'onglet. Connexion `PtySocket` (`web/src/terminal/ptySocket.ts`) : octets binaires + JSON de contrôle (`hello`, `size`, `owner`, `exit`). |
| Canal WS terminal | `src/daemon/ws/pty.ts:45-169` | `/ws/pty/:agentId`. Un hub par agent, un seul « propriétaire » (celui dont la saisie compte), rejoue le journal (`TerminalMirror`, xterm headless) si le process a disparu avec le daemon précédent. |
| Reprise au redémarrage daemon | `src/daemon/pty/reprise.ts:1-103` | `gracefulInterrupt()` : demande à l'agent d'écrire un résumé markdown dans `/tmp/aid-reprise-<topicId>.md`, l'arrête, le note dans un manifeste. `resumeFromManifest()` au démarrage suivant : **relance un process neuf** du même kind et colle le résumé en premier message. Ce n'est pas une reprise de session côté `claude` — aucun `--resume` n'est utilisé nulle part dans le dépôt. Ignore déjà `swairm-cell` (ligne 77) ; `shell` n'est jamais sauvegardé (ligne 38). |
| Barre du haut | `web/src/ui/Barre.tsx:51-56,58-74` | Composant `Barre` existant : logo, 4 liens (Accueil/Boîte/Consignes/Réglages), pastille mesh, pastille daemon, recherche. C'est la « barre du haut » du brief (§5.1), pas la « barre gauche » (§5.2) : il n'y a **aucune barre gauche aujourd'hui**, sous aucune forme persistante. |
| Shell / Layout | `web/src/ui/Shell.tsx:1-11`, `web/src/ui/Layout.tsx:25-137` | `Layout` rend `<Shell><Barre/>{children}<dialogues/></Shell>` ; `Shell` est juste un `div` avec attribut de viewport. Utilisé par tous les écrans (`Accueil`, `Boite`, `Consignes`, `Reglages`, `Sujet`). Aucune colonne gauche permanente : c'est le point d'insertion naturel pour `Nav`. |
| Liste de sujets existante | `web/src/ecrans/Cote.tsx:1-64` | `Cote` : liste des sujets groupés par workspace, lecture seule, statut en pastille. **N'est rendu qu'une fois**, dans la vue archive de `Sujet.tsx:841` — pas sur l'écran Sujet normal, pas sur les autres écrans. Ce n'est pas un brouillon de la barre gauche du brief, juste une aide de navigation locale à l'archive. |
| Écran Sujet, disposition actuelle | `web/src/ecrans/Sujet.tsx:591-746` | Un switch d'onglets exclusif **Agents / Git / Fichiers** (pas trois colonnes simultanées). L'onglet Agents a lui-même un sous-switch d'onglets par agent, et rend tous les `<Terminal>` en même temps (masqués sauf l'actif, ligne 727-729). `Memoire` (plan/notes) s'affiche en pleine largeur sous les terminaux (ligne 732), pas en colonne latérale ni en onglets séparés. |
| Onglets latéraux existants | `web/src/ecrans/OngletGit.tsx`, `web/src/ecrans/OngletFichiers.tsx` | Existent déjà comme vues plein écran (pas comme colonne 1/4). Pas de `OngletPlan` / `OngletRevue` / `OngletRetro` / `OngletPassationDev` : le brief en demande six, seuls Git et Fichiers existent sous une forme réutilisable. |
| Accueil actuel | `web/src/ecrans/Accueil.tsx:342-527` | Grille de `CarteSujet` (filtrable par projet/statut), bandeau daemon, bandeau mise à jour, légende des statuts. Pas de table, pas de bandeau de décisions, pas de fil d'activité. `CarteSujet` n'est utilisé que là (vérifié : `grep -rl CarteSujet web/src` → seul `Accueil.tsx`). |
| Dépendances terminal | `package.json` | `node-pty@^1.1.0`, `@xterm/xterm@^6.0.0`, `@xterm/headless@^6.0.0`, `@xterm/addon-serialize@^0.14.0`, `@xterm/addon-fit@^0.11.0`. Aucune dépendance Anthropic (`@anthropic-ai/*`) présente — et ce chantier n'en ajoute pas (D50). |
| Demandes de permission | `src/daemon/pty/manager.ts:82-90,493-513` | `answer()` envoie une touche au PTY après avoir vérifié par regex (`screenShows`) que l'écran montre encore l'option. Fragile par construction : c'est ce que le protocole structuré remplace pour les agents conversationnels. |
| Table `agents` | `migrations/` (dernière : `009_mesh.sql`), `manager.ts:316,339` | `transport` existe déjà dans le schéma et le modèle (`'pty' \| 'headless' \| 'remote'`), toujours écrit `'pty'`. |

## Cible et hors-périmètre

**Cible** :
- Groupe A : `claude` et `codex` tournent via leur propre CLI en **mode structuré** (JSON ligne
  à ligne) derrière une interface de pilote commune, extensible à d'autres agents ; la vue
  Sujet affiche une vraie conversation (bulles, groupes de commandes, cartes de décision,
  repères) ; la reprise de session (redémarrage daemon, ou process agent terminé) est
  automatique et invisible, par l'identifiant de session réel, jamais par un résumé collé ni
  par une commande `--resume` proposée à l'opérateur.
- Groupe D : écran Sujet en trois colonnes simultanées 1/4 barre gauche · 2/4 agent · 1/4
  panneau contextuel (Plan / Git / Fichiers…), au lieu des onglets exclusifs actuels.
- Groupe B : composant `Nav` (barre gauche), présent et persistant sur les cinq écrans, avec
  vues à compteurs, groupes colorés repliables, glisser-déposer, renommage, mode réduit (ce
  dernier marqué « maquette non interactive » par le brief — voir D58).
- Groupe C : nouvel Accueil « file de tri » (piste A du brief) : bandeau de décisions, table de
  sujets, fil d'activité.

**Hors périmètre** (repris du brief §8, non négociable sans nouveau brief) :
- Accueils B et C (écartés par le client).
- Contenu de Boîte de réception / Consignes / Réglages au-delà d'y poser la nouvelle barre
  gauche.
- Responsive sous 1280 px et mobile.
- Thème clair.
- `shell`, `swarph-cell`, `swairm-cell` restent sur PTY + `<Terminal>` sans changement : ce
  sont des CLI interactives sans mode structuré, la conversation native ne s'y applique pas
  (le brief parle d'agents « façon apps desktop agentiques », pas de CLI arbitraires).

## Décisions prises et propositions à valider

Numérotation continue depuis D49 (chantier 14).

- **D50 (validée par l'opérateur le 2026-10-26)** : la conversation native passe par la **CLI
  de l'agent en mode structuré**, pas par une bibliothèque : même binaire, même
  authentification (trousseau), mêmes hooks, mêmes réglages utilisateur, aucune dépendance
  ajoutée. Exigence de l'opérateur : « ça peut être du codex ou autre aussi, il faut un système
  versatile » → D59.
- **D51 (découle de D50)** : A-I-D **fixe lui-même** l'identifiant de session à la création
  (`claude --session-id <uuid>`), ou le capte au premier événement (`codex` :
  `thread.started.thread_id`), le stocke sur l'agent, et toute relance se fait par
  `--resume <id>` (claude) / `codex exec resume <id>` (codex). Vérifié : un process neuf
  relancé ainsi retrouve le contexte (le modèle cite un contenu lu au tour précédent sans
  relire le fichier). Process terminé = état normal, pas une panne : le message suivant de
  l'opérateur relance le process de façon transparente. `reprise.ts` cesse d'écrire un résumé
  pour ces kinds ; `shell` / `swarph-cell` / `swairm-cell` restent inchangés.
- **D52** : journal des événements normalisés dans une table `agent_messages(agent_id, seq,
  kind, payload, at)` (migration `010_…`), lu pour hydrater une vue qui se (re)connecte. Le
  transcript natif de la CLI (`~/.claude/projects/…/<id>.jsonl`, `~/.codex/sessions/…`) reste
  la vérité de la *reprise* ; la table est la vérité de *l'affichage* — on ne parse jamais le
  transcript natif d'un tiers (format privé, non contractuel).
- **D53** : canal `/ws/agent/:agentId` (JSON, un message normalisé par événement) à côté de
  `/ws/pty/:agentId`, gardé pour les kinds PTY. Le front choisit selon `agent.transport`
  (`'pty'` ou nouveau `'stream'`).
- **D59 — interface de pilote** : un pilote par agent (`src/daemon/conversation/`), contrat
  unique consommé par `AgentManager` et le canal WS :
  `start({cwd, env, sessionId?, resume})`, `send(text)`, `interrupt()`,
  `answer(requestId, decision)`, `stop()`, et un flux d'événements **normalisés** (format
  A-I-D, pas celui de la CLI) : `session` (id), `message` (rôle, texte), `tool_start` /
  `tool_end` (id, nom, entrée, sortie, erreur), `request` (permission/question → réutilise
  `PendingRequest`), `turn_end` (coût, durée, erreur), `exit`. Ajouter un agent = écrire un
  pilote + son test de normalisation, rien d'autre ne bouge.
- **D60 — pilote claude** : process **long-vivant** `claude --print --input-format stream-json
  --output-format stream-json --verbose --permission-prompt-tool stdio` (+ `--session-id` ou
  `--resume`). Un message utilisateur = une ligne JSON sur stdin ; plusieurs tours dans le même
  process. Les permissions arrivent en `control_request` `can_use_tool` et se répondent en
  `control_response` (`allow` + `updatedInput` / `deny`) : fin du `screenShows` par regex pour
  ce kind. Interruption : `control_request` `interrupt` (le tour finit en
  `error_during_execution`, le process reste utilisable).
- **D61 — pilote codex (validée par l'opérateur le 2026-10-26, après sonde réelle)** : process
  **long-vivant** `codex app-server` en stdio (JSON-RPC ligne à ligne, protocole v2), privé à
  l'agent — jamais le daemon app-server partagé. Approbations structurées
  (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) → cartes de
  décision comme pour claude ; interruption par `turn/interrupt` ; reprise par
  `thread/resume`. Les méthodes utilisées ne sont pas marquées expérimentales dans le schéma
  et ne demandent aucun opt-in ; seule la commande `app-server` porte l'étiquette
  `[experimental]`. Repli documenté : `codex exec --json` / `exec resume` (un process par
  tour, sans approbations), à n'écrire que si app-server casse à une mise à jour de Codex.
- **D62 — agents `stream` dans AgentManager** : une seconde table en mémoire
  (`streams: Map<string, LiveStream>`) à côté de `live`, plutôt qu'un `LiveAgent` discriminé :
  `get()`, `liveAgents()`, `attach.ts`, `ws/pty.ts` et l'heuristique ne voient que les agents
  PTY et ne changent pas. Les entrées publiques (`input`, `answer`, `setPaused`, `stop`,
  `stopAll`, `close`, `forget`, `screen`) aiguillent selon la table. Statut dérivé des
  événements du pilote, publié par le store (`agent.status` source `daemon`, `agent.tool`,
  `approval.resolved`, `agent.exited`) : mêmes projecteurs, mêmes cartes qu'aujourd'hui. Pas de
  `hookEnv` pour un agent `stream` : le pilote est la seule source de statut (pas de doublon de
  demandes entre hook et `control_request`).
- **D63 — bascule progressive** : réglage `agents.transport: pty | stream` dans
  `config.yaml`, défaut `pty` jusqu'au point A.5 (qui le passe à `stream` quand la vue
  conversation existe). Chaque commit reste utilisable : avant A.5, un agent `stream` n'aurait
  aucun écran.
- **D64 — pause** : pas de SIGSTOP pour un agent `stream` en v1 (409 explicite) ; le geste
  équivalent est « Arrêter » = `interrupt()`, exposé par `POST /api/agents/:id/interrupt`.
- **D54 (à valider)** : `Nav` (barre gauche) est un composant entièrement neuf, monté dans
  `Layout.tsx` à la place où rien n'existe aujourd'hui (ligne 106-114) — ce n'est pas une
  évolution de `Cote.tsx`, qui reste en l'état pour son seul usage actuel (vue archive) sauf si
  le point B.2 démontre qu'il est plus simple de le remplacer aussi à cet endroit.
- **D55 (à valider)** : persistance des réglages de `Nav` (groupes, ordre, replis, noms
  affichés) côté application plutôt que dans le dépôt Git (brief §5.2.2) — proposition : table
  sqlite `nav_group` / `nav_placement` au même modèle que suggéré par le brief (`group {id,
  name, color, order, collapsed, hidden}`, `placement {subjectId, groupId, order, pinned,
  archived, displayName?}`), plutôt qu'un fichier JSON, pour profiter des migrations et des
  tests déjà en place sur la base existante.
- **D56 (à valider)** : l'accueil « file de tri » remplace `Contenu()` dans `Accueil.tsx`
  (ligne 342-518) et retire `CarteSujet.tsx`, qui n'a pas d'autre appelant (vérifié). La grille
  de cartes disparaît au profit d'une table.
- **D57 (découle du brief §9, non tranchée par le brief lui-même, à remonter à l'opérateur
  avec le reste)** : le brief porte 6 questions ouvertes propres (reprises ci-dessous en
  « Questions ouvertes ») — ce plan ne les tranche pas, elles restent à valider par le client
  du brief, pas par l'intégrateur.
- **D58** : le mode réduit de la barre gauche (rail 72 px, brief §5.2.3) est livré comme vue
  statique seulement — son interactivité (popover sur un groupe) est explicitement marquée
  « à confirmer » par le brief ; ce plan ne l'implémente pas tant que D57/Q5 n'est pas tranchée.

## Index structurel et rayon d'impact

Requêtes faites via `codegraph explore` :

- `AgentManager.spawn()` (`src/daemon/pty/manager.ts:190-256`) — 17 appelants dans
  `src/cli/browser.ts`, `src/daemon/actions/editor.ts`, `src/daemon/actions/runner.ts`,
  `src/daemon/pty/native.ts`, et d'autres ; testé via `test/runner.test.ts`,
  `test/reprise.test.ts`. Tout le groupe A touche cette fonction : son rayon d'impact est le
  plus large du chantier, à revérifier avant chaque point du groupe A.
- `SpawnKind` (`src/daemon/pty/spawn.ts:5`) — 7 appelants, testé via `test/heuristique.test.ts`,
  `test/pty-spawn.test.ts`.
- `PtySocket` (`web/src/terminal/ptySocket.ts:31`) — 4 appelants dans `Terminal.tsx`, testé via
  `test/web/ptySocket.test.ts`.
- `Layout` (`web/src/ui/Layout.tsx:25`) — 10 appelants (tous les écrans), testé via
  `test/web/barre.test.tsx`, `test/web/projets.test.tsx` et 6 autres — tout changement dans
  `Layout` pour y poser `Nav` doit repasser cette suite en entier, pas un sous-ensemble.
- `AgentManager.input()` / `answer()` / `setPaused()` (`manager.ts:476-531`) — appelés par
  `src/daemon/routes/agents.ts:49-71` ; pour un agent `stream`, ces trois entrées délèguent au
  pilote (pas de PTY, pas de regex d'écran). `LiveAgent` (10 appelants dont `ws/pty.ts`,
  `pty/attach.ts`, testé via `test/heuristique.test.ts`) : la variante stream ne porte ni `pty`
  ni `mirror` — type discriminé par `transport`, à vérifier appelant par appelant au point A.3.
- `Topic` (`src/shared/model.ts:84`) — 13 appelants ; le modèle de groupement/placement de
  `Nav` (D55) s'ajoute à côté, ne modifie pas `Topic`.

## Points

### Protocoles observés (2026-10-26)

claude, une ligne par événement sur stdout :
`system/init` (session_id, model, tools, permissionMode) · `assistant` (content :
`text` / `thinking` / `tool_use{id,name,input}`) · `user` (content : `tool_result{tool_use_id,
content,is_error}`) · `system/thinking_tokens` · `system/permission_denied` ·
`rate_limit_event` · `control_request{request_id, request:{subtype:"can_use_tool",
tool_name, input, permission_suggestions}}` · `control_response` · `result{subtype:
success|error_during_execution, session_id, num_turns, total_cost_usd, duration_ms,
permission_denials}` · `system/hook_started|hook_response` (les hooks utilisateur tournent).
Sans `--permission-prompt-tool stdio`, une écriture est refusée d'office
(`permission_denied`) au lieu d'être demandée.

codex (`app-server`, stdio, JSON-RPC sans champ `jsonrpc`) : `initialize{clientInfo}` puis
notification `initialized` · `thread/start{cwd, approvalPolicy, sandbox}` → `thread.id` ·
`turn/start{threadId, input:[{type:"text",text}]}` → `turn.id` · notifications
`turn/started`, `item/started|item/completed{item:{type: userMessage | commandExecution{command,
commandActions,status} | agentMessage{text,phase}}}`, `item/agentMessage/delta`,
`turn/completed{turn:{status,durationMs,error}}` · requête serveur→client
`item/commandExecution/requestApproval{threadId,turnId,itemId,command,cwd,availableDecisions}`
→ réponse `{id, result:{decision: accept|acceptForSession|decline|cancel}}`, confirmée par
`serverRequest/resolved` · `turn/interrupt{threadId,turnId}` → tour `interrupted`, process
réutilisable · `thread/resume{threadId}` dans un process neuf retrouve le contexte. Bruit à
ignorer : `mcpServer/startupStatus/updated`, `account/rateLimits/updated`,
`remoteControl/status/changed`, `thread/tokenUsage/updated`, logs ANSI sur stderr. Piège :
`approvalPolicy:"untrusted"` demande même pour `cat` ; `on-request` reste à évaluer.

### Groupe A — Conversation native (claude, codex, pilotes)

**A.1 — Contrat de pilote et pilote claude, sans rien brancher**
- Fichiers : nouveaux `src/daemon/conversation/driver.ts` (types D59),
  `src/daemon/conversation/claude.ts` (D60 : construction des arguments, lecture ligne à
  ligne, normalisation, réponses de contrôle), `test/fixtures/fake-claude-stream.mjs` (rejoue
  les événements observés ci-dessus, accepte stdin), `test/conversation-claude.test.ts`.
- Environnement : réutiliser le filtrage existant de `spawn.ts` (`SESSION_MARKERS`,
  `agentEnv`) — l'importer, ne pas le dupliquer.
- Commit : `feat(conversation): contrat de pilote et pilote claude en stream-json`.
- Preuve : le test pilote le faux agent — deux tours dans un process, une permission
  accordée puis une refusée, une interruption, la normalisation de chaque type d'événement.

**A.2 — Pilote codex (app-server)**
- Fichiers : nouveau `src/daemon/conversation/codex.ts` (D61), `test/fixtures/fake-codex-appserver.mjs`,
  `test/conversation-codex.test.ts`.
- Commit : `feat(conversation): pilote codex (app-server, approbations, reprise par thread)`.
- Preuve : contre le faux serveur — poignée de main, tour, approbation acceptée puis refusée,
  interruption puis tour suivant, `resume` → `thread/resume`, mêmes garanties de robustesse que
  le pilote claude après sa review (erreur de spawn, EPIPE, `stop()` après signal, double
  `start()`, purge des demandes en attente).

**A.3 — Persistance et branchement dans AgentManager**
- Fichiers : `migrations/010_agent_conversation.sql` (table `agent_messages`, colonne
  `session_id` sur `agents`), `src/shared/model.ts` (`transport` accepte `'stream'`,
  `Agent.sessionId`), `src/daemon/pty/manager.ts` (spawn d'un agent `stream` via le pilote ;
  `input`/`answer`/`setPaused`/`stop` délèguent au pilote ; `LiveAgent` discriminé).
- Bascule : D63 (réglage `agents.transport`, défaut `pty` jusqu'à A.5). Structure : D62.
  Pause : D64.
- Dépassement assumé : `spawn()` gagne une branche ; lignes existantes modifiées limitées au
  branchement. Commit isolé.
- Commit : `feat(conversation): agents claude et codex lancés par pilote structuré`.
- Preuve : `test/pty-spawn.test.ts`, `test/reprise.test.ts`, `test/heuristique.test.ts`
  inchangés et verts ; nouveau test : spawn `stream` avec le faux agent, `input` → ligne
  stdin, `answer` → `control_response`.

**A.4 — Canal temps réel structuré**
- Fichiers : nouveau `src/daemon/ws/agent.ts` (`/ws/agent/:agentId` : historique depuis
  `agent_messages` puis flux), `src/daemon/server.ts` (enregistrement, à côté de
  `registerPtySocket` ligne 170), nouveau `web/src/conversation/agentSocket.ts`.
- Commit : `feat(conversation): canal websocket structuré`.
- Preuve : `test/ws-agent.test.ts` (gabarit de `test/ws-pty.test.ts`), `test/web/agentSocket.test.ts`.

**A.5 — Composants de conversation**
- Fichiers : nouveaux `web/src/conversation/{Conversation,Message,ToolCallGroup,DecisionCard,
  Composer}.tsx` ; `web/src/ecrans/Sujet.tsx` (lignes 727-729 : `<Conversation>` si
  `transport === 'stream'`, sinon `<Terminal>`).
- Le Composer reste actif pendant un tour (Q4 du brief) : en attendant la réponse, proposition
  « Arrêter » = `interrupt()` ; l'envoi pendant un tour est mis en file côté daemon.
- Commit : `feat(ui): espace de conversation (messages, outils, décisions, saisie)`.
- Preuve : `test/web/conversation.test.tsx` ; vérification dans l'app réelle (Tauri) avec un
  vrai `claude` par l'opérateur — un test ne remplace pas ce coup d'œil.

**A.6 — Reprise transparente**
- Fichiers : `src/daemon/pty/reprise.ts` (kinds `stream` : plus de résumé, le manifeste ne
  garde que l'id de session), `src/daemon/pty/manager.ts` (process terminé + message de
  l'opérateur → relance `--resume` puis envoi, sans état « terminé » affiché).
- Commit : `feat(conversation): reprise automatique par identifiant de session`.
- Preuve : `test/reprise.test.ts` étendu — (1) le faux agent sort de lui-même, le message
  suivant relance avec `--resume <id>` ; (2) cycle d'arrêt/redémarrage du daemon simulé.
  Jamais de redémarrage du daemon réel depuis une session d'agent.

**A.7 — Repères de discussion**
- Fichiers : nouveaux `web/src/conversation/{MarkRail,MarkMenu}.tsx`, colonne `mark` dans
  `agent_messages` (migration `011_…`).
- Commit : `feat(ui): repères de discussion (rail, raccourcis j/k/m/e)`.
- Preuve : `test/web/markrail.test.tsx`.

### Groupe D — Écran Sujet en trois colonnes

**D.1 — Grille 1/4 · 2/4 · 1/4**
- Fichiers : `web/src/ecrans/Sujet.tsx` (lignes 591-746 : onglets exclusifs → grille ; la
  colonne gauche reçoit `Nav` du groupe B, ou `Cote` en attendant), feuille de style associée.
- Brief : 56 px en haut, colonnes 25/50/25 % (360/720/360 à 1440 px), aucun scroll de page,
  chaque colonne défile seule ; ≥ 1280 px seulement.
- Dépassement assumé : la structure de rendu de l'écran Sujet change. Commit isolé.
- Commit : `feat(sujet): disposition trois colonnes`.
- Preuve : tests web existants de l'écran Sujet verts, `npm run gate:e2e`.

**D.2 — Panneau contextuel en onglets**
- Fichiers : nouveau `web/src/ecrans/PanneauContexte.tsx` (onglets Plan · Git · Fichiers,
  réutilise `Memoire`, `OngletGit`, `OngletFichiers` tels quels) ; Revue / Rétro / Passation
  dev ajoutés seulement si leurs pages mémoire existent pour le sujet (Q3 du brief).
- Commit : `feat(sujet): panneau contextuel droit (plan, git, fichiers)`.
- Preuve : `test/web/panneau-contexte.test.tsx`.

### Groupe B — Barre gauche

**B.1 — Modèle de données et routes**
- Fichiers : migration sqlite (`nav_group`, `nav_placement`, D55), nouvelles routes
  `src/daemon/routes/nav.ts`.
- Commit proposé : `feat(nav): modèle de groupes et placements, routes API`.
- Preuve : tests de routes (même gabarit que `test/agents-routes.test.ts`).

**B.2 — Composant Nav en lecture, posé dans Layout**
- Fichiers : nouveau `web/src/ui/Nav.tsx`, `web/src/ui/Layout.tsx` (insertion dans `<Shell>`).
- Dépassement assumé : `Layout.tsx` change sa structure de rendu (ligne 104-136) — nécessaire,
  commit dédié et minimal.
- Commit proposé : `feat(nav): barre gauche en lecture, posée sur tous les écrans`.
- Preuve : `test/web/barre.test.tsx` et les 6 autres suites qui en dépendent (voir rayon
  d'impact), `e2e` sur la persistance inter-écrans.

**B.3 — Mode édition (glisser-déposer, menu, renommage)**
- Fichiers : `web/src/ui/Nav.tsx`, nouveau `web/src/ui/ContextMenu.tsx`.
- Commit proposé : `feat(nav): mode édition (glisser-déposer, renommer, déplacer, archiver)`.
- Preuve : `e2e` dédié au glisser-déposer + alternative clavier (brief §2.4).

**B.4 — Mode réduit (vue statique, D58)**
- Fichiers : `web/src/ui/Nav.tsx`.
- Commit proposé : `feat(nav): mode réduit (rail), vue seulement`.
- Preuve : test de rendu, pas d'interaction testée (hors scope tant que Q5 n'est pas tranchée).

### Groupe C — Accueil

**C.1 — Table de sujets et bandeau de décisions**
- Fichiers : `web/src/ecrans/Accueil.tsx` (remplace `Contenu()`), retrait de `CarteSujet.tsx`
  (D56, plus aucun appelant après ce point).
- Dépassement assumé : suppression d'un fichier entier devenu mort — documentée, pas un
  dépassement caché.
- Commit proposé : `feat(accueil): table de sujets et bandeau de décisions (piste A)`.
- Preuve : `test/web/accueil.test.tsx` réécrit, `e2e` sur le tri/filtre.

**C.2 — Fil d'activité**
- Fichiers : `web/src/ecrans/Accueil.tsx`, nouveau `web/src/ecrans/FilActivite.tsx`.
- Commit proposé : `feat(accueil): fil d'activité récente, filtré sur les événements utiles`.
- Preuve : test sur le filtrage `lease_acquired`/`lease_released` exclus.

## Pièges et contrôle insertion-only

| Point | Lignes existantes qu'il touche | Contrôle |
|---|---|---|
| A.3 | `src/daemon/pty/manager.ts` (signature de `spawn`) | `git show <commit> \| grep -E "^-" \| grep -vE "^---" \| wc -l` proche de zéro |
| A.5 | `web/src/ecrans/Sujet.tsx:727-729` | idem, isolé dans son propre commit |
| D.1 | `web/src/ecrans/Sujet.tsx:591-746` | idem ; le diff doit déplacer, pas réécrire, le contenu des onglets |
| B.2 | `web/src/ui/Layout.tsx:104-136` | idem |
| C.1 | `web/src/ecrans/Accueil.tsx:342-518`, suppression de `CarteSujet.tsx` | suppression de fichier entier acceptée seulement si `grep -rl CarteSujet web/src` ne retourne plus que lui-même avant retrait |

Aucune dépendance ajoutée par le groupe A (D50). Ne pas bump de version. Ne pas modifier `tsup`/`vite` config sauf si un point l'exige
explicitement (aucun prévu ici). Garder `node-pty` et les `@xterm/*` en dépendance tant que les
kinds PTY existent (ils ne disparaissent pas dans ce chantier).

## Fini quand

- Les trois groupes sont chacun committés avec gate vert (`npm run gate`, `npm run gate:e2e`,
  Node 22 et Node 24).
- `claude` et `codex` tournent par pilote structuré ; reprise automatique vérifiée par test
  (A.6) puis constatée par l'opérateur dans l'app (fin de process + redémarrage du daemon fait
  par lui, jamais par un agent).
- Écran Sujet en trois colonnes (D.1, D.2).
- `Nav` est visible et persistant sur les cinq écrans (B.2), édition complète (B.3).
- L'accueil « file de tri » est en place (C.1, C.2), `HomeB`/`HomeC` restent non implémentés.
- Les D52-D61 ont une réponse de l'opérateur consignée (même « pas pour l'instant »).

## Questions ouvertes

Reprises du brief (§9), à trancher par le client du brief, pas par ce plan :
1. Un seul bouton « Nouveau sujet » (barre gauche) ou aussi dans la barre du haut ?
2. Où afficher l'état d'index maintenant que la colonne est retirée de la table d'accueil ?
3. Passation dev : sixième onglet du panneau contextuel ou dans le menu « … » ?
4. Composer occupé : file d'attente du message ou bouton qui devient « Arrêter » ?
5. Clic sur un groupe du rail réduit : popover de sujets (bloque B.4 tant que non tranché) ?
6. Comportement sous 1280 px : la proposition du brief (barre réduite sous 1280, panneau en
   tiroir sous 1024, colonne centrale minimum 560 px) est-elle retenue ?

Propres à ce plan :
7. D52 : le niveau de détail de `agent_messages` (événements normalisés D59) convient-il ?
8. D61 : politique d'approbation par défaut pour codex — `untrusted` (demande tout, bruyant)
   ou `on-request` (non sondé) ?
9. Libellés des cartes de décision : « Autoriser » / « Toujours autoriser » / « Refuser » ?
