# Chantier 65 : un agent borné à son worktree (bubblewrap)

| Champ | Valeur |
|---|---|
| État | **Révision 0, 24 novembre 2026.** Risque 2 des zones d'ombre de la note d'idéation de Julien du 17 novembre (§14). Arbitrage de Julien du 24 novembre : un bac à sable OS, bubblewrap sous Linux et WSL ; le réseau et les credentials de l'agent lui sont laissés. |
| Emplacement final | `docs/chantiers/65-isolation-agents.md` sur `main` |
| Base | `main` |
| Organisation | Comme au 63 : cell-gestion gère le chantier, Codex CLI écrit le code et les tests, cell-gestion relit, lance le gate, commite et ouvre la PR. |
| Validation | Le gate est vert à chaque point, puis `gate:e2e`. Pas de recette manuelle : le vrai bwrap tourne en CI (65.5). Le merge se fait sur le oui de Julien, CI verte. |

## 1. Pourquoi

Dans A-I-D, un agent est une vraie session Claude Code ou Codex, lancée dans le home de Julien avec ses outils et ses abonnements. « Les écritures sont bornées au worktree » : c'est dit, pas imposé.

La note pose cette isolation comme préalable à deux choses : la boucle dans le daemon, et le merge automatique. « Avec un merge automatique, le pire scénario est un agent qui modifie autre chose que son worktree. »

Swairm avait des drones avec un HOME jetable et zéro credential. A-I-D ne peut pas le reprendre tel quel : ses agents ont besoin de leurs abonnements. Ce chantier borne donc les **écritures**, et cache les secrets dont l'agent n'a pas besoin.

## 2. Cible et hors-périmètre

**Cible.**
- Avec `agents.isolation: bwrap`, tout agent `claude` ou `codex` lancé par le daemon, en `stream` comme en `pty`, tourne dans bubblewrap :
  - le système de fichiers est lisible, et inscriptible seulement là où il le faut ;
  - les secrets d'A-I-D et ceux qui servent à pousser sont invisibles.
- La configuration qui s'exécute plus tard hors du bac à sable reste en lecture seule : les hooks git, la configuration git, les réglages de Claude Code. Sinon, une écriture dans le bac à sable deviendrait une exécution hors de lui.
- Le gate de la boucle et les commandes de preuve d’acceptation tournent dans le même type de bac, avec le profil du sujet et leur TMPDIR monté en écriture.

**Hors-périmètre.**
- Le réseau reste ouvert, y compris les sockets Unix abstraites de l’hôte. L'agent garde l'accès à son fournisseur et au daemon, en `127.0.0.1`.
- macOS. Il n'y a pas d'équivalent maintenu de bubblewrap, et `isolation: bwrap` y est refusé au démarrage, avec un message.
- `shell`, `swarph-cell` et `swairm-cell`. Ce sont des sessions de l'humain ou des cells du maillage, pas des agents de sujet. Elles restent hors du bac à sable, et l'écran le dit.
- Les bacs à sable propres aux agents (`codex --sandbox`, celui de Claude Code). Ils restent utilisables en plus du nôtre. Ce chantier ne s'appuie pas sur eux : il veut une règle commune aux deux.

## 3. Décisions

### DM42. Le profil d'écriture

L'agent voit `/` en lecture seule (`--ro-bind / /`), avec `--dev /dev` et `--proc /proc`. Il peut écrire :

| Où | Pourquoi |
|---|---|
| le worktree du sujet | son travail |
| le répertoire git commun du dépôt (`git rev-parse --git-common-dir`) | un commit dans un worktree écrit les objets et les refs dans le `.git` du dépôt principal |
| `AID_SPOOL` et `attachments/<agent>` | les événements et les pièces jointes |
| un `/tmp` propre à l'agent (`--tmpfs /tmp`) | les fichiers temporaires |
| `~/.claude`, `~/.claude.json`, `~/.codex` | l'état de session, et le rafraîchissement du jeton d'abonnement |
| les caches de paquets (`~/.npm`, `~/.cache`) | `npm install` et ses pareils |

