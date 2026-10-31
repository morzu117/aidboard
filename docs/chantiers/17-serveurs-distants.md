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
  **Opérateur, 2026-10-30** : « secret → masqué » est une **règle immuable** (aucun réglage ne l'ouvre) ;
  liste élargie aux jetons et identifiants courants (point F.1 bis). Afficher un secret demandera le mot de
  passe de la machine — fonction à concevoir, hors groupe F.
  Piste retenue par l'opérateur (2026-10-31) : un **mot de passe propre à `aid-relay`**, défini sur le
  serveur (empreinte scrypt côté relais, jamais connu d'A-I-D au repos, D76), saisi à chaque affichage,
  passé au relais par stdin, vérifié et limité en essais par le relais, affichage journalisé sur le serveur,
  rien gardé côté A-I-D. Touch ID / session du Mac (AID.app) : option ultérieure. Limite assumée : barrière
  de consentement, pas de protection contre un daemon compromis (il a l'accès ssh).
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
- **2026-10-30 — D73 validée** par l'opérateur : agent sur le serveur, dans un tmux détaché, via `aid-relay`.
- **R.2**, review comprise — `src/daemon/remote/relay.ts` : script `aid-relay` (sh POSIX), commandes
  `start` / `attach` / `alive` / `stop`, dépôt `ensureRelay` ; faux tmux et faux agent ligne à ligne pour
  les tests (D79), plus un test sur le vrai tmux quand la machine l'a (socket dans le dossier du test).
  Décisions prises en cours de point :
  - **script embarqué dans le TypeScript**, pas dans `assets/remote/` : il part avec le bundle sans
    toucher à la liste `files` du manifeste. Somme SHA-256 calculée au chargement ;
  - **dépôt par le gestionnaire juste avant le premier `start`** (R.4), pas pendant le test de connexion,
    qui reste en lecture seule. Fichier temporaire propre au dépôt, somme recontrôlée avant le `mv` :
    un envoi coupé ne publie jamais un relais tronqué ;
  - **serveur tmux dédié** (`tmux -L aid-relay -f /dev/null`) : ni la configuration de l'utilisateur
    (`destroy-unattached`, `default-command`) ni ses sessions ne touchent au relais. Commande de
    `new-session` en une seule chaîne : toute version de tmux convient ;
  - **environnement du `start`** rejoué par l'agent (`export -p` → `env`) : le serveur tmux garde celui
    de sa première session, l'agent verrait sinon un `PATH` ou des clés d'une autre connexion ;
  - pids relus dans un fichier vérifiés avant tout `kill` (rattachement reconnu à sa ligne de commande,
    agent reconnu comme enfant du shell `run`) : après un redémarrage, un pid réattribué n'est pas tué.
    `stop` attend 3 s puis envoie SIGKILL ;
  - `start` atomique (`mkdir` du dossier comme verrou) et sans reste en cas d'échec ; `attach` sort en 8
    si l'offset dépasse la sortie (relance d'un agent sous le même id, compteur désynchronisé).
  - seconde relecture : cibles tmux exactes (`-t =aid-<id>`) ; tmux accepte un préfixe, et `stop` d'un
    agent sans session aurait tué `aid-<id>2…` (test sur vrai tmux, vérifié rouge sans le correctif).
    Un rattachement précédent bloqué en écriture reçoit SIGKILL, enfants compris.
- **Piège rencontré** : le shell de connexion relit `/etc/profile` ; sur macOS `path_helper` y remet
  `/opt/homebrew/bin` devant le PATH du test, et les tests du relais utilisaient en silence le vrai tmux
  de l'opérateur. Corrigé par un `.profile` dans le HOME distant du test et une garde (la session doit
  figurer dans le faux tmux). Aucune session `aid-` n'est restée.
- **À reprendre en R.3** : `err` n'est lu par aucune commande ; une erreur d'authentification de l'agent
  y finit. R.3 en remontera la fin quand l'agent finit en échec.
- **À documenter (F)** : un hôte avec `KillUserProcesses=yes` (systemd-logind) tue le serveur tmux à la
  dernière déconnexion ; l'agent est alors « perdu » à chaque coupure complète. Remède côté serveur :
  `loginctl enable-linger`.
- **R.3**, review comprise — `src/daemon/remote/child.ts` (`RemoteChild`, lanceur `remoteSpawnChild`),
  `src/daemon/remote/driver.ts` (`RemoteDriver`). `ConversationDriverOptions.spawnChild` (D75) : les
  deux seules lignes existantes modifiées sont les appels `spawn` de `claude.ts` et `codex.ts`, comme
  prévu. Trois variantes ajoutées à `ConversationEvent` ; aucun `switch` exhaustif à relever (le fil
  et le gestionnaire les ignorent jusqu'à R.6). Décisions prises en cours de point :
  - **la reprise par `--resume` vit dans un pilote enveloppe** (`RemoteDriver`), pas sous le pilote :
    codex refait sa poignée de main (`thread/resume`) au démarrage, un process remplacé sous un
    `CodexDriver` vivant ne la referait pas. Le pilote local est remonté, même relais, sortie à 0 ;
  - **dépôt du relais à chaque connexion** du `RemoteChild` (une somme comparée, un aller-retour),
    plutôt que par le gestionnaire avant le premier lancement : un relais effacé entre deux
    connexions est redéposé à la reconnexion ;
  - connexion rétablie = marqueur `aid-relay: attaché` (ajouté au relais) ou premiers octets reçus ;
  - `cwd` du pilote = répertoire sur le serveur ; l'environnement local n'y part pas (D76) ;
  - offset sûr exposé (`committedOffset`, dernière fin de ligne) : c'est lui que R.4 persistera, un
    rattachement à partir de là ne coupe aucun message ;
  - au plus 3 reprises d'affilée sans un tour réussi, puis `resume_failed` ; un `--resume` refusé
    par la CLI après la connexion compte comme échec de reprise ; la fin d'un agent en échec rend la
    fin de sa sortie d'erreur (commande `err` du relais) ;
  - `stop()` injoignable : rendu au pilote, le message dit que l'agent tourne peut-être encore ;
    `detach()` (arrêt du daemon, R.4) laisse l'agent au serveur et `stop()` rend la main aussitôt.
- **Limite connue** : l'entrée n'est pas acquittée. Un message écrit pendant que le lien meurt, avant
  que ssh ne le constate (sondes à 15 s × 3), peut se perdre ; le tour ne démarre alors pas. Un `\n`
  de garde à la reprise a été écarté (il casserait la ligne JSON-RPC de codex). À reprendre si
  l'usage le montre : compteur d'octets d'entrée côté relais.
- **À reprendre en R.4** : au redémarrage du daemon, un `CodexDriver` remonté refait sa poignée de
  main sur un codex vivant — à traiter avant de ré-attacher un agent codex (claude n'a pas ce cas).
- **R.4**, review comprise — `src/daemon/remote/agents.ts` (`RemoteAgentManager`),
  `src/daemon/routes/serverDiscussions.ts` (CRUD des discussions, `/api/server-agents/:id/{input,interrupt,answer}`),
  `src/daemon/ws/serverAgent.ts` (`/ws/server-agent/:id`, même protocole que `/ws/agent/:id`, y compris
  pour un agent en veille : `exited`, puis `exit` `daemon_restart`). Câblage par insertions dans
  `server.ts` et `main.ts` (option `remoteBins`, les faux agents en test). Décisions prises en cours de point :
  - **codex n'est pas rattaché au redémarrage du daemon** : son pilote referait la poignée de main
    JSON-RPC sur un process qui l'a déjà faite. Relais arrêté au mieux, statut `idle`, relancé par
    `thread/resume` au message suivant. claude, lui, est rattaché à son offset ;
  - **une relance prend un relais neuf** (`<agentId>-<ulid>`, offset remis à 0), et n'a lieu qu'une fois
    l'ancien relais arrêté (`stop` à 0) : sinon 502 « serveur injoignable », `tmux_session` inchangé.
    Deux agents sur la même session, ou un agent perdu de vue, sont ainsi exclus ;
  - `--resume` seulement si le fil a déjà un `turn_end` : avant le premier tour, la session n'existe pas ;
  - **demandes en attente en mémoire seulement**. Un claude rattaché alors qu'il était `needs_input`
    reçoit une interruption et passe `working` : son pilote ne connaît plus l'id de la demande, le
    tour resterait bloqué. Comportement réel de claude sur cette interruption : à observer en R.5 (D77) ;
  - pas de pièces jointes (D70 : fichiers du daemon, pas du serveur) ;
  - le message de l'opérateur part au pilote **avant** d'être écrit au fil (un envoi refusé ne laisse
    pas de ligne) ; il est diffusé aux abonnés du canal comme pour un agent de sujet ; abonnés rangés
    par agent, ils suivent une relance ;
  - offset écrit dans la transaction de chaque ligne : la livraison `PassThrough` → `readline` est
    synchrone (vérifié), l'offset d'une ligne journalisée l'inclut, rien n'est perdu ni rejoué. Une
    écriture en échec autre que la clé étrangère ferme le lien (l'offset n'avance pas par-dessus) ;
  - suppression d'une discussion ou d'un serveur : relances en cours attendues, puis chaque agent est
    arrêté au mieux, **quel que soit son statut** (un pilote sorti en erreur faute de lien laisse un
    agent vivant) ; serveur injoignable n'empêche pas de supprimer. Pendant l'arrêt, plus aucune
    création ni relance dans la discussion ou sur le serveur (409). `DELETE /api/servers/:id` passe par un
    `preHandler` qui arrête les agents avant la cascade ;
  - répertoire de discussion : chemin absolu ou sous `~`, sans caractère de contrôle.
- **Limite connue (R.4)** : si le handler de `DELETE /api/servers/:id` échouait après le `preHandler`, le
  serveur resterait avec ses agents arrêtés. Accepté : le handler ne fait qu'un `DELETE` après la même
  vérification d'existence.
- **Test instable relevé pendant R.4** : `test/agents-pilotage.test.ts` « pause : le groupe est stoppé
  (état T)… », délai dépassé (`stoppé` / `stoppé de nouveau`). 5 échecs sur 54 lancements avec le diff,
  tous sous charge (charge 8 à 9 pendant les gates), 0 sur 34 sur la base `590928f` ; les 30 derniers
  lancements avec le diff sont verts. Aucun mécanisme trouvé (le diff ne touche ni aux PTY ni aux
  signaux) ; antériorité **non prouvée**. Également : `test/web/accueil.test.tsx:119`, déjà vu en R.3.
- **À reprendre** : un `fake-line-agent.sh` orphelin (parent 1) a été trouvé après les tests, lancé
  ~1 h 35 plus tôt, donc par un test du relais (R.2/R.3) et non de R.4. Arrêté à la main ; la fuite n'a
  pas été reproduite (aucun process restant après les trois gates de R.4).
- **R.5 — observation préalable (D77), 2026-10-30.** Sur le VPS (alias `vps`, lecture seule, dossier
  jetable, rien installé) : `claude` n'est dans le PATH **que dans un bash interactif** (mise activé dans
  `.bashrc`, que le `.bashrc` Debian quitte d'entrée hors interactif) — `bash -lc` ne le trouve pas, et
  `bash -ic` sans tty bruite stderr ; sa session OAuth y est expirée ; `codex` n'y est pas installé.
  Observation faite **en local** à la place (choix de l'opérateur), mêmes versions de CLI, dossier jetable,
  toutes les demandes refusées :
  - **claude 2.1.308** : `--settings '{"permissions":{"ask":["Bash(rm:*)","Bash(sudo:*)"]}}'` force la
    demande en `auto` comme en `acceptEdits` — `control_request` `can_use_tool`, `tool_name: "Bash"`,
    `input: {command, description}`, `decision_reason_type: "rule"`, `decision_reason_rule_source:
    "flagSettings"`, `tool_use_id`. Rattrape `sudo -n true` et une commande composée (`echo debut && rm -f x`).
    Sans la règle, `rm` passe sans demande en `auto`. Une demande ordinaire (mode `default`) n'a pas de
    `decision_reason_type` et porte `blocked_path` / `permission_suggestions`. Refus :
    `control_response` `behavior: "deny"` ; le `result` porte alors `permission_denials` ;
  - **codex 0.157.0** (`app-server`) : `approvalPolicy: "untrusted"` + `sandbox: "workspace-write"` soumet
    **toute** commande, `ls` compris. `item/commandExecution/requestApproval` : `kind: "command"`,
    `command` **enveloppée** (`/bin/zsh -lc 'rm -f …'`), `cwd`, `commandActions: [{type, command}]` (la
    commande telle qu'écrite), `proposedExecpolicyAmendment`, `availableDecisions: ["accept",
    {acceptWithExecpolicyAmendment}, "cancel"]`. `decline` reste accepté (item `declined`).
    **`acceptForSession` n'est pas dans `availableDecisions`** : le « Toujours autoriser » d'un agent codex
    **local** (`CodexDriver.answer`, antérieur au chantier) l'envoie — non vérifié s'il est refusé, à
    signaler ;
  - non observé : la réaction de claude à une interruption pendant une demande (cas du rattachement
    `needs_input` de R.4) — reste à observer.
- **R.5**, deux reviews comprises — `src/daemon/remote/confirm.ts` (préfixes destructifs, règles `ask` de
  claude, tri `isDestructive`, motif de règle), insertions dans `RemoteAgentManager` (`screen`, `addRule`,
  événement `request_answered`), champs facultatifs `command` / `byRule` / `confirm` de `PendingRequest`
  (remplis par `ClaudeDriver` et `CodexDriver`, sans effet sur les agents locaux), `ConfirmCard` + styles
  (maquette `ServerChat`). Décisions prises en cours de point :
  - **fixé au lancement** : `confirmDestructive` est lu quand l'agent est (re)lancé ; le changer ne vaut
    qu'à la relance suivante ;
  - claude : une règle `ask` par préfixe (`Bash(<préfixe>:*)`) ; une demande forcée par **nos** règles
    (`decision_reason_rule_source: "flagSettings"`) ou dont la commande est destructive devient une carte de
    confirmation. Une règle `ask` de l'utilisateur distant reste une carte ordinaire ;
  - codex : lancé en `untrusted`. **En mode auto**, le daemon accepte seul une commande non destructive (le
    fil en garde l'exécution, `tool_start`) ; une demande sans commande (fichiers) n'est jamais acceptée
    d'office. **En mode default**, tout est soumis — le non destructif en carte ordinaire (plus de demandes
    qu'avant, assumé : accepter seul ferait passer une sortie de sandbox sans demande) ;
  - commande montrée et règle comparée **telles qu'exécutées** (codex : enveloppe `sh -lc '…'` ouverte, à
    défaut `command` brute, les `commandActions` en dernier) ; une règle couvre la **commande exacte**
    (espaces de bord retirés) à l'échelle du serveur, pas un préfixe ;
  - tri du daemon **penché vers la demande** : analyse hors guillemets, mots-clés du shell, lanceurs
    (`env`, `xargs`, `timeout`…), `sh -c` relu, shell lisant son entrée (`curl … | sh`) et code en ligne
    (`python -c`) demandés par principe, options globales de git et docker, `find -delete` / `-exec` ;
  - une demande couverte par une règle reste au fil (carte + `request_answered{auto: true}`) ; un échec de
    lecture des règles ou de réponse présente la carte, rien ne passe en silence ;
  - « Toujours autoriser » sur une carte de confirmation : règle écrite d'abord (`INSERT OR IGNORE`,
    contrainte `UNIQUE`), puis la demande autorisée, puis celles **de la file** que la règle couvre. Sur une
    carte ordinaire, comportement local inchangé ;
  - règles appliquées **seulement** quand la confirmation est active sur le serveur ;
  - deux lignes existantes modifiées (assumé) : l'import de `src/shared/conversation.ts` et les options du
    pilote dans `mount` (`...confirmOpts`).
- **Review R.5** : la première a relevé l'enveloppe codex non ouverte, l'acceptation d'office des demandes
  sans commande, un tri contournable (mots-clés, guillemets, lanceurs, interpréteurs), l'ordre règle /
  réponse, la file après « Toujours autoriser », la règle `ask` de l'utilisateur prise pour la nôtre ; la
  seconde, une récursion exponentielle sur les substitutions (bloquant : un message de commit plein de
  backticks gelait le daemon), l'ordre dans la boucle de file, les options de git et docker. Tous corrigés et
  testés. Écartés : un `extraArgs` de `RemoteDriver` écrasé (il n'en passe pas) ; `bypassPermissions` (pas
  proposé pour un serveur : `default`, `acceptEdits`, `auto`, `plan`).
- **Limite connue (R.5)** : la liste est un garde-fou par préfixes, pas un bac à sable. Échappent : un
  script (`bash deploy.sh`), `mv`, `sed -i`, une redirection qui écrase un fichier. **Côté claude en auto**,
  seul ce que ses règles `ask` rattrapent lui est soumis : une forme que le tri du daemon jugerait
  destructive mais que l'analyseur de claude ne relie pas au préfixe (`/usr/bin/rm`, `git -C d push`,
  `bash -c 'rm …'`) passe sans demande — non observé sur le vrai claude, à vérifier. Codex en auto : une
  modification de fichiers hors de l'espace de travail devient une carte (avant : jamais demandée).
- **Gate pendant R.5** : `test/web/accueil.test.tsx:119` (« expected 'fix/x' to be 'feat/s' ») rouge sur
  2 gates de suite avec le diff, vert seul (3/3 avec, 3/3 sur la base `2769a3b`), vert sur le gate de la
  base et sur les 2 derniers gates avec le diff ; même échec déjà vu en R.3 et R.4, avant ce code. Antériorité
  au chantier **non prouvée**. e2e : `e2e/nav-edition.spec.ts:45`, comme en R.4.
- **À trancher par l'opérateur (VPS)** : claude introuvable hors shell interactif — le relais et la
  détection échoueraient sur ce serveur tel quel.
- **R.6**, une review comprise — écran Discussion (`web/src/ecrans/Discussion.tsx`, route
  `/serveurs/:id/discussions/:discussionId`), résolveur `/serveurs/:id/discussion` (ligne de serveur de la barre
  gauche), table « Discussions sur <serveur> » de la carte Serveurs (agent · état, activité, Reprendre, clic de
  ligne), dialogue `NouvelleDiscussion`. Daemon : `PUT /api/server-agents/:id/messages/:seq/mark`,
  `GET …/options`, `PATCH …/settings`, `POST …/reconnect`. Décisions prises en cours de point :
  - **contexte de routes** (`web/src/conversation/routes.ts`) plutôt qu'une prop enfilée partout : le fil lit
    `/api/agents` + `/ws/agent` par défaut, `/api/server-agents` + `/ws/server-agent` sous l'écran Discussion,
    avec le nom du serveur et l'état « injoignable ». Le socket passe par `socketSur(chemin)` (sous-classe
    d'`AgentSocket`) pour que la création reste sur une ligne : un troisième argument faisait réindenter tout
    le bloc par Prettier ;
  - **« Ouvrir la discussion »** : la plus récente non archivée **par activité de son agent** (la date de la
    discussion ne bouge qu'au renommage), sinon le dialogue de création ; la barre gauche fait de même via le
    résolveur, qui renvoie sur l'écran Serveurs avec le dialogue ouvert (`state.creer`, effacé à la fermeture) ;
  - **« Reconnecter »** de la ligne d'échec : route `POST /api/server-agents/:id/reconnect` ajoutée (relance
    par reprise de session, sans message ; 202 si déjà vivant, 502 si le serveur ne répond pas). Celui du
    bandeau injoignable relance un contrôle du serveur (`/api/servers/:id/ping`) ;
  - **issue d'une demande lue au fil** pour un agent distant (`request_answered`, `request_cancelled`, ou fin
    de tour sans réponse) plutôt que par `agent.pending` : l'agent distant n'est pas dans `/api/state`, sa
    relecture (à chaque événement du fil, une à la fois, et toutes les 5 s) arriverait après la carte ;
  - une perte de lien et sa reprise font **une** ligne ; une perte suivie d'un échec devient la ligne rouge ;
  - **réglages** : seuls les champs envoyés sont validés (un modèle codex déjà en place reste valable avant
    que codex n'ait redonné son catalogue) ; le catalogue de l'agent lui-même passe avant celui d'un autre ;
    codex sous confirmation passé en auto depuis le composer reste en `untrusted`, le tri du daemon prend le
    relais (comme au lancement, R.5) ;
  - **pas de pièce jointe** sur un fil distant : c'est un fichier du daemon (D70), la route distante n'en
    prend pas ;
  - lignes existantes modifiées (assumé, toutes ciblées) : 16 dans `web/src/conversation/` — les URL
    `/api/agents/…` du composer, des réglages, de la carte de décision et du repère, le chemin du socket,
    l'import et les deux lignes de création du socket, le placeholder, les trois `disabled` / `joindre` du
    composer, `resolved` de la carte de décision ; 11 dans `Serveurs.tsx` (le bouton grisé et la table vide
    « avant R.6 » que ce point remplace) ; 2 dans `NavServeurs.tsx` (lien vers la discussion). Deux tests qui
    vérifiaient ce « avant R.6 » sont mis à jour (`serveurs.test.tsx`, `nav-serveurs.test.tsx`). La règle CSS
    du bouton `aria-disabled` de la carte reste, sans usage.
- **Review R.6** : retenus et corrigés — validation des réglages sur des champs non envoyés (422 sur un codex
  en veille), « Reconnecter » réussi sans retour visible, pièces jointes proposées sur un fil distant, ligne
  « reconnexion… » figée au-dessus d'un échec, libellé d'échec terminé par « : », catalogue codex d'un autre
  serveur préféré à celui de l'agent, dialogue de création rouvert par l'historique, erreur de ping jamais
  effacée, texte du bandeau, deux assertions de test trop faibles. Écartés : modes `acceptEdits` / `plan`
  sous confirmation (codex ne les accepte pas — 422 ; claude garde ses règles `ask` dans tous les modes,
  observé en D77) ; demande ordinaire sans `request_answered` (le daemon l'écrit pour toute réponse depuis
  R.5) ; course `setSettings` / relance (`relaunch` relit la ligne juste avant `mount`) ; débounce des
  relectures (une en vol, une en attente au plus).
- **Hors R.6, laissé** : onglets d'agents et « + Agent » (une discussion = un agent), bouton Panneau
  (groupe F), fichiers distants par `@`. Le dialogue de suppression d'un serveur dit encore « Rien n'est
  exécuté sur le serveur » alors que la suppression arrête ses agents (R.4) — texte à revoir.
- **Gate pendant R.6** : vert (1133, puis 1137 après la review). Entre les deux, `test/web/accueil.test.tsx:119`
  rouge une fois (« expected 'fix/x' to be 'feat/s' », même échec qu'en R.3-R.5), vert seul 3/3 et sur le
  gate suivant. e2e : `e2e/nav-edition.spec.ts:45` (« locator.press: Test ended »), comme en R.4 et R.5 ;
  34 passés.

## Journal du groupe F

- **F.1**, une review comprise — lecture de fichiers d'un serveur (`src/daemon/remote/files.ts`, routes
  `GET /api/servers/:id/fs?path=` et `GET /api/servers/:id/file?path=` dans `routes/servers.ts`, types
  `ServerFsEntry` / `ServerFsListing` / `ServerFilePreview` dans `shared/model.ts`).
  - un aller-retour par requête : un script POSIX `sh` (lancé par le shell de connexion, arguments passés
    par `shQuote`) résout le chemin par `realpath` sur le serveur, vérifie le périmètre, puis liste ou lit ;
    réponse en enregistrements séparés par un octet nul, précédés d'une marque — ce qu'un profil bavard
    écrit avant est ignoré ;
  - **périmètre** : chemin résolu, symlinks et `..` compris, dans un dossier autorisé résolu de même
    (`"$a"/*` : `~/proj-old` n'est pas dans `~/proj`). Un chemin absent est jugé sur son plus proche parent
    existant : hors périmètre, 403 qu'il existe ou non (pas de sondage du disque par 403 / 404). Le daemon
    revérifie le chemin résolu rendu par le script ;
  - **D78** (validée le 2026-10-30) : masqués comparés **sans casse** (`.ENV` est `.env` sur un système
    de fichiers insensible) — refusés sur le nom avant tout aller-retour, et sur le chemin résolu (un lien
    vers `.env` est refusé, son contenu jamais lu). Seuls les composants **sous** le dossier autorisé
    comptent : `/srv/id_app/proj` autorisé reste lisible. Dossier masqué jamais listé ; grisés listés si on
    le demande (le front ne les déplie pas). Aperçu 256 Kio ; binaire (octet nul dans les 8 premiers Kio)
    non transmis — réponse 200 `binary: true, content: null` plutôt qu'un refus, l'aperçu l'affiche ;
  - un niveau, plafonné à 2000 entrées (`truncated`) ; tri dossiers d'abord ; badges `git status` du
    dossier (`M` / `?`, un dossier porte celui de son contenu, renommages compris) ;
  - **lecture seule stricte** : `git --no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false`
    — ni index réécrit, ni fsmonitor du dépôt lancé (deux tests, vérifiés par mutation) ; `git status`
    borné à 8 s par `timeout` quand il existe : un gros dépôt perd ses badges, pas son listing ;
  - `ServerConnections.read` : une connexion perdue marque le serveur injoignable et répond 502 ;
  - `?path=` vide ou absent = `workdir` ;
  - texte du dialogue de suppression d'un serveur corrigé (liste et configuration) : la suppression arrête
    les agents et efface les discussions depuis R.4 (Q4). Lignes existantes modifiées : ces 4 lignes, rien
    d'autre.
- **Review F.1** : retenus et corrigés — masquage sensible à la casse, `git status` pouvant lancer le
  fsmonitor du dépôt, oracle d'existence hors périmètre, ancêtres du dossier autorisé comptés comme masqués,
  profil de connexion qui écrit sur stdout (502 permanent), `realpath` absent rendu en 404 (désormais 502
  explicite), aperçu coupé par le transport sans drapeau, nom à tabulation, chemins de `git status` pris
  pour des entrées, renommage en colonne Y, `?path=` vide. Tests ajoutés : injection par chemin et par nom
  de fichier, casse, préfixe frère, ancêtre masqué, absent hors périmètre, permissions, profil bavard,
  fsmonitor, témoin positif du journal ssh. Écartés ou reportés :
  - **secrets hors liste D78** (`.git/config` avec jeton, `.git-credentials`, `.netrc`, `.npmrc`, `.aws/`,
    `.gnupg/`, `*.pfx`…) : lisibles, conformément à D78 — **à reposer à l'opérateur à la review complète** ;
  - plafond de 2000 entrées appliqué dans l'ordre du glob, pas celui de l'affichage ;
  - coupure UTF-8 à la limite de 256 Kio (un U+FFFD final) ;
  - TOCTOU entre `realpath` et la lecture (suppose un accès en écriture au serveur) ;
  - shell de connexion `fish` : la double `shQuote` n'y est pas valable — concerne toute commande distante
    (`remoteCommand`), pas F.1 ; **à traiter à la review complète**.
- **Portabilité** : tests F.1 passés aussi avec `dash` comme `sh`. GNU coreutils non disponible sur ce poste
  (Docker arrêté, VM non lancée) : `realpath` / `head -c` / `tr` / `timeout` GNU à vérifier sur le serveur
  réel lors de la vérification opérateur.
- **Gate pendant F.1** : vert (1146, puis 1151 après la review). Entre les deux, `test/web/panneau-contexte.test.tsx`
  (« repli sur Plan quand l'onglet mémoire sélectionné disparaît, et y rend le focus » : focus sur `<body>`)
  rouge une fois, vert seul 3/3 et sur le gate suivant ; ni ce test ni son composant ne sont touchés.
  e2e : `e2e/nav-edition.spec.ts:45`, comme en R.4-R.6 ; 34 passés.
- **F.1 bis** — secrets : **règle immuable** posée par l'opérateur le 2026-10-30 (« secret → masqué ; pour
  l'afficher, on demandera le mot de passe de la machine »). `HIDDEN_PATTERNS` élargi en trois familles :
  - clés et coffres : la liste D78, plus clés d'hôte `ssh_host_*`, `*_rsa`, `*_ed25519`…, `*.ppk`, `*.pfx`,
    `*.p8`, `*.jks`, `*.kdbx`, `*.gpg`, `*.asc`, `*.ovpn`, `.gnupg`, `.password-store`, `shadow`, `environ` ;
  - jetons et identifiants d'outils : `.git-credentials`, `.gitconfig`, `.netrc`, `.npmrc`, `.yarnrc*`,
    `.pypirc`, `.pgpass`, `.my.cnf`, `.vault-token`, `.htpasswd`, `.aws`, `.azure`, `.docker`, `.kube`,
    `.databrickscfg`, `rclone.conf`, `gradle.properties`, `kubeconfig*`, `auth.json`, `wp-config.php`,
    `*.tfstate*`, `*.tfvars`, `*.env`, historiques de shell ; motifs `dossier/nom` vérifiés sur composants
    consécutifs : `*.git/config` (URL de remote avec jeton, dépôts nus compris), `*.git/modules`
    (sous-modules), `gh/hosts.yml`, `github-copilot/hosts.json`, `.config/gcloud`, `.m2/settings.xml`… —
    le dernier composant du dossier autorisé sert de parent, `.git` autorisé lui-même garde son `config` ;
  - mots de secret (`secret`, `credential`, `password`, `passwd`, `apikey`) : **sur les fichiers de
    données et les noms nus seulement** (`*secret*.json`, `.secrets`, `github_password`), pas sur le code —
    `PasswordInput.tsx`, `credentials.ts`, `secrets.py` restent lisibles. `token` plus serré
    (`token.json`, `*_token`, `access_token*`) : `tokens.json` (jetons de design) reste lisible.
    **Décision prise à la place de l'opérateur** à la review (sinon composants et sous-arbres entiers
    disparaissaient du panneau). Compromis assumé : `auth.json` masque aussi un fichier de traduction du
    même nom ; `.env.example` et `id_mapping.json` restent masqués (hérités de D78, règle immuable).
- **Review F.1 bis** (relancée deux fois : les deux premiers lancements, en tâche de fond, se sont figés
  sans sortie ; le troisième a rendu en 4 min) : retenus — clés privées sans `.key`, `.git/config` des
  dépôts nus et sous-modules, `token` / `apikey` / outils absents, `fish_history`, faux positifs des mots de
  secret sur le code, `.` dans un chemin qui contournait le pré-contrôle, casse générée sur `[a-z]`
  seulement. Tests ajoutés : parité `case` du script / regex du daemon sur toute la liste et sur des noms
  ordinaires (mutation vérifiée), revérification par le daemon du chemin résolu (`records`), contenu jamais
  sorti par ssh (le script seul, mutation vérifiée), `.git/./config`, dépôt nu, `gh` autorisé, faux
  positifs voulus, message de refus vérifié. Le fixture `secret.txt` des tests de périmètre devient
  `note.txt`. Écartés : écart de parent `~` lexical / résolu (le script et le daemon jugent sur le résolu),
  pliage de casse Unicode d'APFS (hors périmètre). Lignes de F.1 modifiées : la liste et les fonctions de
  masquage de `files.ts` (code du commit précédent).
- **Gate pendant F.1 bis** : vert (1152, puis 1155 après la review). Un passage intermédiaire à 12 rouges,
  tous en délai dépassé (~926 s par test, fichiers sans rapport) : horloge sautée pendant une mise en veille
  probable du poste, qui explique aussi les deux reviews figées ; relancé, vert.
- **Shells non POSIX** — décision opérateur du 2026-10-30 : « assumer que certains shells de connexion ne
  sont pas supportés pour le moment ». Toute commande distante passe, doublement quotée, par le shell de
  connexion du compte (`sshd` : `$SHELL -c`) : fish y réduit `\\` entre quotes simples, csh y refuse un saut
  de ligne entre quotes. Deux gardes :
  - `server.shell` (lancé par `-lc`) restreint aux shells POSIX par nom de base (`bash`, `zsh`, `sh`, `dash`,
    `ksh`, `ksh93`, `mksh`, `oksh`, `pdksh`, `loksh`, `ash`, `yash`), 400 sinon, raison dite. Un serveur déjà
    enregistré avec un autre shell refuse toute modification tant que son shell n'est pas changé (assumé) ;
  - sonde du **shell de connexion** portée par **chaque ping** (`echo aid-ok; printf '%s|' 'a\\b' 'c⏎d'`),
    sans connexion de plus : un shell qui l'altère (fish) ou la refuse (csh, « Unmatched ' ») met le serveur
    en `error` — jamais « connecté » — et l'étape `shell` du test en échec, avec « non supporté pour le
    moment ». Une coupure n'est jamais un verdict sur le shell.
  - fixture : `FAKE_SSH_SHELL` (shell de connexion simulé) ; le journal du faux ssh garde une ligne par
    appel même si la commande porte un saut de ligne (1 ligne existante modifiée). Faux fish et faux csh
    écrits par le test, sans dépendre de ce que la machine installe ; contrôle positif sur `sh` et sur
    `bash`, `dash`, `zsh`, `ksh` quand présents.
- **Review shells** : retenus — sonde faite au seul test (le ping restait « sain » sous fish) → portée par
  le ping ; toute défaillance de sonde lue comme « non supporté » → coupure classée d'abord ; `/bin/tcsh`
  absent des CI → faux csh ; shells `ksh93` / `oksh` / `pdksh` refusés à tort ; tests d'acceptation et de
  message. Reporté à la review complète : relais et agents ne vérifient pas eux-mêmes l'état du serveur
  avant de lancer (un serveur jamais pingé sous fish échouerait à la première commande, pas en silence :
  les scripts du relais portent sauts de ligne et `\\`).
- **Gate des shells** : vert (1158) au réveil du poste ; les trois passages de la nuit, rouges uniquement en
  délai dépassé (700 à 975 s par test), tombaient pendant la mise en veille (`caffeinate -i` n'empêche pas
  la veille capot fermé).
- **F.2** — Git d'un serveur (`src/daemon/remote/git.ts`, routes `GET /api/servers/:id/git/status`,
  `…/git/log?scope=all|branch`, `…/git/commits/:hash`, `POST …/git/{fetch,push,sync}` dans
  `routes/servers.ts`, types `ServerGitRepo` / `ServerGitStatus` / `ServerGitLog` dans `shared/git.ts`).
  Même préambule que F.1 (realpath, périmètre, masqués), puis : racine du dépôt bornée au dossier autorisé
  (`GIT_CEILING_DIRECTORIES` + revérification par le script et par le daemon), variables `GIT_*` du profil
  ignorées, jamais de prompt ni d'éditeur, lectures sans verrou optionnel ni fsmonitor. Le journal garde la
  forme de celui d'un sujet (`GitLogResponse`, `parseLog` et `LOG_FORMAT` de `git/inspect.ts` réexportés)
  pour que F.3 puisse reprendre les composants de `OngletGit`. Lignes existantes modifiées : aucune
  (exports ajoutés en fin de `files.ts` et d'`inspect.ts`, méthode `run` ajoutée à `ServerConnections`).
  **Décisions prises à la place de l'opérateur** (à reposer à la review complète) :
  - écritures **synchrones**, une à la fois par serveur (409 sinon), réponse = état du dépôt après
    l'opération — pas la file d'actions locale de D33, qui est celle d'un workspace ;
  - avance / retard mesurés sur `origin/<branche du même nom>`, pas sur l'amont configuré ; une branche
    jamais poussée a pour avance ses commits absents de tout `origin/*` ; Pousser = `push origin
    HEAD:refs/heads/<branche>`, jamais de force ni de `-u` (la configuration du dépôt ne change pas) ;
  - confirmation exigée **aussi par le daemon** (`confirm: true`, 400 sinon) en plus de la carte de F.3 ;
  - Synchroniser = fetch, rebase sur `origin/<branche>` s'il a avancé, puis poussée ; un rebase qui échoue
    est annulé aussitôt (rien ne change sur le serveur, conflit nommé) ; modifications suivies non
    commitées : refus avant tout (jamais d'autostash) ; **refusé sans avance**, conforme au plan — un simple
    tirage (retard seul) n'est donc pas proposé ;
  - un dossier autorisé situé **dans** un dépôt dont la racine est au-dessus n'est pas un dépôt pour A-I-D
    (le `.git` est hors périmètre) ;
  - dépôts détectés : profondeur 4, dossiers lourds sautés, dépôts sous un dossier masqué exclus, 50 au plus ;
  - « hors HEAD » (commits atténués) relu sur 2 000 commits des autres branches au plus ; au-delà, supposés
    dans HEAD ;
  - les hooks du dépôt du serveur (`pre-push`…) s'exécutent comme pour un push fait sur place.
- **Tests F.2** (`test/server-git.test.ts`, 16) : état et fetch, branche jamais poussée, HEAD détachée,
  dépôt vide, dossier non Git et dépôts détectés, racine hors périmètre, refus du périmètre de F.1, journal
  `all` / `branch` et WIP, détail (compteurs, binaire, premier commit, hash invalide sans effet), pousser
  (confirmation, sans avance, branche neuve sans `-u`, refus si origin a avancé, HEAD détachée / merge en
  cours / sans origin), synchroniser (linéaire, non-suivis gardés, conflit annulé, modifications suivies),
  une écriture à la fois, `GIT_DIR` du profil ignoré, identifiants d'URL jamais renvoyés, serveur
  injoignable. Mutations vérifiées : `unset GIT_*`, refus sans avance, `rebase --abort`.
- **Review F.2** — retenus :
  - branche et tag du même nom : `symbolic-ref --short` rendait `heads/main`, et Pousser aurait créé une
    branche `heads/main` sur origin (bloquant) → nom complet, préfixe `refs/heads/` retiré ;
  - délais : fetch, rebase et poussée bornés chacun à 45 s, aller-retour à 180 s ; le rebase est annulé
    par un `trap` si la connexion tombe ou si le délai saute en plein rebase ;
  - un mot de passe contenant `@` fuyait en partie (`https://u:p@ss@h/` → `ss@h`) → retiré jusqu'au
    dernier `@` avant l'hôte ;
  - un fichier nommé `fin`, `inhead`… était pris pour une section du détail d'un commit → sections
    marquées `/…`, jamais un chemin de `diff-tree` ;
  - confirmation liée à rien → Pousser et Synchroniser exigent `head`, le commit affiché sur la carte ; si
    HEAD a bougé entre l'affichage et le clic, le script refuse (409) ;
  - `gc.auto`, `maintenance.auto` et `push.followTags` neutralisés pour les écritures ;
  - message d'erreur : la dernière ligne `fatal` / `error` / `remote` / `!` plutôt que `Done` ;
  - une poussée qui échoue après un rebase réussi le dit ;
  - un chemin contenant une tabulation ;
  - test d'un chemin qui est un fichier.

  Tests ajoutés (21 au total) : commit affiché périmé, tag homonyme, hook `pre-push` qui refuse en
  affichant une URL avec identifiants, modifications seulement indexées, rebase en échec hors conflit
  (non-suivi qui gêne), enregistrements forgés (racine hors du dossier autorisé, candidats sous un dossier
  masqué, tabulation). Mutations vérifiées : `--short`, sentinelles, borne de `stripUserinfo`, `head`
  confirmé. Non prouvé par mutation : le choix de la ligne d'erreur, car le cas « `Done` en dernière
  ligne » n'est pas reproduit en local.

  Écarté, **à reposer à l'opérateur à la review complète** : un worktree dans un dossier autorisé dont le
  dépôt principal est au-dehors fait lire à `git log` des refs et objets hors périmètre. Le refuser rendrait
  inutilisable la disposition des worktrees d'A-I-D lui-même ; le contenu lu est celui du même projet,
  jamais un fichier de l'arbre hors périmètre.

  Reportés à la review complète :
  - un `git status` tué par son délai donne un comptage tronqué (faux « propre ») ;
  - sept appels git de 8 s peuvent dépasser le délai de lecture de 15 s : serveur vu injoignable à tort ;
  - `find` descend dans les dossiers masqués (noms seulement, filtrés ensuite) ;
  - fusions dans les commits locaux pendant Synchroniser (aplaties par le rebase).

  `LC_ALL=C` signalé absent : il est déjà exporté par le préambule de F.1.
- **Gate F.2** : vert (1174, puis 1179 après la review).
- **F.3** — panneau Fichiers / Git de l'écran Discussion (`web/src/ecrans/PanneauServeur.tsx`,
  `web/src/data/panneauServeur.ts`, routes `GET` / `PUT /api/servers/:id/panel`). Bouton **Panneau** dans
  l'en-tête, 360 px à droite du fil : la grille de `.discussion` ne s'applique que panneau ouvert
  (`:has(> .panneau-serveur)`), aucune ligne existante de l'écran touchée. Ouvert / fermé et onglet
  mémorisés par serveur dans `nav_pref` (clé `serveur.panneau.<id>`, effacée avec le serveur).
  - **Décision : composants dédiés pour l'onglet Git.** `OngletGit` est lié au sujet (`topicId`, file
    d'actions du sujet, `fetchGitLog` par sujet, `base` / `remote`) ; le découpler serait une réécriture.
    Repris tels quels : `CommitGraphe` (exporté par insertion), `layoutGraph`, `findRefTip` et les classes
    CSS du panneau d'un sujet. Même chose pour Fichiers : `OngletFichiers` lit l'arbre local d'un sujet ;
    `FileTreeRow` est neuf, il reprend `.arbre` / `.chevron` de la maquette.
  - Fichiers : racine = répertoire de la discussion, un dossier lu à son premier dépliage, ↻ relit la racine
    et les dossiers visibles en gardant l'arbre affiché jusqu'à la réponse ; badges `M` / `?`, entrée masquée
    atteignable au clavier mais jamais ouverte, dossier lourd grisé et dépliable ; aperçu à la place de
    l'arbre, binaire et tronqué signalés.
  - Git : journal (portée Toutes / Branche seule), sinon dépôts détectés ; Pousser / Synchroniser derrière
    une carte de confirmation (focus sur Annuler, Échap), POST lié au commit affiché ; carte refermée si
    HEAD a bougé à la relecture ; désactivés sans avance, sans branche, sans commit, opération en cours, et
    Synchroniser sans `origin/<branche>`.
  - `git log` décore `HEAD -> <branche>`, `layoutGraph` cherche `HEAD` seul : le panneau scinde la ref
    avant le graphe, sinon ni nœud courant ni ligne WIP. **Le même défaut touche l'onglet Git d'un sujet**
    (`findRefTip(commits, ['HEAD'])`, `web/src/ui/gitGraph.ts`) : préexistant, hors périmètre, non corrigé
    — à reposer à la review complète.
- **Tests F.3** : `test/server-panel.test.ts` (4 : défaut, mémorisation par serveur, corps validé et 404,
  suppression avec le serveur, valeur illisible) ; `test/web/panneau-serveur.test.tsx` (19 : ouverture et
  mémorisation, focus rendu à la fermeture, arbre et dépliage paresseux, masqué jamais lu, aperçu et binaire,
  erreurs, onglet Git, portée, pousser / synchroniser / fetch, désactivations, carte périmée, dépôts
  détectés et retour, WIP, détail, retour arrière d'un réglage non enregistré). Mutations vérifiées :
  effacement de la clé avec le serveur, dossier déjà lu non relu, carte périmée, Synchroniser sans
  upstream, retour arrière du réglage, scission `HEAD -> …`.
- **Review F.3** — retenus : ↻ démontait l'arbre ; Synchroniser actif sur une branche jamais poussée et
  carte qui annonçait « jusqu'à <hash> » pour un rebase (réécrit) ; Pousser actif pendant un merge ; carte
  périmée après relecture ; fuite du détail / de la carte d'un dépôt à l'autre, impasse après un dépôt en
  échec ; erreur de dossier jamais relue ; rôles ARIA (`tree`, `tab`, `listitem` sur des boutons) sans le
  comportement promis → boutons `aria-expanded` / `aria-pressed` ; focus (carte, Retour, fermeture) ;
  réglage optimiste sans retour arrière ; règle `set-state-in-effect` (état de chargement dérivé).
  Vérifiés sans changement : `head` vide refusé par le daemon (400), identifiants d'URL retirés des
  messages git (F.2), `extra` refusé en 400 (test vert).
  Reportés : âge de la seule racine (F.4) ; suppression du serveur et de sa clé hors transaction (la ligne
  existante n'est pas réécrite, une clé orpheline est inoffensive) ; état du panneau perdu au changement
  d'onglet ; un GET du réglage en échec pose le défaut, qu'un clic écrit ensuite ; second
  `import { useRef } from 'react'` dans `Discussion.tsx` pour ne pas modifier la ligne d'import existante.
- **Gate F.3** : vert (1202).
- **F.4** — actualisation du panneau. Relu à l'ouverture (montage), sur ↻, au retour du serveur (statut
  injoignable → joignable) et à la fin de chaque groupe d'outils de l'agent ; jamais en continu. Fin d'un
  groupe : un message, une fin de tour, une demande ou la sortie de l'agent après au moins un `tool_end` ; le
  lien rétabli (`connection_resumed`) compte aussi. Un événement redélivré (même `seq`) ne compte pas deux
  fois ; les déclencheurs rapprochés (retour du serveur puis lien rétabli, rafale de groupes) sont fondus en
  une relecture (300 ms). Injoignable : dernières données gardées, âge en ambre, ↻, Pousser, Synchroniser,
  Fetch et la validation d'une carte déjà ouverte désactivés.
  - Le fil (`Conversation`, partagé avec les sujets) expose l'événement par un `onItem` optionnel ajouté par
    insertion ; sans écran Discussion, il n'est pas renseigné.
  - Lignes de F.3 modifiées (6) : `disabled` de ↻ et de Fetch, `poussable`, la balise de l'âge, et les deux
    rappels de lecture d'un dossier (garde de la dernière relecture). Pas de forme par insertion pour
    désactiver un bouton ou garder une réponse.
- **Tests F.4** (`test/web/panneau-serveur.test.tsx`, +7) : `suivreOutils` (groupes, sortie, lien rétabli,
  `seq` redélivré), Git relu à la fin d'un groupe seulement, rafale fondue, Fichiers relus (dossiers dépliés,
  aperçu gardé), coupure puis retour en une relecture, ouverture pendant une coupure, relectures croisées
  d'un dossier. Mutations vérifiées : appel de `onItem`, saut pendant la coupure, relecture au retour,
  coalescence, garde de la dernière relecture d'un dossier.
- **Review F.4** — retenus : double relecture au retour (statut puis lien rétabli) → coalescence ; réponses
  croisées d'un dossier ; arbre périmé quand un aperçu est ouvert ; `seq` redélivré ; carte de confirmation
  ouverte avant la coupure encore validable ; sortie de l'agent après un outil ; assertions négatives
  affirmées avant la relecture ; coupure jamais exercée en transition. Écarté : « lectures Git croisées »,
  déjà gardées par le compteur de `lire` (F.3). Limite connue : un panneau ouvert pendant une coupure tente
  sa lecture d'ouverture (rien d'autre à afficher), l'erreur est alors montrée.
- **Gate F.4** : vert (1208).
