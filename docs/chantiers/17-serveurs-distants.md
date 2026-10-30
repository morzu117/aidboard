# Chantier 17 — Serveurs distants (VPS)

Branche `feat/serveurs-distants`, base `main` (a7a93c6). Brief : `design/aid-vps/BRIEF.md` §11
(« Serveurs distants (VPS) »), maquettes `design/aid-vps/sources/Servers.dc.html`,
`ServerConfig.dc.html`, `ServerChat.dc.html`, tokens `design/aid-vps/tokens.{css,json}`. Les
sections 1 à 10 du même brief sont le chantier 15, déjà livré : ce chantier n'en reprend que la
§11 et réutilise ses composants (`Nav`, `Conversation`, `DecisionCard`, `Composer`, repères).

Trois groupes, livrés dans cet ordre, chacun mergeable seul : **S** (serveurs : modèle,
connexion, écrans liste et configuration, barre gauche), **R** (discussion distante persistante),
**F** (panneau Fichiers / Git du serveur, lecture seule).

## Pourquoi

L'opérateur pilote déjà des agents sur un VPS OVH, mais hors d'A-I-D : il ouvre un terminal,
tape `vps`, se retrouve dans un tmux distant. Rien de ce travail n'apparaît dans l'app (ni
conversation, ni décisions en attente, ni fichiers, ni Git). Le brief demande de piloter ces
agents depuis A-I-D avec la même conversation native que pour un sujet local, et que la
discussion survive aux coupures réseau, aux refresh et à la fermeture de l'app.

## État actuel

### Côté opérateur (constaté le 2026-10-30, lecture seule, aucune connexion au serveur)

| Élément | Où | Constat |
|---|---|---|
| Commande `vps` | `~/.zshrc` (fonction **zsh**, pas bash comme le dit le brief §11.0) | `vps [session]` attache ou crée un tmux distant : `mosh vps -- tmux -u new -A -s <session>` (repli `ssh -t vps "tmux -u new -A -s …"`). `vps --list` / `--close` font `ssh vps 'tmux …'`. **N'accepte qu'un nom de session : ne sait pas exécuter une commande arbitraire.** Inutilisable telle quelle par le daemon pour lancer un agent structuré, lister un dossier ou faire `git status`. |
| Alias SSH | `~/.ssh/config`, `Host vps` (utilisateur `debian`, `ServerAliveInterval 30`, `IdentitiesOnly yes`) ; `Host *` : `AddKeysToAgent yes`, `UseKeychain yes` | `ssh vps -- <cmd>` exécute une commande non interactive, clé servie par le trousseau : **c'est le transport dont le daemon a besoin.** Un second hôte `agents` existe (`vps-agents`). |
| Persistance | côté serveur | tmux y est déjà l'outil de session de l'opérateur. Présence de `claude`, `codex`, `git`, `tmux` sur le serveur : **non vérifiée** (le test de connexion S.3 le dira). |

### Côté dépôt

Index structurel : interrogé via `codegraph_explore` (MCP `codegraph`, toléré en transition).