### DM43. Ce qui reste en lecture seule à l'intérieur des zones inscriptibles

Une écriture dans ces fichiers s'exécuterait plus tard, hors du bac à sable. Ils sont donc remontés en lecture seule par-dessus :
- **dans le `.git` commun** :
  - `config` et `hooks/` ;
  - `refs/heads/main` et `packed-refs`.

  Un agent ne peut ni déplacer `main` ni ajouter un hook. Un `git pack-refs` ou une suppression de branche échoue dans le bac à sable : c'est accepté et documenté.
- **`~/.claude` et `~/.codex`** sont montés intégralement en lecture seule. Les fichiers d'authentification et les répertoires de sessions sont remontés en écriture s'ils existent. Claude peut écrire dans le seul dossier de transcriptions de son worktree, sous `~/.claude/projects/`, avec `memory/` remonté en lecture seule. Le lanceur crée ce dossier et le point de montage `memory/` s'ils manquent. Les dossiers de travail `todos`, `shell-snapshots`, `statsig`, `debug` et `session-env` sont recouverts par un tmpfs s'ils existent.
- **Le dossier `.claude/` et le fichier `.mcp.json` à la racine du worktree** sont remontés en lecture seule. Le lanceur crée les points manquants vides. Après la sortie du dernier agent qui les utilise, il retire ceux qu'il a créés s'ils sont toujours vides. Un agent qui doit légitimement modifier ces chemins travaille sans isolation.
- **`~/.claude.json`** est monté depuis une copie temporaire propre au lancement. Les écritures sur la copie sont perdues à la fin de la session.

En dehors de ces points de montage, les fichiers absents sont ignorés.

**Le risque qui reste.** Le rafraîchissement réel des jetons d'abonnement et la reprise de sessions réelles restent à vérifier. L'isolation bwrap reste expérimentale. Un agent isolé peut lire et remplacer le jeton d'abonnement. Le réseau reste ouvert. Les fichiers `CLAUDE.md` et `AGENTS.md` à la racine du worktree restent inscriptibles. La session suivante lit ces consignes et leurs modifications sont visibles dans le diff.

### DM44. Ce qui est caché

Ces chemins sont recouverts par un `--tmpfs` vide quand ce sont des dossiers. Un fichier est recouvert par un fichier vide :
- **A-I-D** : tout `AID_HOME` (`state.db`, `session.secret`, `config.yaml`, les journaux et les autres worktrees), sauf le spool et le dossier de pièces jointes de l'agent, remontés par-dessus ;
- **les identités qui servent à pousser** : `~/.ssh`, `~/.gnupg`, `~/.config/gh` et `~/.git-credentials`.

  C'est la règle des trois acteurs (§11 de la note, et swarph) : l'orchestrateur seul pousse. Un agent de sujet commite, il ne pousse pas, et il n'ouvre pas de PR ;
- **les autres dépôts du home** : pas dans ce chantier. Ils restent lisibles, et la fiche le dit.

L'agent parle au daemon par `AID_URL` et son jeton de run, comme aujourd'hui. Il n'a pas besoin de la base.

### DM45. Le lanceur

- `src/daemon/isolation/bwrap.ts` construit l'argv de bwrap à partir d'un `ProfilIsolation` (le worktree, le git commun, le home, les chemins d'A-I-D et l'agent). C'est une fonction pure, testée sans lancer bwrap.
- Le mode `stream` passe par le `spawnChild` existant (D75) : le lanceur isolé préfixe `bwrap <args> --` à la commande.
- Le mode `pty` préfixe de la même façon l'appel à `getPty().spawn`.
- Les options de bwrap :
  - `--die-with-parent` et `--new-session`. En PTY, sans `--new-session`, puisque le terminal doit rester attaché : le point 65.3 le vérifie ;
  - `--unshare-pid` ;
  - pas de `--unshare-net`.
