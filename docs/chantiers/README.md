# A-I-D v0.1 Socle : plan de développement

Ce dossier découpe le jalon v0.1 du [brief](../../brief.md) en chantiers exécutables. Un
modèle fort les a écrits après avoir lu le brief, les maquettes, agent-kernel 0.7.1 et
l'outillage du poste. Un modèle plus simple les exécute : il suit les points dans l'ordre,
un point par commit, et ne conçoit rien.

Un plan se suffit à lui-même. L'exécutant ne voit pas la conversation qui l'a produit.

## 1. Avant le premier commit : décisions à valider par Julien

Le brief demande que toute décision d'architecture absente de son §2 remonte à Julien.
Les plans sont écrits **avec la recommandation ci-dessous**. Si Julien en change une,
on corrige le plan concerné avant de l'exécuter. Une décision marquée « à valider » qui ne
l'est pas encore bloque les points qui en dépendent.

| N° | Décision | Pourquoi elle se pose | Recommandation | Bloque |
| --- | --- | --- | --- | --- |
| D1 | **Nom du paquet npm** | `aid` existe déjà sur npm (`aid@0.0.1`, un tiers, 2022). Avec ce nom, `npx aid` exécute **le code de quelqu'un d'autre**. | **Validé le 2026-10-15** : paquet `aidboard` (« A-I-D Board », libre sur npm à cette date). Deux binaires : `aidboard` et `aid`. On lance avec `npx aidboard` (npx choisit le binaire qui porte le nom du paquet). Après `npm i -g aidboard`, la commande `aid` est disponible aussi. On amende la ligne « Distribution » du §2. Le nom n'est pas réservé tant que rien n'est publié : la réservation par un `0.0.0` vide attend l'accord de Julien (action publique). | 05 |
| D2 | **Persistance des terminaux** | Un tampon circulaire d'octets bruts rejoué tel quel casse les interfaces plein écran comme `claude` et `codex` : le tampon commence au milieu d'une séquence d'échappement et ne contient plus l'état initial de l'écran (écran alternatif, modes du curseur). | Le daemon tient, pour chaque agent, un terminal *headless* (`@xterm/headless` avec `@xterm/addon-serialize`). À la reconnexion, il envoie l'état sérialisé (écran et 5 000 lignes d'historique), puis le direct. Le journal disque reste brut. C'est ainsi qu'on réalise le « tampon circulaire » du brief. | 03 |
| D3 | **Taille d'un PTY vu par plusieurs clients** | Un PTY n'a qu'une seule taille, alors que le téléphone et le poste ont chacun la leur. | La dernière vue qui a reçu une saisie ou un clic impose la taille. Les autres vues gardent cette taille, défilent si besoin et affichent `pty.taille` (le champ existe déjà dans les maquettes). | 03, 04 |
| D4 | **Version de Node** | Le brief fixe Node 22, mais le poste tourne en 24.21. Les modules natifs se compilent pour l'ABI du Node qui les installe. | `engines: ">=22.12 <25"`. Le dev est épinglé en 22 par `mise.toml`, et le gate tourne aussi en 24 avant chaque livraison de chantier. | 00 |
| D5 | **node-pty sous Linux et WSL2** | node-pty 1.1.0 n'a **aucun binaire Linux précompilé** (vérifié dans le tarball : darwin et win32 seulement). Sous WSL2, l'installation compile avec node-gyp et échoue s'il manque `python3`, `make` ou `g++`. | On garde node-pty officiel, conformément au §2. Prérequis documenté : `sudo apt install build-essential python3`. `aid doctor` le vérifie. On écarte les forks « prebuilt » : c'est une dépendance tierce de plus sur un composant qui exécute des commandes. | 05 |
| D6 | **`codegraph init` dans un worktree neuf** | Le brief demande de le lancer à chaque `topic.create`. Mais les consignes de Julien disent qu'indexer un projet reste sa décision. | On lance `codegraph init -y` **seulement si le checkout principal du workspace a déjà un `.codegraph/`**, c'est-à-dire si le projet a déjà adopté l'index. L'indexation tourne en arrière-plan et le sujet est utilisable tout de suite. Sinon, la fiche affiche « index absent : lecture directe ». | 02 |
| D7 | **`topic.cleanup` et les commits** | Le brief dit « branche locale supprimée ». Un `git branch -D` détruirait des commits jamais poussés ni fusionnés, ce que le brief ne mentionne pas. | Refus en code 2 si le worktree a du non-commité (cas du brief). Refus en code 2 aussi si la branche a des commits absents de `origin/<base>`, avec le compte de ces commits. Une confirmation humaine explicite (`confirm`) permet de forcer. Refus côté daemon si un agent du sujet tourne encore. | 02 |
| D8 | **Cycle de vie du daemon** | Les PTY sont des enfants du daemon : un redémarrage tue les agents. Le brief laisse la reprise (`claude --resume`) en question ouverte. | `aid` lance le daemon détaché, et `aid stop` refuse de l'arrêter s'il reste des agents vivants, sauf avec `--force`. Au démarrage, une réconciliation passe en `stopped` tout agent resté vivant en base et émet `agent.exited {reason: "daemon_restart"}`. On ne tente aucune reprise en v0.1. | 01, 03 |
| D9 | **Environnement des agents** | Une `ANTHROPIC_API_KEY` présente dans l'environnement fait basculer `claude` de l'abonnement vers la facturation API (incident du 2026-09-26). | Le daemon retire de l'environnement des PTY la liste `env.strip` de `~/.aid/config.yaml`. Par défaut : `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`. On n'injecte rien d'autre que `TERM`, `COLORTERM` et les `AID_*`. **À valider** : faut-il aussi retirer `OPENAI_API_KEY` pour `codex` ? | 03 |
| D10 | **Dérivation de l'état** | Le §3 fait du journal d'événements la seule source de l'état, et le §4 réserve au daemon la dérivation. | Insérer l'événement et mettre à jour les tables de projection dans **une même transaction** SQLite. Un test reconstruit les projections depuis le journal et les compare aux tables. L'UI ne dérive rien : à chaque événement reçu, elle relit `GET /api/state` (avec un anti-rebond de 100 ms). | 01, 04 |
| D11 | **Dépôt GitHub** | `a-i-d/` n'est pas encore un dépôt git. Créer un dépôt distant est une action visible des autres. | `git init` local au point 00.1. La création de `morzu117/a-i-d` (privé) attend l'accord de Julien. Le `/sync` du kernel a lieu avant le premier chantier de dev. | 00 |
| D12 | **Port d'écoute** | Le cookie de session et la vérification d'`Origin` dépendent d'un port stable. | Port fixe `4870`, réglable dans `config.yaml`. S'il est pris, le daemon s'arrête avec un message clair. Pas d'incrément automatique, qui changerait l'origine de façon silencieuse. | 01 |
| D13 | **Écrans non maquettés** | Aucune maquette ne couvre « enregistrer un workspace » ni « créer un sujet ». | Deux dialogues sobres, construits uniquement avec les variables CSS des maquettes. Pas de nouvelle maquette pour la v0.1. | 04 |
| D14 | **Statut d'agent en v0.1** | Les statuts fins arrivent en v0.2. Afficher « En cours » pour un agent qui attend en réalité une permission serait un repli silencieux. | En v0.1, un agent vivant est en `starting` et s'affiche « Lancé · statut non suivi », en gris, sans pastille de couleur. À sa sortie, il passe en `done`, `error` ou `stopped`. | 03, 04 |
| D15 | **Sujet `draft` avant le worktree, slug libéré si abandonné** | Les écrans 2.1/2.2 montrent un sujet `draft` consultable avant que `git worktree add` tourne ; `topic.cleanup` n'a rien à nettoyer pour un brouillon jamais matérialisé. | La ligne `topics` est insérée en `draft` dès `POST /api/topics`, avant le script. Un abandon (`topic.setup-ignorer`) **supprime** la ligne (et son run implicite) plutôt que de la faire passer par `archived` : aucune migration de schéma n'est nécessaire, et le slug redevient libre dès que la ligne qui le portait disparaît. | 06 |
| D16 | **Avance/retard et rebase en pause : jamais stockés** | Ces valeurs dérivent hors d'A-I-D (un rebase ou un fetch lancés à la main) ; les stocker reproduirait le bug de branche périmée déjà corrigé hors chantier. | Lues en direct à chaque `GET /api/state`, dans la continuité de `syncTopicBranches` (branche déjà traitée ainsi). | 06 |
| D17 | **`gh` CLI pour GitHub, pas de client REST** | `aid doctor` attend déjà `gh` (« requis à partir de la v0.3 »). Un client REST avec jeton géré par A-I-D serait un second mécanisme pour le même besoin. | `topic.pr` et `topic.merge` appellent `gh pr create`/`gh pr merge`/`gh pr view --json`, exactement comme les commandes affichées dans les maquettes. | 06 |
| D18 | **Revue de PR : sondée à la demande** | Aucun endpoint public pour recevoir un webhook GitHub. | `pr.rafraichir` relance `gh pr view --json` comme une action classique ; pas de sondage automatique en tâche de fond en v0.3. | 06 |
| D19 | **`topic.sync`/`topic.pr`/`topic.merge` partagent la file du workspace** | Un `fetch` touche des refs partagées du dépôt même depuis un worktree lié : même risque de verrou que `git worktree add` (section 2). | Même `WorkspaceQueue` que `topic.create`/`topic.cleanup`, pas de file plus fine par sujet. | 06 |
| D20 | **« Lancer les tests » : commande fixe en v0.3** | La configurabilité complète du registre d'actions est un chantier à part entière, pas un détail d'un point ; aucun second cas d'usage connu ne justifie une couche de config pour un seul réglage. | `topic.test` lance `npm test` en dur. Révisable sans migration le jour où un deuxième projet a besoin d'une autre commande. | 06 |
| D21 | **Nettoyage sur fichiers non commités (écran 2.8)** | Le script actuel refuse tout net ; la maquette prévoit « mettre de côté puis nettoyer » ou « supprimer sans garder ». | `topic-cleanup.sh` apprend `AID_DIRTY_ACTION` (`stash` ou `force`), en insertion pure sur le script existant ; `force` exige `confirmed: true` dans le corps de la requête (422 sinon). | 06 |
| D22 | **Onglet actif de la page Sujet** | L'export (3.1-3.6) ajoute une barre Agents/Git/Fichiers que le code n'a pas. | État UI pur (React + `?onglet=`), jamais persisté, défaut `agents` (comportement actuel inchangé). | 11 |
| D23 | **Lecture vs écriture du Git/Fichiers tab** | `git log`/`git status` sur tout le worktree à chaque tick de `/api/state` serait trop coûteux et dériverait hors d'A-I-D. | Lectures en `GET` à la demande, hors file ; écritures qui touchent les refs partagées (fetch, push, changer de branche) en file `WorkspaceQueue` comme `topic.sync` (D19 étendu). | 11 |
| D24 | **Géométrie du graphe de commits** | Stocker ou calculer côté serveur la position des voies dupliquerait une donnée dérivable du client. | Le backend rend les commits bruts ; le graphe (voies, couleurs, SVG) se calcule côté client, algorithme du README de l'export. | 11 |
| D25 | **Changer de branche** | Un `git switch` concurrent sur le même dépôt a le même risque de verrou que `git worktree add` (section 2). | Nouveau script `topic-switch.sh`, même file que `topic.sync` (D19), dirty-handling = vocabulaire `AID_DIRTY_ACTION` de D21. | 11 |
| D26 | **Créer une branche** | L'export propose « ici » et « depuis la base » sans toucher au sujet. | Même script que D25 (`AID_CREATE=1`) ; ne change jamais `topics.branch` ni l'état du sujet. | 11 |
| D27 | **« Rattacher » une branche (écran 3.6)** | L'export permet d'adopter la branche courante du worktree comme branche de référence du sujet. | Seule action du chantier 11 qui écrit en base : met à jour `topics.branch` (colonne déjà existante, aucune migration). | 11 |
| D28 | **Détection de la dérive (écran 3.6)** | Comparer la branche courante à `topic.branch` dérive hors d'A-I-D si quelqu'un change de branche à la main. | Champ `onTopicBranch` lu en direct dans `gitLiveInfo`, jamais stocké (même raisonnement que D16). | 11 |
| D29 | **Arbre de fichiers + statut git (écran 3.4)** | Un chemin fourni par le client pourrait sortir du worktree (traversée `../`) ; un fichier binaire ou énorme ne doit pas être lu entièrement. | `git status` fusionné à un parcours borné (`MAX_ENTRIES`), chemin toujours résolu et vérifié sous `topic.worktree`, fichier binaire/>1 Mo refusé (422). | 11 |
| D30 | **Rendu de la visionneuse Markdown** | Le contenu d'un fichier du dépôt (potentiellement d'une branche distante) n'est pas un contenu de confiance. | Dépendance `marked` en tokenizer seul ; rendu JSX des tokens, jamais `dangerouslySetInnerHTML`. | 11 |
| D31 | **Coloration syntaxique de la vue source** | Ajouter Shiki/Monaco pour un seul écran reviendrait sur le hors-périmètre v0.1 « diff et Monaco » (§5) sans second cas d'usage. | Numéros de ligne et police monospace seulement en v1 ; révisable sans migration. | 11 |
| D32 | **`diff.ouvrir`/`editeur.ouvrir-fichier`** | L'export les affiche comme des actions d'ouverture, pas comme un visualiseur de diff en app. | Délèguent à l'éditeur externe déjà configuré (`editor.ts`), avec repli déclaré si l'éditeur ne connaît pas d'argument diff. | 11 |
| D33 | **Fetch et push (écran 3.2)** | Ce sont des écritures sur les refs partagées du dépôt, pas de simples lectures. | Deux scripts minimaux, même file que `topic.sync` (D19/D23) ; « Pousser » reste désactivé sans avance, vérifié aussi côté serveur. | 11 |