| Sujet | Fichier:ligne | Constat |
|---|---|---|
| Contrat de pilote | `src/daemon/conversation/driver.ts:5-24` | `ConversationDriverOptions { bin, cwd, env, sessionId, resume, extraArgs }` ; `ConversationDriver { start, send, interrupt, answer, stop, onEvent }`. Aucune notion de transport : le pilote lance lui-même son process. |
| Lancement du process par le pilote | `src/daemon/conversation/claude.ts:154-173`, `codex.ts:145-164` | `spawn(this.opts.bin, args, { cwd, env, stdio: pipe×3 })` en dur. Tout le reste du pilote ne parle qu'à `child.stdin` / `child.stdout` / `exit` : un process `ssh` qui relaie ces flux suffit, à condition de pouvoir **injecter** le spawn. |
| Agents `stream` | `src/daemon/pty/manager.ts:441-502` (`createStream`), `505-528` (`spawnStream`) | Exige sujet actif, `existsSync(topic.worktree)` local et un `run` du sujet. Une discussion de serveur n'a ni sujet, ni worktree local, ni run. |
| Schéma | `migrations/001_init.sql` (`agents.run_id TEXT NOT NULL REFERENCES runs(id)`, `runs.topic_id NOT NULL`), `src/daemon/db.ts:33` (`foreign_keys = ON`) | Un agent ne peut pas exister sans run, ni un run sans sujet. `runId` / `run_id` apparaissent dans ~20 fichiers (`state/snapshot.ts`, `events/*`, `security.ts`, `routes/topics.ts`, `Nav.tsx`, `Accueil.tsx`, `Sujet.tsx`, `Boite.tsx`…). Dernière migration : `013_agent_settings.sql`. |
| Barre gauche | `src/daemon/routes/nav.ts:75-108` (`ensureNavDefaults`), `web/src/ui/Nav.tsx:56` | Groupes `nav_group` (palette `nav.ts:14-23`, même ordre que `Nav.tsx:25-34`) et placements `nav_placement` **par `topic_id`**. Aucun autre type de ligne que le sujet. |
| Routes web | `web/src/App.tsx:15-20` | `/`, `/boite`, `/consignes`, `/reglages`, `/sujets/:topicId`. Pas de `/serveurs`. |
| Routes daemon | `src/daemon/server.ts:132-177` | Un `register…Routes` par domaine ; point d'insertion naturel pour `registerServerRoutes`. |
| Onglets Git / Fichiers locaux | `web/src/ecrans/OngletGit.tsx`, `OngletFichiers.tsx` | Liés à un sujet local. Réutilisabilité de leurs sous-composants pour un serveur : à mesurer au point F.3, pas supposée. |

## Cible et hors-périmètre

**Cible** : §11.1 à §11.4 du brief. Enregistrer un ou plusieurs serveurs, tester la connexion,
les voir dans la barre gauche, ouvrir des discussions avec `claude` / `codex` **exécutés sur le
serveur**, qui survivent aux coupures et reprennent seules, avec cartes de confirmation et
panneau Fichiers / Git en lecture seule.

**Hors périmètre** : édition ou suppression de fichiers distants depuis le panneau (§11.3.1,
v1 lecture seule) ; index structurel du code distant ; mémoire `aid mem` côté serveur ;
discussions de serveur sur l'Accueil (question ouverte 3) ; modes Hôte SSH explicite et
Commande locale **dessinés mais non câblés** si D72 est validée telle quelle ; tout agent autre
que `claude` et `codex` (« cursor » est seulement *détecté*, pas pilotable).

## Décisions prises et propositions à valider

Numérotation continue depuis D71 (chantier 16).

- **D72 — transport : alias SSH (à valider, bloque S.2)**. Le brief retient « Commande locale
  `vps` », mais la fonction `vps` réelle ne sait pas exécuter de commande (voir État actuel).
  Proposition : le mode principal de la v1 est **Alias SSH**, valeur `vps` ; le daemon exécute
  `ssh -o BatchMode=yes -o ConnectTimeout=8 <alias> -- <commande>`. `BatchMode` : jamais de
  prompt de mot de passe qui bloquerait le daemon ; la clé vient du trousseau (`UseKeychain`).
  Les modes **Hôte SSH** (même commande, options `-p`, `-l`, `-i`, `-J` construites) et
  **Commande locale** (préfixe qui accepte une commande distante en argument, ex. `ssh vps`,
  lancé via `$SHELL -ic` si « Charger mon profil » est coché) suivent le même module ; seul
  Alias SSH est testé de bout en bout en v1. Alternatives écartées sauf avis contraire :
  appeler `vps` telle quelle (impossible) ; modifier la fonction de l'opérateur (hors dépôt).