- Au démarrage du daemon, avec `isolation: bwrap`, `bwrap` doit être dans le PATH et passer une sonde (`bwrap --ro-bind / / true`). Sinon, le daemon refuse de démarrer, avec le message « isolation demandée mais bubblewrap indisponible : … ». Il ne retombe jamais en silence sur un lancement non isolé.
- `agents.isolation` vaut `off` par défaut dans ce chantier. Le passage à `bwrap` par défaut sera décidé plus tard : la CI ne vérifie pas le jeton d'abonnement d'un vrai compte (65.5).

### DM46. Ce que l'agent et l'humain voient

- `aid doctor` montre une ligne « Isolation : bwrap (version) » ou « Isolation : off ».
- La carte de l'agent dans la vue du sujet porte une petite marque « isolé » ou « non isolé ».
- Le bloc rendu du noyau dit que, sous isolation, un `git push`, un `gh` ou une écriture hors du worktree échouent normalement, et qu'il ne faut pas les contourner.

### DM68. Les quatre sorties relevées par le lab (26 novembre)

Le lab a relu le 65.5 et relancé à sa tête quatre sorties qu'il avait mesurées le 25, avec un vrai bwrap. Les quatre tiennent :
- **C. Les pointeurs git.** Le fichier `.git` du worktree, puis le `commondir` de `.git/worktrees/<nom>/`, peuvent être réécrits de l'intérieur vers un dépôt qui déclare `core.fsmonitor`. Le git du daemon, lancé hors du bac à sable (par exemple par `GET /api/topics/:id/git/log`), exécute alors le moniteur dehors.
- **D. Le bus de l'utilisateur.** `systemd-run --user`, par `/run/user/<uid>/bus`, lance un service hors du bac à sable, en stream comme en PTY.
- **E. L'environnement.** Les variables du daemon passent à l'agent : jetons (`GH_TOKEN`, clés de cloud), `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS` et `XDG_RUNTIME_DIR`.
- **F. La configuration de Claude.** Une écriture de `~/.claude/settings.json` ou de `~/.claude.json` faite de l'intérieur reste dehors. C'est le cas d'un fichier absent, que DM43 ne monte pas, et de `~/.claude.json`, laissé inscriptible.

Les corrections :
- **C.**
  - Le fichier `.git` du worktree et les fichiers `commondir` et `gitdir` de son dossier dans `.git/worktrees/` sont remontés en lecture seule.
  - Tout git que le daemon lance sur un worktree de sujet passe `-c core.fsmonitor=false` et `-c core.hooksPath=/dev/null`, par l'aide git commune du daemon, et vérifie que le dossier git résolu est bien celui du dépôt du sujet.
- **D.**
  - `--tmpfs /run`, puis seulement ce qui sert à la résolution de noms (la cible de `/etc/resolv.conf` si elle est sous `/run`).
  - `/run/user` reste invisible.
  - Pas de `--unshare-net` : les agents ont besoin du réseau.
- **E.** Une liste blanche d'environnement, sur le modèle de #211 : `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, les `LC_*`, `TZ`, `TMPDIR`, les variables d'A-I-D dont l'agent a besoin (`AID_URL`, son jeton de run, `AID_SPOOL`), et les variables propres à `claude` et `codex` qui ne portent pas de secret de tiers. Tout le reste est retiré, à commencer par les jetons, les sockets d'agent et le bus.
- **F.**
  - `~/.claude` et `~/.codex` passent en lecture seule entière. Seul l'état de session que les CLI écrivent y est remonté en écriture : le fichier du jeton d'abonnement, les transcriptions et les dossiers de travail des sessions.
  - Dans le home, les chemins de réglages, mémoire, commandes, agents, skills, plugins, hooks et MCP restent en lecture seule.
  - `~/.claude.json` est remplacé, pour la session, par une copie temporaire. Ce qui s'y écrit est perdu à la fin de la session.
  - **Configuration du projet.** Un essai avec Claude Code 2.x dans un dépôt temporaire a confirmé que `--setting-sources user` exclut le `CLAUDE.md` du projet et que `user,project` le charge. Le lanceur laisse les sources de réglages de Claude intactes et ajoute uniquement `--strict-mcp-config` pour écarter `.mcp.json`. Les montages en lecture seule de `.claude/` et `.mcp.json` à la racine protègent les réglages Claude et la configuration MCP, même si les chemins sont absents au départ. Les `.claude/` et `.mcp.json` imbriqués ainsi que `.github/` restent modifiables. Ces chemins relèvent du relevé de fin d'étape de la boucle au chantier 69. Les fichiers `CLAUDE.md` et `AGENTS.md` à la racine restent accessibles en écriture et leurs modifications apparaissent dans le diff.