### Prérequis machine (état au 2026-10-15)

| Constat | Effet | Suite |
| --- | --- | --- |
| gbrain **0.60.249.0** installé ; le noyau **0.8.0** (branche locale `chore/gbrain-0.60.249` d'agent-kernel, non poussée) en relève l'épingle | `bootstrap-machine.sh --check` : « Machine prête ». Le projet reste épinglé en noyau 0.7.1 (`agent.yml`) tant que la 0.8.0 n'est pas mergée. | Merger le noyau 0.8.0, puis `/sync` dans A-I-D. |
| Migration de données gbrain v0.13.1 **partielle** (449 pages sur 1440 en `source_changed`, 15 migrations en attente) | Lecture OK, `write_through` à `false`. Rejouer la migration réécrit du frontmatter dans les dépôts sources : voir la note du noyau. | **À décider par Julien** avant de la rejouer. |
| Source gbrain `aid` absente | Les pages `aid/plan/…` n'ont nulle part où s'écrire. | `gbrain sources add` (fédérée ou isolée : à choisir), puis `.gbrain-source`. |
| codegraph 1.6.2, épinglé 1.6.0 | Simple avertissement. | Ne pas relancer tout `bootstrap-machine.sh` : il le redescendrait. |
| Pas d'index `.codegraph/` dans `a-i-d` | Les agents lisent directement (repli déclaré). | `codegraph init` quand le code existera (chantier 01). |

### Spec v1 révisée (lue le 2026-10-15 à 22:46, rev 89) et export « git flow »

La spec est le document Claude Docs lié en tête du brief ; l'export `design/maquettes/git-flow/` (écrans 2.1 à 2.9, jalon v0.3) est arrivé en même temps. Ce qui en a été repris pendant la v0.1, et ce qui est reporté :

| Point de la spec ou du design | Décision |
| --- | --- |
| Arrêt des agents : SIGINT puis SIGTERM | **Repris** (chantier 03.4). SIGHUP ajouté en troisième palier : un shell interactif ignore SIGTERM. SIGKILL du groupe à l'échéance. |
| Événements `plan.updated`, `task.status`, `instructions.updated`, source `relay`, `agent.spawned` avec `role` et `cwd` | **Repris** : le schéma les accepte dès maintenant. Un agent ne peut pas les émettre. |
| Navigateur ouvert sur `/?token=…` | **Repris** : `/auth?token=` reste accepté. |
| Rétention configurable des journaux PTY | **Repris** : `terminal.logRetentionDays`, 30 par défaut, purge au démarrage. |
| Redémarrer le daemon arrête les agents, sauf les runs Swairm | Sans objet en v0.1 (pas de run Swairm). À garder en v0.4 : les runs Swairm vivent dans leur propre process. |
| Sujet `draft` « créé, pas de worktree », écrans 2.1 et 2.2 (préparation, `topic.setup`, `topic.create-existante`) | **Reporté en v0.3.** En v0.1 le sujet n'existe en base qu'après le succès du script (décision du plan 02, testée). Le design git flow suppose un sujet `draft` pendant la préparation et une commande `worktree.setup` : il faudra une migration et lever l'unicité du slug pour un brouillon abandonné. |
| `Sujet.prUrl`, entité `Tâche` (sous-worktrees `<branche>--t<n>`) | Reportés en v0.3 et v0.4. |
| **Brief révisé du 2026-10-15 22:39** : la ruche Swairm est suivie par le CLI `swairm` en lecture seule (`status`, `inbox`, `events --follow`, JSON versionné), plus par `gh`, labels et commentaires ; plus de `swairm.yml` lu | **Aucun effet sur le code de la v0.1**, repris dans `brief.md`. À prévoir pour la v0.4 : (1) raison de `needs_input` `hive`, dédoublonnée par la `cle` de l'inbox ; (2) un sujet de la ruche a sa branche et son worktree gérés par la ruche : `topic.cleanup` doit **refuser** les sujets en mode `swairm` (les règles git du §5 du brief ne s'y appliquent pas) ; (3) un vol en cours est un agent `swairm-drone` `transport: 'remote'`, jamais lancé par le `AgentManager` ; (4) `aid doctor` vérifiera la présence du CLI `swairm` ; (5) le contrat du CLI est `docs/cli-swairm.md` dans le dépôt swairm. |
| Spec : « sur Windows, le navigateur ouvre `http://localhost:<port>` » | Le plan 05 ouvre toujours `127.0.0.1` (un `localhost` peut se résoudre en `::1`). Le daemon accepte les deux dans `Host`. |