- **D73 — l'agent tourne sur le serveur, dans un tmux détaché (à valider, bloque R.2)**.
  Hypothèse du brief (§11.6 Q2). Persistance : un **relais** (`aid-relay`, script shell déposé
  par le daemon dans `~/.aid-remote/` au test de connexion) lance l'agent dans
  `tmux new -d -s aid-<agentId>`, entrée depuis un FIFO tenu ouvert, sortie ajoutée à un
  journal `out.jsonl`. Le daemon s'y rattache par `ssh … aid-relay attach <id> <offset>` : son
  stdin alimente le FIFO, son stdout est `tail -c +<offset> -F out.jsonl`. Coupure = le process
  `ssh` meurt, l'agent continue ; reconnexion = nouveau `attach` à partir du dernier octet
  consommé, **aucun événement perdu ni rejoué**. Session tmux disparue (reboot du serveur) =
  relance par `--resume <sessionId>` (claude) / `thread/resume` (codex), comme D51 ; si elle
  échoue : « Session introuvable sur le serveur » + **Reconnecter** (§11.3). Case « Garder la
  session vivante » décochée = pas de tmux, l'agent vit dans le process `ssh`.
- **D74 — modèle de données isolé (proposition)**. Pas de sujet, de run ni de workspace fictif
  pour un serveur : nouvelles tables `servers`, `server_rules`, `server_discussions`,
  `server_agents`, `server_agent_messages` (même forme que `agent_messages`, colonne de marque
  comprise). Raison : rendre `agents.run_id` facultatif toucherait ~20 fichiers et toutes les
  projections d'événements, hors périmètre insertion-only. Coût assumé : un
  `RemoteAgentManager` à côté d'`AgentManager`, qui réutilise les pilotes tels quels.
- **D75 — pilotes inchangés, spawn injectable**. Seul ajout au contrat :
  `ConversationDriverOptions.spawnChild?` (défaut : `child_process.spawn`, comportement actuel
  inchangé). Le pilote distant reçoit un `RemoteChild` qui expose les mêmes flux qu'un process
  et gère la reconnexion en dessous. Trois événements ajoutés à `ConversationEvent` (partagé) :
  `connection_lost{at}`, `connection_resumed{at, afterMs, sessionFound}`,
  `resume_failed{reason}` → la ligne de reprise (SystemLine).
- **D76 — aucun secret dans A-I-D** (spécifié §11.0). Ni mot de passe, ni clé, ni passphrase en
  base ni en config. L'app web ne parle qu'au daemon ; le daemon ne parle qu'à `ssh`. Routes
  serveurs réservées à l'administrateur (même garde que `routes/structural.ts:99`).
- **D77 — confirmations même en mode automatique (à observer avant R.5)**. Exigence §11.2 :
  sudo et commandes destructives confirmées même en mode auto. Piste : règles `ask` passées par
  `--settings` à `claude` (`Bash(sudo:*)`, `Bash(rm:*)`…) et `approvalPolicy` côté `codex`.
  **Formes à observer sur les CLI réelles du serveur** avant d'écrire le code (règle du
  chantier 15 : protocoles observés, pas déduits). « Toujours autoriser sur ce serveur » écrit
  une ligne dans `server_rules`, révocable depuis la configuration.
- **D78 — garde-fous du panneau Fichiers (proposition)**. Le daemon, pas le front, restreint aux
  **dossiers autorisés** (chemin résolu par `realpath` distant, puis préfixe vérifié). Masqués
  par défaut, contenu jamais lu : `.env*`, `*.pem`, `*.key`, `id_*`, `.ssh/`, `*.p12`. Grisés,
  non dépliés : `node_modules`, `.git`, `dist`, `.venv`, `target`. Aperçu tronqué à **256 Kio**,
  binaire détecté (octet nul dans les 8 premiers Kio) non affiché. Valeurs à confirmer (§11.6 Q1).