Chaque sortie devient un test négatif dans le job `isolation`. Comme le bus utilisateur n'existe sans doute pas sur un runner GitHub, le test de D vérifie directement que `/run/user` est invisible de l'intérieur, sans compter sur l'échec de `systemd-run`. En attendant ces corrections, `aid doctor` et la doc disent que `bwrap` n'est pas encore une frontière de sécurité.

### DM73. La boucle sous isolation (27 novembre)

La #210 reprend main, et donc la boucle du chantier 69. Le lab a donné son oui de sécurité pour C à F à f0abcc0 (DM 107562). Il a fait trois suggestions et relevé un trou propre à la boucle (DM 107566).

- **Les agents de la boucle sont isolés comme les autres.** Ils passent par `agents.spawn` et `isolationPour`, sans exception de rôle. Sous isolation, le groupe consigné par la boucle est celui du moniteur bwrap. Arrêter la boucle doit tuer l'agent et tous ses descendants dans le bac.
- **Le remplacement de `.git`.** Un `mv`, ou un `rm` suivi d'une recréation du fichier `.git` du worktree ou du `commondir`, échoue de l'intérieur, comme l'ajout à la fin.
- **Un témoin pour `/run/user`.** Le test vérifie qu'il existe dehors avant de vérifier qu'il est vide dedans. S'il n'existe pas sur le runner, le test le crée pour le témoin ou échoue clairement, au lieu de passer sans rien prouver.
- **Le réseau n'est pas isolé.** `aid doctor` et la doc le disent : pas de `--unshare-net`, donc les sockets Unix abstraites de l'hôte restent joignables depuis le bac.

### DM74. Le gate dans le bac (27 novembre)

Le gate de la boucle lance `/bin/sh` dans le daemon, hors du bac, sur du code écrit par l'agent : tests, build, script de gate. Un agent isolé pourrait donc sortir en écrivant un script que le gate exécutera. Julien a tranché (27 novembre) : le gate entre dans le bac, dans la #210.

- **Sous `agents.isolation: bwrap`, tout ce que la boucle exécute sur le code du worktree tourne sous bwrap.** C'est le gate (`boucle/gate.ts`), mais aussi les preuves d'acceptation (`acceptation/preuve.ts`). Le profil est celui de l'agent du sujet (`profilPour`, `envelopper`) : le worktree en écriture et le reste en lecture seule. L'environnement passe par la liste blanche de la boucle, puis par celle du bac. Le dossier temporaire du gate est le seul ajout en écriture.
- **On ne retombe jamais en silence.** Si l'isolation est demandée mais que bwrap manque, le gate n'est pas lancé, et la boucle escalade avec un message clair.
- **Les groupes de processus marchent toujours.** Le délai et l'arrêt de la boucle tuent tout le gate dans le bac.
- **Sans isolation, rien ne change**, sur macOS par exemple. La limite reste écrite dans `limites-boucle.ts`, et elle dit maintenant que l'isolation couvre aussi le gate.
- Les sorties C à F, refaites depuis un script lancé par le gate, échouent comme depuis l'agent, sous le vrai bwrap, dans le job `isolation`.

### DM75. Les remarques non bloquantes du lab (28 novembre)

Le lab a donné son oui pour la #210 à 7a1fd95 (DM 107579). Elle est mergée sur le oui de Julien. Ses trois remarques passent dans une PR de suite.