## 2. Registre des risques anticipés

Chaque risque a sa parade dans un point précis. L'exécutant ne les redécouvre pas : il les
lit ici et dans la section « Pièges » de chaque plan.

| Risque | Effet si on l'ignore | Parade | Où |
| --- | --- | --- | --- |
| `npx aid` exécuterait un paquet tiers (`aid` est pris) | Exécution de code arbitraire sur le poste | D1 | 05 |
| `spawn-helper` de node-pty livré en mode `0644` (vérifié dans le tarball 1.1.0) | `posix_spawnp failed` au premier lancement sur macOS | Test de fumée au démarrage du daemon et `chmod +x` des `prebuilds/darwin-*/spawn-helper` dans un script `postinstall` | 03.1, 05 |
| Compilation de node-pty sous WSL2 | `npx` échoue sans message utile | D5 et `aid doctor` | 05 |
| Instantané rejoué au milieu d'une séquence | Terminal illisible après reconnexion | D2 | 03.2 |
| Course entre l'instantané et le direct (`xterm.write` est asynchrone) | Octets perdus ou en double à la reconnexion | Barrière `write('', cb)` décrite en 03.2 | 03.2 |
| Client WebSocket lent (téléphone) | La mémoire du daemon grossit sans limite | Au-delà de 4 Mo en attente, on coupe ce client (code 4001). Il se reconnecte et reçoit un instantané. On ne met jamais le PTY en pause pour un client. | 03.3 |
| `git worktree add` lancés en parallèle sur un même repo | `index.lock` ou verrous de refs en conflit, échecs aléatoires | Une file d'exécution par workspace pour toute action git qui modifie l'état | 02.2 |
| Branche créée avec `origin/main` comme amont | `git pull` tire main, et un `push.default=upstream` pousse **sur main** | `git worktree add --no-track` | 02.3 |
| `topic.cleanup` qui supprime des commits | Perte de travail | D7 | 02.4 |
| Démon codegraph orphelin après la suppression du worktree | Un processus qui tourne pour rien, ou un worktree impossible à supprimer | Tuer le pid de `.codegraph/daemon.pid`, puis `codegraph uninit -f`, avant `git worktree remove` ; un `reindex` admin par sujet (`POST /api/structural/reindex`) relance proprement sans attendre une suppression de worktree | 02.4, 08.4 |
| Slug ou titre injecté dans le shell | Injection de commandes | Slug validé par `^[a-z0-9][a-z0-9-]{0,47}$`. Les scripts reçoivent leurs valeurs par variables d'environnement, et les processus se lancent avec `spawn(fichier, args)`, jamais par une chaîne shell. | 02.1 |
| `ANTHROPIC_API_KEY` héritée par `claude` | Facturation API silencieuse | D9 | 03.1 |
| Dialogue de confiance de `claude` ou de `codex` dans chaque nouveau worktree | Le premier lancement semble bloqué | Comportement normal à documenter. A-I-D n'écrit pas dans `~/.claude.json` (§2 : il n'injecte rien). | 04, 05 |
| Navigateur Windows et daemon dans WSL2 : `localhost` peut se résoudre en `::1` | La page ne charge pas | L'URL d'ouverture utilise toujours `127.0.0.1`. Ouverture par `wslview`, sinon `cmd.exe /c start`. | 05 |
| Repo placé sous `/mnt/c` dans WSL2 | git et l'indexation deviennent très lents | Avertissement à l'enregistrement du workspace | 02.1 |
| Deux daemons sur le même `state.db` | État corrompu, PTY orphelins | Verrou `~/.aid/daemon.lock` (pid), avec contrôle de vie du pid | 01.2 |
| Journaux PTY qui peuvent contenir des secrets | Fuite locale | `~/.aid` en `0700`, fichiers en `0600`, rotation à 50 Mo | 01.1, 03.1 |
| Texte d'agent rendu comme du HTML | XSS dans l'UI locale | Règle ESLint `react/no-danger` en erreur, et un test | 04 |
| Rechargement à chaud du daemon pendant le dev | Chaque sauvegarde tue les agents de test | Le daemon ne se recharge pas à chaud. Seule l'UI passe par Vite en dev, avec un proxy vers le daemon. | 00.3 |
| Sessions `claude` dans les tests automatiques | Consommation de quota, tests non déterministes | Les tests automatiques utilisent `shell` et un faux agent (`test/fixtures/fake-agent.sh`). `claude` ne sert qu'à la recette manuelle. | 03, 05 |
| Nettoyage de branches fusionnées en *squash* | `git branch -d` les croit non fusionnées | Confirmation explicite (D7). La détection par `gh` viendra en v0.3. | 02.4 |
| Archive AID Server corrompue ou tronquée au téléchargement | Un `current` qui pointe sur une installation cassée, daemon qui ne démarre plus | SHA-256 vérifié contre `SHA256SUMS` avant extraction, extraction dans `<version>.partial`, bascule atomique de `current` seulement après contrôle de `bin/aid`, `node/bin/node` et `dist/cli/aid.js` | 13.5, 13.6 |
| Nouvelle version d'AID Server qui ne démarre pas | Board inutilisable après une mise à jour | Les deux dernières versions restent sous `~/.aid/server` ; `aid server use <précédente>` rebascule `current`, puis `aid stop` et `aid` | 13.5 |
| Bundle AID Board non signé ou `latest.json` incomplet | L'updater refuse en silence, personne ne se met à jour | Le job `publish` vérifie une signature par plateforme dans `latest.json` avant de rendre la release publique | 13.9 |