- **D79 — tests sans réseau**. Jamais de vrai `ssh` ni de vrai serveur dans un test : fixture
  `test/fixtures/fake-ssh.sh` (ignore l'hôte, exécute la commande localement sous `sh`, peut
  simuler une coupure ou un échec), et `fake-tmux.sh` dans le `PATH` des tests du relais si
  `tmux` est absent de la CI. Agents : le faux agent existant (`test/fixtures/fake-agent.sh`).

## Index structurel et rayon d'impact

Requêtes faites via `codegraph_explore` :

- `ConversationDriver` / `ConversationDriverOptions` (`driver.ts:5-24`) — appelés par
  `claude.ts`, `codex.ts`, `pty/manager.ts` ; testés via `test/conversation-claude.test.ts`,
  `test/conversation-codex.test.ts`, `test/agent-stream.test.ts`. D75 n'y ajoute qu'un champ
  facultatif : ces trois suites doivent rester vertes sans modification.
- `ClaudeDriver.start` (`claude.ts:154`), `CodexDriver.start` (`codex.ts:145`) — 5 appelants
  chacun dans `pty/manager.ts`. Le point R.3 change une ligne dans chacun (`spawn` →
  `(this.opts.spawnChild ?? spawn)`) : seules suppressions attendues du groupe R.
- `AgentManager` (`pty/manager.ts:182`) — 16 appelants : **non modifié** par ce chantier (D74).
- `registerNavRoutes` / `ensureNavDefaults` (`routes/nav.ts:75,155`) — testés via
  `test/securite.test.ts`. `Nav` (`web/src/ui/Nav.tsx:56`) — rendu par `Layout` sur tous les
  écrans, testé via `test/web/nav.test.tsx`, `nav-edition.test.tsx`, `barre.test.tsx`,
  `projets.test.tsx` et 4 autres : S.6 repasse cette suite **en entier**.
- `buildServer` (`server.ts:93`), `App.tsx` : insertions de routes uniquement.
- `ConversationEvent` (`src/shared/conversation.ts`) : trois variantes ajoutées (D75) ; tout
  `switch` exhaustif sur `type` côté front est à relever au point R.3.

## Points

Un point = un commit. Gate complet (`npm run gate`, puis `npm run gate:e2e` pour les points qui
touchent le web) avant chaque commit.

### Groupe S — Serveurs

- **S.1 — Modèle et routes.** Migration `014_servers.sql` : `servers(id, name UNIQUE, mode
  CHECK IN ('ssh_alias','ssh_host','command'), target, ssh_options JSON, load_profile, workdir
  DEFAULT '~', shell DEFAULT 'bash', keep_session DEFAULT 1, permission_mode,
  confirm_destructive DEFAULT 1, allowed_dirs JSON, group_name DEFAULT 'Serveurs', color,
  created_at, updated_at)` et `server_rules(id, server_id, pattern, created_at)`. Type `Server`
  dans `src/shared/model.ts`. Routes admin `GET/POST /api/servers`, `GET/PATCH/DELETE
  /api/servers/:id`, `DELETE /api/servers/:id/rules/:ruleId`. Preuve : tests de route (nom
  unique, validation, 403 hors admin, suppression sans toucher aux discussions).
- **S.2 — Transport.** `src/daemon/remote/transport.ts` : `remoteArgv(server, cmd)` par mode
  (D72), `remoteExec(server, cmd, {timeoutMs})` (sortie bornée), `remoteSpawn(server, cmd)` (flux
  longs). Échappement strict de la commande distante (guillemets simples). Preuve : tests
  unitaires d'argv par mode + exécution contre `fake-ssh.sh` (succès, code ≠ 0, délai dépassé).
