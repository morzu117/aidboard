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

### Prérequis machine (état au 2026-10-15)

| Constat | Effet | Suite |
| --- | --- | --- |
| gbrain **0.60.249.0** installé ; le noyau **0.8.0** (branche locale `chore/gbrain-0.60.249` d'agent-kernel, non poussée) en relève l'épingle | `bootstrap-machine.sh --check` : « Machine prête ». Le projet reste épinglé en noyau 0.7.1 (`agent.yml`) tant que la 0.8.0 n'est pas mergée. | Merger le noyau 0.8.0, puis `/sync` dans A-I-D. |
| Migration de données gbrain v0.13.1 **partielle** (449 pages sur 1440 en `source_changed`, 15 migrations en attente) | Lecture OK, `write_through` à `false`. Rejouer la migration réécrit du frontmatter dans les dépôts sources : voir la note du noyau. | **À décider par Julien** avant de la rejouer. |
| Source gbrain `aid` absente | Les pages `aid/plan/…` n'ont nulle part où s'écrire. | `gbrain sources add` (fédérée ou isolée : à choisir), puis `.gbrain-source`. |
| codegraph 1.6.2, épinglé 1.6.0 | Simple avertissement. | Ne pas relancer tout `bootstrap-machine.sh` : il le redescendrait. |
| Pas d'index `.codegraph/` dans `a-i-d` | Les agents lisent directement (repli déclaré). | `codegraph init` quand le code existera (chantier 01). |

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
| Démon codegraph orphelin après la suppression du worktree | Un processus qui tourne pour rien, ou un worktree impossible à supprimer | Tuer le pid de `.codegraph/daemon.pid`, puis `codegraph uninit -f`, avant `git worktree remove` | 02.4 |
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

## 3. Ordre et branches

Branches empilées : chacune part de la précédente, et sa PR vise la branche parente.

| N° | Chantier | Branche | Base de la PR | Modèle exécutant |
| --- | --- | --- | --- | --- |
| 00 | [Amorçage du dépôt](00-amorcage.md) | `chore/amorcage` | `main` | standard |
| 01 | [Daemon : état, journal, sécurité](01-daemon-etat-securite.md) | `feat/daemon-socle` | `chore/amorcage` | standard |
| 02 | [Workspaces, sujets et worktrees](02-workspaces-sujets.md) | `feat/sujets-worktrees` | `feat/daemon-socle` | standard |
| 03 | [Terminaux persistants](03-terminaux-persistants.md) | `feat/terminaux` | `feat/sujets-worktrees` | **complexe** |
| 04 | [Interface v0.1](04-interface.md) | `feat/interface-socle` | `feat/terminaux` | standard |
| 05 | [CLI, distribution et recette](05-cli-distribution-recette.md) | `feat/cli-recette` | `feat/interface-socle` | standard |

On peut paralléliser une partie : 04 peut démarrer sur une API simulée dès que 01 est
livré, mais 04.4 (terminaux) attend 03.

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