## 3. Ordre et branches

Branches empilées : chacune part de la précédente, et sa PR vise la branche parente. **État au 2026-10-16 : les six
chantiers sont exécutés en local (rien n'est poussé, aucune PR ouverte).**

| N° | Chantier | Branche | Base de la PR | État |
| --- | --- | --- | --- | --- |
| 00 | [Amorçage du dépôt](00-amorcage.md) | `chore/amorcage` | `main` | fait |
| 01 | [Daemon : état, journal, sécurité](01-daemon-etat-securite.md) | `feat/daemon-socle` | `chore/amorcage` | fait |
| 02 | [Workspaces, sujets et worktrees](02-workspaces-sujets.md) | `feat/sujets-worktrees` | `feat/daemon-socle` | fait |
| 03 | [Terminaux persistants](03-terminaux-persistants.md) | `feat/terminaux` | `feat/sujets-worktrees` | fait |
| — | Alignement sur la spec v1 révisée + maquettes git flow | `feat/aligner-spec-v1` | `feat/terminaux` | fait |
| 04 | [Interface v0.1](04-interface.md) | `feat/interface-socle` | `feat/aligner-spec-v1` | fait |
| 05 | [CLI, distribution et recette](05-cli-distribution-recette.md) | `feat/cli-recette` | `feat/interface-socle` | fait, recette humaine à finir : [recette-v0.1.md](../recette-v0.1.md) |
| — | Explorateur de dossiers, terminal, projets 0..N | `feat/selecteur-dossier` | `main` | fait |
| 06 | [Statuts réels, Accueil et Boîte de réception (v0.2)](06-maquettes-v0.2.md) | `feat/maquettes-v0.2` | `feat/selecteur-dossier` | en cours |
| 07 | [Git flow (sujet draft → sync → PR → fusion → archive)](07-git-flow.md) | `feat/git-flow` | `feat/cli-recette` | fait, recette humaine à finir : [recette-v0.3.md](../recette-v0.3.md) |
| 11 | [Page Sujet : onglets Agents / Git / Fichiers](11-onglets-git-fichiers.md) | `feat/onglets-git-fichiers` | `main` | à faire |

## 4. Correspondance avec les critères d'acceptation du brief

| Critère (brief §10) | Prouvé par |
| --- | --- |
| Trois sujets tournent en parallèle, chacun avec une session Claude | e2e `trois-sujets.spec.ts` (avec `shell`) en 05.3, puis recette manuelle avec `claude` en 05.4 |
| Fermer puis rouvrir l'onglet : agents vivants, historique intact | e2e `reconnexion.spec.ts` en 05.3, test d'intégration `pty-reconnect.test.ts` en 03.2 |
| `topic.cleanup` refuse un worktree avec du non-commité | `topic-cleanup.test.ts` en 02.4 |
| Un worktree sans index affiche le repli déclaré | `topic-create.test.ts` en 02.3, et e2e en 05.3 |
| `Origin` étranger ou absence de token : requête rejetée | `securite.test.ts` en 01.3 |
| Testé sur macOS et sous WSL2 | Recette 05.4, avec sa grille cochée dans la PR |

## 5. Hors périmètre v0.1 (à ne pas anticiper dans le code)

Hooks, `aid emit` et statuts fins, boîte de réception (écran 1.2), diff et Monaco, actions
configurables, lecture d'`agent.yml` et dérive du kernel, Swairm, grokbot, notifications,
intervention directe depuis les cartes (`message.saisir`, `demande.repondre`), consignes,
fil d'événements dans l'UI. Le **schéma** prévoit ces besoins (types d'événements,
`RunMode`, `transport`), mais aucun code ne les implémente.

## 6. Pile retenue

| Rôle | Choix |
| --- | --- |
| Daemon | Node 22, TypeScript strict, Fastify 5, `@fastify/websocket` (bâti sur `ws`), `@fastify/cookie`, `@fastify/static`, schémas TypeBox |
| Persistance | `better-sqlite3` (WAL), migrations SQL versionnées par `PRAGMA user_version` |
| Terminaux | `node-pty` 1.1, `@xterm/headless` 6 et `@xterm/addon-serialize` côté daemon, `@xterm/xterm` 6 côté UI |
| Front | React 19, Vite, `react-router`, CSS reprise des variables des maquettes, Inter servie en local |
| Identifiants | `ulid` (avec `monotonicFactory`) |
| Config | `yaml` pour `~/.aid/config.yaml` |
| Tests | Vitest (unitaires et intégration, avec de vrais git et de vrais PTY dans des répertoires temporaires), Playwright (e2e) |
| Qualité | ESLint (flat config) et Prettier en vérification seule |
| Build | `tsup` pour le daemon et le CLI vers `dist/`, Vite pour l'UI vers `dist/web/` |

Un seul paquet npm, sans *workspaces*, pour une publication simple.

## 7. Forme d'un plan

1. **Pourquoi** : le problème, en quelques lignes.
2. **État actuel** : ce qui existe déjà, avec `fichier:ligne`.
3. **Cible et hors-périmètre** : ce qui est livré et ce qui ne l'est pas.
4. **Décisions prises**, et ce que l'exécutant ne tranche pas seul.
5. **Points** : un point est un commit. Pour chacun : les fichiers, les signatures, les
   tests et la commande de vérification.
6. **Pièges**.
7. **Fini quand**.

## 8. Règles pour l'exécutant

- Lire le plan en entier avant le premier point, ainsi que les sections 1 et 2 de ce README.
- Un point, un commit. Le gate complet (`npm run gate`) doit être vert **en entier** avant
  chaque commit.
- Ne pas modifier les lignes existantes que le point n'autorise pas à toucher. Tout le reste
  est de l'insertion. Le contrôle mécanique du kernel s'applique :
  `git --no-pager show HEAD | grep -E "^-" | grep -vE "^---" | wc -l` doit rester proche de 0.
- Aucun push, aucune PR, aucun merge (§12 du brief).
- Commentaires, messages d'erreur et libellés de l'UI en français. Identifiants de code en
  anglais, comme dans le brief (`topicId`, `AgentStatus`).
- Une question de conception que le plan ne tranche pas : s'arrêter et la signaler, ne pas
  choisir.
- Un test existant qui casse : comprendre pourquoi. Ne jamais l'adapter pour le faire
  passer si le plan ne le prévoit pas.
- Ne jamais lancer `claude` ni `codex` dans un test automatique.

## 9. Chantiers hors v0.1

Indépendants de la pile v0.1 ; chacun porte son propre jalon.

| N° | Chantier | Branche | Base | Dépend de | Prépare |
| --- | --- | --- | --- | --- | --- |
| 06 | [Mémoire locale : A-I-D porte la capacité `memory` du kernel](06-memoire-locale.md) | `feat/memoire-locale` | `feat/cli-recette` | agent-kernel 0.9.0 (`docs/chantiers/` du noyau) : le contrat `aid mem` est partagé | v0.3 (phase du sujet lue dans les pages) |
| 08 | [Index structurel : A-I-D porte la capacité `structural_index` du kernel](08-index-structurel.md) | `feat/index-structurel` | `main` | 06 : même daemon, même serveur MCP `aid` | pont mémoire ↔ code (table de liens, extracteurs Prisma/HTTP), banc Kivgraph (second adaptateur) |
| 09 | [Fusion du noyau : agent-kernel devient le module `kernel` d'aidboard](09-fusion-agent-kernel.md) | `feat/fusion-noyau` | `main` | 06 et 08 : les deux capacités que le noyau nomme sont déjà portées par le daemon aidboard | agent-kernel n'est plus un dépôt à cloner ni à maintenir ; toute évolution de la politique (routage, phases, rôles) se fait dans aidboard |
| 10 | [Décommission de gbrain : récupérer la connaissance, puis retirer les composants](10-decommission-gbrain.md) | `chore/decommission-gbrain` | `main` | 06 : `aid mem` est la destination de la connaissance récupérée | gbrain retiré partout — binaire, secrets, adaptateur du noyau, projet Supabase |
| 13 | [AID Server et AID Board : deux produits, un dépôt, des releases GitHub](13-aid-server-aid-board.md) | `feat/releases` | `main` | 05 : le tarball `npm pack` et `aid doctor` sont la base de l'archive serveur ; app Tauri (PR #36) | installation sans clone ni Node ; mise à jour par releases ; CI sur chaque PR |