- **S.3 — Test de connexion et état.** `POST /api/servers/:id/test` : étapes séquentielles
  (commande trouvée · shell distant ouvert + durée · répertoire de travail accessible · agents
  détectés `command -v claude codex cursor-agent` · session persistante `command -v tmux`),
  publiées au fil de l'eau sur le flux d'événements, sortie brute conservée pour le dépliage.
  Dépose `aid-relay` (R.2). État en mémoire `connected | connecting | unreachable | error` +
  latence, rafraîchi toutes les 60 s tant qu'un client regarde, « daemon local hors ligne »
  calculé côté front. Lancé aussi à l'enregistrement.
- **S.4 — Écran Serveurs (liste).** Route `/serveurs`. `ServerIcon`, `StatusPill`, `ServerCard`
  (4 indicateurs, Configurer, Ouvrir la discussion, menu ··· Tester / Reconnecter / Supprimer),
  carte pointillée, état vide. Table « Discussions sur <serveur> » vide jusqu'à R.6. Accès :
  ligne de groupe « Serveurs » de la barre gauche (S.6) ; lien dans la barre du haut selon la
  question ouverte 6.
- **S.5 — Écran Configuration.** Routes `/serveurs/nouveau`, `/serveurs/:id/configuration`.
  En-tête fixe (fil, Annuler avec confirmation si modifié, Enregistrer désactivé si rien n'a
  changé ou champ invalide), corps qui défile seul, deux colonnes (formulaire fluide · test
  340 px). `SegmentedControl` (`aria-pressed`, valeurs conservées par mode), `FormField`,
  `Checkbox`, `TestSteps`, aperçu barre gauche en direct, tags de dossiers autorisés, liste des
  règles « toujours autoriser » révocables, zone Supprimer.
- **S.6 — Barre gauche.** `NavServer` (même gabarit que la ligne de sujet : icône d'état, nom,
  latence ; sélectionné · injoignable · reconnexion) dans un groupe par `group_name`. Les groupes
  serveurs suivent les mêmes repli et couleur que les groupes de sujets ; leur glisser-déposer
  est hors v1 (ordre = date de création). Suite `test/web/nav*.test.tsx` entière.

### Groupe R — Discussion distante

- **R.1 — Modèle.** Migration `015_server_discussions.sql` : `server_discussions(id, server_id,
  name, cwd, archived, created_at, updated_at)`, `server_agents(id, discussion_id, kind,
  session_id, status, tmux_session, out_offset, permission_mode, model, effort, created_at,
  updated_at)`, `server_agent_messages(agent_id, seq, kind, payload, at, mark)`.
- **R.2 — Relais distant.** `assets/remote/aid-relay.sh` (POSIX sh) : `start <id> <cwd> --
  <argv…>`, `attach <id> <offset>`, `alive <id>`, `stop <id>`. Déposé et versionné par le
  daemon (somme de contrôle, redéposé si différent). Preuve : tests locaux du relais via
  `fake-ssh.sh` + faux agent : démarrage, attache, coupure (kill du `ssh`), ré-attache à
  l'offset sans perte ni doublon, arrêt.
- **R.3 — Pilote distant.** `ConversationDriverOptions.spawnChild` (D75), `RemoteChild`
  (`src/daemon/remote/child.ts`) : reconnexion avec attente croissante (1, 2, 5, 10, 30 s),
  événements `connection_lost` / `connection_resumed` / `resume_failed`, repli `--resume`.
  Preuve : `ClaudeDriver` et `CodexDriver` contre le faux agent derrière `fake-ssh.sh`, coupure
  simulée en plein tour.
- **R.4 — Gestionnaire et canal.** `RemoteAgentManager` (journal `server_agent_messages`,
  statut, reprise au redémarrage du daemon en ré-attachant chaque agent vivant), routes
  `/api/servers/:id/discussions` (CRUD) et `/api/server-agents/:id/{input,interrupt,answer}`,
  WS `/ws/server-agent/:id` au **même protocole** que `/ws/agent/:id` (D65). Seuls les agents
  détectés au dernier test sont proposés.