- **Le gate et les preuves ne voient pas les identifiants des agents.** Pour ces commandes, `~/.claude/.credentials.json`, `~/.claude.json` et `~/.codex/auth.json` sont masqués par `/dev/null`, comme `.git-credentials`. L'agent garde son accès, il en a besoin. Le profil du gate est donc dérivé de celui du sujet, sans ces fichiers.
- **Le test de remplacement couvre aussi `gitdir`**, en plus de `.git` et de `commondir`.
- **Le script du gate tente C à F à la lettre.** Il essaie aussi de réécrire les pointeurs git et de joindre `/run/user`, avec un témoin dehors pour chaque sortie.

## 4. Points

### 65.1 Le plan

Ce document, et une ligne dans `docs/chantiers/README.md`.

### 65.2 Le profil et l'argv (DM42 à DM44)

`src/daemon/isolation/bwrap.ts` et `agents.isolation` dans la configuration.

Les tests portent sur l'argv seul :
- l'ordre des montages : le plus général d'abord, les recouvrements ensuite ;
- les chemins absents ignorés ;
- le git commun déduit, puis donné ;
- `AID_HOME` caché et ses deux exceptions ;
- les identités de poussée cachées.

- _Révision 65.2._ Fait :
  - `agents.isolation: off | bwrap`, à `off` par défaut ;
  - `src/daemon/isolation/bwrap.ts`, avec `argvBwrap` pur et `gitCommunDe` sans repli. L'ordre est le suivant : la base, les zones cachées, les zones inscriptibles, puis les recouvrements en lecture seule ;
  - un worktree sous `AID_HOME` est remonté après le tmpfs ;
  - un chemin absent n'est jamais monté.

  Gate 4 695.

### 65.3 Le lancement (DM45)

- Le branchement en `stream` et en `pty`.
- La sonde au démarrage et le refus explicite.
- macOS refusé.

Les tests utilisent un faux `bwrap`, qui écrit son argv et lance la commande. Un test d'intégration, sauté si `bwrap` est absent, lance un vrai `bwrap` sur un `sh` et vérifie quatre choses :
- une écriture dans le worktree passe ;
- une écriture dans le home échoue ;
- `.git/hooks` est en lecture seule ;
- `~/.ssh` est vide.

- _Révision 65.3._ Fait :
  - `lanceur.ts` : `profilPour`, `envelopper` et `spawnChildIsole` ;
  - dans `manager.ts`, les `claude` et `codex` locaux sont enveloppés, en PTY comme en stream. Un profil impossible renvoie une 422 sans lancement, et la commande enregistrée reste celle de l'agent ;
  - `isole` sur l'agent ;
  - la sonde au démarrage (`sonde.ts`) : refus hors Linux, sans bwrap, ou sur une sonde en échec ;
  - `bwrapVersion` dans `/api/state`.

  14 tests. Le test d'intégration est sauté sur le VPS, faute de bwrap : il est à lancer sur la tour. Gate 4 709.

### 65.4 La visibilité, le noyau et la fiche (DM46)

- La ligne d'`aid doctor`, la marque sur la carte, la phrase du noyau et le changelog.
- La fiche `docs/recette-chantier-65-isolation-agents.md`, sur la tour : installer bubblewrap, passer `isolation: bwrap`, lancer un `claude` puis un `codex` dans un sujet. Elle vérifie :
  - un commit passe ;
  - un `git push` échoue ;
  - l'écriture d'un fichier dans le home échoue ;
  - un hook git ne peut pas être ajouté ;
  - le jeton d'abonnement se rafraîchit, la session survit au lendemain ;
  - la reprise fonctionne.

- _Révision 65.4._ Fait :
  - la ligne « Isolation » d'`aid doctor` (`bwrapVersion` vaut `off` quand l'isolation est éteinte) ;
  - la marque « isolé » sur l'onglet de l'agent ;
  - « Sous isolation » dans `kernel/policy/orchestration.md`, et le changelog ;
  - la fiche, avec neuf contrôles et les risques connus.

  Gate 4 713 au second passage. Au premier, `appareil.test.tsx` (D176) a dépassé son délai de 5 s sous charge ; il passe trois fois sur trois en isolé.

### 65.5 Le vrai bwrap en CI, à la place de la recette