- **R.5 — Confirmations.** Observation préalable des CLI réelles **sur le serveur** (D77),
  consignée en tête du point. `ConfirmCard` (variante de `DecisionCard` : bloc de commande
  mono, titre « Confirmation requise · <serveur> », Autoriser · Refuser · Toujours autoriser sur
  ce serveur), états en attente · autorisée · refusée. Règles `server_rules` appliquées par le
  daemon avant d'afficher la carte.
- **R.6 — Écran Discussion.** Route `/serveurs/:id/discussions/:discussionId`. Réutilise
  `Conversation` en lui passant la fabrique de socket (prop facultative, défaut inchangé) :
  colonne de 820 px max, fil `Serveurs / <nom>`, chips d'en-tête (état · latence, serveur,
  répertoire, session persistante), étiquettes agent + serveur par tour, « N commandes sur
  <serveur> », `SystemLine` (reprise ambre, échec rouge + Reconnecter), bandeau injoignable +
  composer désactivé, placeholder « Écris à <agent> sur <serveur>… », mode initialisé au mode
  du serveur, repères / étoiles / `j k m e` identiques. Table « Discussions » de S.4 branchée
  (Reprendre, clic de ligne).

### Groupe F — Panneau Fichiers / Git du serveur

- **F.1 — Lecture de fichiers.** `GET /api/servers/:id/fs?path=` (un niveau, jamais l'arbre
  entier ; badges `git status --porcelain` du dossier ; masqués et grisés D78),
  `GET /api/servers/:id/file?path=` (aperçu borné, binaire refusé, masqué refusé). Refus 403 de
  tout chemin hors dossiers autorisés, symlinks compris.
- **F.2 — Git.** `GET …/git/status` (branche, modifiés, avance / retard sur `origin`),
  `GET …/git/log?scope=all|branch`, `GET …/git/commits/:hash`, `POST …/git/{fetch,push,sync}` —
  `push` et `sync` exigent une confirmation (même `ConfirmCard`) et sont refusés côté daemon
  sans avance (cf. D33). Dossier non Git : liste des dépôts trouvés dans les dossiers autorisés.
- **F.3 — Panneau.** Bouton **Panneau** de l'écran Discussion, 360 px, état ouvert / fermé
  mémorisé par serveur (`nav_pref`), onglets Fichiers · Git, barre `serveur:dossier` + âge des
  données + ↻, `FileTreeRow` (30 px, 20 px par niveau), légende des badges, aperçu en lecture
  seule ; onglet Git par réutilisation des composants de `OngletGit` s'ils se découplent du
  sujet sans réécriture, sinon composants dédiés (décision consignée dans le commit).
- **F.4 — Actualisation.** À l'ouverture, au retour de connexion, après chaque commande
  exécutée par l'agent (fin d'un groupe d'outils), sur ↻. Jamais en continu. Injoignable :
  dernières données gardées, âge en ambre, ↻ / Pousser / Synchroniser désactivés.

## Pièges et contrôle insertion-only

| Point | Lignes existantes touchées | Contrôle |
|---|---|---|
| R.3 | `claude.ts:157`, `codex.ts:148` (appel `spawn`) | `git show <commit> \| grep -E "^-" \| grep -vE "^---" \| wc -l` ≤ 2 |
| R.6 | `web/src/conversation/Conversation.tsx` (création de `AgentSocket`, l.62-64) | idem, prop facultative, défaut identique |
| S.6 | `web/src/ui/Nav.tsx` | insertion d'un bloc de rendu, aucune ligne de sujet modifiée |
| Tous | `server.ts`, `App.tsx`, `src/shared/*.ts` | insertions seules |

- Aucune dépendance ajoutée : `ssh` est un binaire système, pas un paquet npm.
- Le daemon n'écoute toujours que sur 127.0.0.1 ; aucun port distant ouvert, aucun tunnel.
- Toute commande distante passe par `remoteArgv` (S.2) : jamais de concaténation de chaîne
  ailleurs. Les noms de fichiers viennent du serveur : à échapper comme une saisie hostile.
- `AID_HOME` temporaire dans chaque test ; jamais de vrai `ssh`, `claude`, `codex` (D79).
- `design/aid-vps/` est ignoré par Prettier (`.prettierignore` : `design/`) : ne pas le reformater.

## Fini quand

- Les trois groupes sont committés, gate vert (`npm run gate`, `npm run gate:e2e`, Node 22 et 24).
- L'opérateur a enregistré `vps-ovh`, le test de connexion est vert sur le vrai serveur, une
  discussion `claude` a survécu à une coupure réseau et à une fermeture de l'app (constaté par
  lui, jamais par un agent).
- D72-D79 ont une réponse de l'opérateur consignée.

## Questions ouvertes

Reprises du brief §11.6, plus celles nées de l'état des lieux :
1. Taille maximale de l'aperçu de fichier et liste des masqués (proposition D78).
2. Agent sur le serveur (D73) : à confirmer.
3. Discussions de serveur sur l'Accueil ? Proposition du brief : oui, étiquette « Serveur » —
   hors v1 de ce chantier sauf demande.
4. Discussions d'un serveur supprimé : lecture seule (proposition) ou suppression ?
   → **Tranchée par l'opérateur** (2026-10-30) : supprimées avec le serveur (cascade en base, R.1).
5. Modes de connexion câblés dès la v1 : Alias SSH seul (D72) ou aussi Hôte SSH ?
6. Accès à l'écran Serveurs : barre gauche seule (S.6) ou aussi un lien dans la barre du haut ?
   → **Tranchée par la maquette Servers** (2026-10-30) : lien « Serveurs » dans la barre du haut,
   entre Consignes et Réglages (§5.1), en plus de la section de la barre gauche (S.6).

## Journal du groupe S

- **2026-10-30 — validations.** D72, D74, D76 et D78 validées par l'opérateur pour le groupe S.
- **S.1** `acbed2e`, review `048309c` : validation resserrée (jeux de caractères fermés pour
  cible, utilisateur, rebond, shell, chemins distants ; `null` explicite sans coercition Ajv).
- **S.2** `2252eb4`, review `3f1dbdc`. Risque accepté : en mode commande locale, la cible est un
  fragment de shell local exécuté par le daemon ; seule la garde administrateur la protège (comme
  toute route qui lance un agent). L'écran de configuration (S.5) le rappelle et interdit d'y
  mettre un secret (D76).