Julien ne fait plus de recette manuelle (26 novembre) : « les tests front, back et les tests e2e et scénarisés d'interface doivent le couvrir ». La fiche de la tour est remplacée par un job de CI, `isolation`, sur un runner Ubuntu qui installe bubblewrap. Dans ce job, `AID_BWRAP_REQUIS=1` fait échouer le test d'intégration si `bwrap` manque, au lieu de le sauter. Ailleurs, le test reste sauté.

Le test d'intégration couvre ce que vérifiait la fiche :
- une écriture dans le worktree passe, et un commit aussi ;
- une écriture dans le home échoue, `~/.ssh` est vide, et les secrets d'A-I-D sont invisibles ;
- `.git/hooks` et `.git/config` sont en lecture seule, et l'ajout d'un hook échoue ;
- un `git push` vers un dépôt nu hors du worktree échoue.

Un second cas lance un faux `claude` et un faux `codex` par le vrai lanceur (`spawnChildIsole`), en stream et en PTY, sous le vrai bwrap, puis vérifie les mêmes bornes.

Ce que la CI ne peut pas vérifier, faute de vrai compte : le rafraîchissement du jeton d'abonnement, la session qui survit au lendemain, et la reprise d'une vraie session. `agents.isolation` reste donc à `off` par défaut, et ces trois points restent les limites connues du chantier. La fiche `docs/recette-chantier-65-isolation-agents.md` est retirée.
- _Révision 65.5._ Une passe Codex. Quatre lignes existantes remplacées dans le test d'intégration, la fiche de 53 lignes retirée. Le bac à sable n'a pas bwrap : les cas réels sont joués par le job `isolation` de la CI de la PR. Sans bwrap, les tests sont sautés ; avec `AID_BWRAP_REQUIS=1`, ils échouent sur un message clair. Mon gate : 4 712, et un seul échec, `noms-neutres`, qui lisait encore la fiche supprimée dans l'index avant le commit.

### 65.6 Les quatre sorties fermées (DM68)