- **S.3** `4f46846`, review `f90c316`. Écart au plan : le dépôt d'`aid-relay` au test de
  connexion passe au point **R.2**, avec le relais lui-même — le déposer avant qu'il existe ne
  testerait rien. Le rafraîchissement de l'état est piloté par la lecture (`GET
  /api/servers/status` relance un contrôle au-delà de 60 s), plus une relecture du front toutes
  les 30 s, suspendue onglet caché.
- **S.4** `84280dd`, review comprise. « Ouvrir la discussion » grisé (avec explication lisible au
  clavier) jusqu'au groupe R. Ligne existante modifiée : l'union `EcranId` de `Barre.tsx`
  (inévitable : un alias de type sur une ligne).
- **Échecs pré-existants constatés sur `origin/main`** (prouvés sur un worktree de la base,
  signalés, non contournés) : `test/web/accueil.test.tsx:119` (`expected 'fix/x' to be
  'feat/s'`, 16 échecs sur 120 exécutions ; depuis `c6c44c5` du 2026-10-27 — le tri par activité
  départage deux sujets dont `updatedAt` vient de `new Date()` à la milliseconde près) ;
  `e2e/nav-edition.spec.ts:45` (Échap au renommage, délai de 90 s) et
  `e2e/trois-sujets.spec.ts:14`, instables d'une exécution complète à l'autre.
- **Environnement du gate e2e** : Node 22 obligatoire (`package-server.sh`) et port 4871 pris par
  AID.app → `AID_E2E_PORT=4879`.
- **S.5** `5a39d1f`, review comprise. Décisions prises sans arbitrage de l'opérateur :
  - libellés des modes d'exécution repris du sélecteur du composer (« Demander avant
    d'exécuter », « Modifications de fichiers automatiques », « Automatique », « Plan (lecture
    seule) ») sur les valeurs du daemon ;
  - couleurs en boutons `aria-pressed` (comme le `SegmentedControl`), pas en boutons radio ;
  - le test lancé à l'enregistrement part du front (`POST /test` après le `POST`/`PATCH`), pas
    du daemon ; un échec de ce lancement est affiché sans annuler l'enregistrement ;
  - le formulaire n'est remonté qu'après un enregistrement réussi : un serveur modifié ailleurs
    (autre onglet) ne jette pas le brouillon en cours ;
  - un dossier tapé sans « Ajouter » part à l'enregistrement ; groupe vide → « Serveurs » ;
  - un seul identifiant d'écran `serveurs` pour la liste et la configuration.
- **S.6** `7157802`, review comprise — section « Serveurs » de la barre gauche (`NavServeurs.tsx`, insertion d'une ligne de
  rendu dans `Nav.tsx`), toujours visible (« Aucun serveur », + vers l'ajout, titre vers la
  liste). Décisions : couleur d'un groupe serveurs = celle de son plus ancien serveur (la couleur
  est un réglage du serveur) ; repli gardé en mémoire de module, perdu au rechargement (aucune
  table en v1) ; la ligne mène à la configuration tant que la discussion n'existe pas (R.6) ;
  pas de case serveurs dans la barre réduite (rail) en v1.
- **Instabilité constatée au gate e2e de S.5** : `e2e/sujet-colonnes.spec.ts:18`, le sélecteur de
  dossier a préfixé le chemin saisi par le dossier personnel (`/Users/…/private/var/…`) ; spec
  relancée seule trois fois, verte trois fois. Hors du périmètre du groupe S (sélecteur de
  dossier des projets), signalée, non contournée.
- **Gate e2e de S.6** : un premier passage a fait échouer `e2e/sujet-colonnes.spec.ts` (sélecteur
  `.barre-gauche-groupes-entete .titre-zone` devenu ambigu) : la section a reçu ses propres classes,
  la spec n'a pas été touchée. Gate et gate e2e complets ensuite verts (35/35).

## Journal du groupe R

- **R.1** `445614e`, review comprise — migration `015_server_discussions.sql`, types partagés `ServerDiscussion` et
  `ServerAgent`. Chaîne `ON DELETE CASCADE` serveur → discussions → agents → fils (question 4).
  Écart de nommage : la colonne de marque s'appelle `marked`, comme dans `agent_messages` (011),
  et non `mark`. Ligne existante modifiée : `user_version` attendu dans `test/mesh-schema.test.ts`
  (14 → 15), comme en S.1. Pas de `CHECK` sur `kind`, `status`, `permission_mode` : même convention
  que la table `agents` ; validation à l'écriture par le gestionnaire (R.4).
- **À reprendre en R.2 à R.4** (review R.1) :
  - la cascade ne touche que la base : `DELETE /api/servers/:id` devra passer par le gestionnaire
    (arrêter les relais, tuer les sessions tmux au mieux, puis supprimer) et les écritures du relais
    tolérer une ligne disparue ;
  - écrire les messages d'un lot et le nouvel `out_offset` dans une même transaction, sinon un
    arrêt du daemon entre les deux perd ou rejoue des messages au rattachement ;
  - l'état de connexion d'un agent (lien ssh perdu, agent vivant dans tmux) passe par les
    événements de D75 (`connection_lost`…), pas par `AgentStatus`.
- **D73 toujours à valider** : R.2 attend la réponse de l'opérateur.