- C, D, E et F, chacune avec son test négatif sous le vrai bwrap, dans le job `isolation`.
- Le test de C passe aussi par le daemon : un worktree dont le pointeur git vise un dépôt à `core.fsmonitor`, puis `GET /api/topics/:id/git/log`. Le témoin du moniteur ne doit pas apparaître.
- Le test de F écrit, de l'intérieur, `~/.claude/settings.json`, `~/.claude/settings.local.json` (absent au départ), `~/.claude.json` et `~/.codex/config.toml`. Après la session, aucun ne doit avoir changé dehors, alors que le fichier du jeton reste inscriptible.
- Le test de E injecte de fausses variables à secret (des valeurs factices, assemblées à l'exécution) et vérifie que l'environnement intérieur se limite à la liste blanche.
- `aid doctor` dit « expérimental » à côté de `bwrap` tant que le passage par défaut n'est pas décidé.
- _Révision 65.6._ Une passe Codex et quatre reprises :
  1. la mémoire de Claude, codex et sa config, le jeton, la config de projet (lab, DM 106264 et 106267) ;
  2. le retrait de `--setting-sources user`, que j'ai vérifié avec le vrai `claude` dans un dépôt témoin : avec `user`, le `CLAUDE.md` du projet n'est pas chargé ; avec `user,project`, il l'est. À la place, `.claude/` est monté en lecture seule ;
  3. `.mcp.json` en lecture seule, et le nettoyage des points de montage créés (lab, DM 106271) ;
  4. un seul dossier de projet de Claude en écriture, au lieu d'un montage par transcription, qui donnait un argv sans borne.

  Soixante-dix lignes existantes remplacées ou retirées, toutes dans le périmètre du chantier. Les cas sous vrai bwrap sont joués par le job `isolation` de la CI ; le lab relance son harnais à cette tête. Mon gate : 4 914.

### 65.7 Reprendre main

La fusion de main, avec la boucle du 69. Les quatre conflits ont été résolus par Codex, en gardant les deux côtés. Les agents de boucle passent par `isolationPour`.
- _Révision 65.7._ Une passe Codex. Neuf lignes existantes remplacées dans `pty/manager.ts`. Mon gate : 5 407. Les e2e de la boucle et de la livraison passent, 14/14.

### 65.8 La boucle isolée et les suggestions du lab (DM73)

- Sous le vrai bwrap : un agent de boucle est lancé isolé, et l'arrêt de la boucle tue ses descendants.
- `.git` et `commondir` ne peuvent pas être remplacés.
- `/run/user` a son témoin dehors.
- `aid doctor` et la doc disent que le réseau n'est pas isolé.

- _Acceptation._ Couvert par `test/isolation-acceptation-65-8.test.ts` (0a8764d), écrit par le testeur depuis DM73 seul. Le cas se joue sous le vrai bwrap, dans le job `isolation`. Le faux codex de l'étape dev reste isolé, et son home témoin est intact. Le PID consigné est celui du moniteur, et le petit-fils cesse d'écrire après l'arrêt du groupe. `mv`, ou `rm` puis la recréation de `.git` et de `commondir`, échouent : le contenu et l'inode restent identiques dehors. `/run/user` est vide dedans, avec un témoin dehors. Doctor dit que le réseau reste ouvert, sockets Unix abstraites comprises.

### 65.9 Le gate dans le bac (DM74)

- Sous isolation, le gate et les preuves tournent sous bwrap, avec le profil du sujet.
- Si bwrap manque, la boucle escalade et le gate ne se lance pas.
- Le délai et l'arrêt tuent tout le groupe.
- C à F, refaits depuis un script du gate, échouent sous le vrai bwrap.

- _Acceptation._ Couvert par `test/isolation-acceptation-65-9.test.ts` et `test/isolation-acceptation-boucle.test.ts` (0a8764d), écrits depuis DM74 seul. Sous le vrai bwrap, le gate écrit puis exécute un script qui tente C à F : les écritures dans le home, dans les hooks git et dans `settings.json` échouent, et la variable factice est absente. L'écriture dans le worktree et dans le TMPDIR passe. Même chose pour les preuves. Le délai et l'arrêt figent le témoin petit-fils. Sans bwrap, la boucle escalade et le témoin de commande reste absent. En `off`, l'argv est l'argv habituel. La limite affichée dit que bwrap couvre le gate. Interface : `lancerGate({ …, isolation?: { bwrapBin, profil } })` et la même option pour `produirePreuves`.
- _Révision 65.8 et 65.9._ Une passe Codex. Trente-huit lignes existantes remplacées, toutes dans le périmètre. Le testeur a ajouté une origine fictive au dépôt témoin des preuves (6300bbd). Mon gate : 5 412, et les 14 e2e de la boucle et de la livraison passent. Les cas sous le vrai bwrap sont joués par le job `isolation` de la CI.

### 65.10 Les remarques du lab (DM75)

Les trois règles de DM75, chacune avec son test sous le vrai bwrap, dans le job `isolation`. Le testeur écrit d'abord les tests à partir de DM75 seul.

## 5. Pièges

- **Ne jamais retomber en silence.** Un daemon réglé en `bwrap` qui lancerait un agent non isolé parce que bwrap manque est pire qu'un daemon en `off` : on croit être protégé.
- **L'ordre des montages compte** dans bwrap. Un recouvrement placé avant son parent est écrasé.
- **Le `.git` commun est la vraie surface.** Ce qui s'y exécute plus tard (`hooks/`, `config` et son `core.hooksPath`, `core.fsmonitor`) doit rester en lecture seule. Sinon, l'isolation se contourne au prochain `git status` de Julien.
- **`--new-session` et le PTY.** `--new-session` détache l'agent du terminal de contrôle : à vérifier en PTY avant de le garder.

## 6. Fini quand

- Avec `agents.isolation: bwrap` sur la tour, un agent de sujet peut lire tout le système et travailler dans son worktree. Il ne peut ni écrire ailleurs, ni pousser, ni lire les secrets d'A-I-D.
- Le daemon refuse de démarrer si l'isolation est demandée et indisponible.
- La boucle dans le daemon et le merge automatique peuvent s'appuyer sur cette garantie, y compris pour le gate et les preuves que la boucle lance (DM74).
