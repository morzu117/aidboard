# Chantier 19 — Serveurs distants : suite de la review complète

Branche `feat/serveurs-suite`, base `main` (`10877fc`, chantiers 17 et 18 mergés). Ce chantier
traite les findings de la review complète du chantier 17 classés « à planifier (non bloquant) »
(`17-serveurs-distants.md`, journal). Les points « à trancher par l'opérateur » n'en font pas
partie, ni le masquage des secrets dans le texte libre, qui est un chantier séparé.

Index structurel : codegraph a rendu une erreur interne (`statInode`) à l'écriture du plan.
Le plan a été fait par lecture directe : aucun rayon d'impact n'a pu être établi par l'index.

## Pourquoi

La review a relevé deux familles de défauts.

1. **Le panneau Fichiers et Git présente une lecture dégradée comme complète.** Dans trois cas,
   l'opérateur voit « propre » ou un historique entier alors que la lecture n'a pas abouti :
   - un `git status` tué par son délai donne « 0 modifié » ;
   - un `git log` coupé n'est pas signalé `truncated` ;
   - des badges absents se lisent comme des fichiers propres.
2. **Le cycle de vie des agents distants a des angles morts.**
   - Un agent passé en `error` faute de lien n'est jamais rattaché, alors que son relais tourne
     encore sur le serveur.
   - Le critère de reprise (`hasTurn`) se trompe dans les deux sens.
   - Le réglage `confirmDestructive` est figé au lancement de l'agent.
   - Des erreurs sont avalées sans aucune trace.

## Décisions

Ces décisions ont été prises pour l'opérateur. Elles lui sont signalées.

| N° | Décision | Pourquoi |
|---|---|---|
| DS1 | Une lecture qui n'a pas abouti est dite **inconnue**, jamais déduite. `ServerGitRepo.changes` devient `number \| null` (`null` : `git status` en échec ou tué). Le journal porte `truncated: true` dès que `git log` ou la liste des commits hors HEAD n'a pas abouti. Le listing gagne `gitPartial: boolean` (badges incomplets). | La convention existe déjà (`aheadBehind: null` donne « position inconnue »). Un champ ajouté garde intact le contrat des lectures abouties. |
| DS2 | `dirty` vaut vrai quand `changes` est inconnu. | Le WIP affiché à tort se corrige d'un coup d'œil. Un « propre » à tort peut faire pousser ou synchroniser sur un état mal compris. |
| DS3 | La fin d'un agent faute de lien (`exit` sans code pendant une coupure, ou relance coupée avant le premier rattachement) n'est **pas** une fin. L'agent passe en `idle`, jamais en `error`. Il garde son relais et peut être rattaché. « Reconnecter » d'un claude tente d'abord le rattachement à l'offset. Il ne relance que si le relais est mort (`inconnu` ou `perdu`). | C'est le finding n° 3 : un agent qui consomme sans surveillance, et un « Reconnecter » qui tue le tour en cours. |
| DS4 | `hasTurn` : en cas d'échec rapide d'une relance (sortie non nulle avant tout événement de l'agent), on retente une fois avec le critère inverse : `--resume` ↔ `--session-id`. Si les deux échouent, on émet `resume_failed`, comme aujourd'hui. | Deux cas sont déjà vus en revue : un tour interrompu avant `turn_end` alors que la session existe, et `--resume` sur une session inexistante. Vérifier l'existence du fichier de session sur le serveur dépendrait du format interne de claude. |
| DS5 | `confirmDestructive` modifié : les agents vivants **ne sont pas relancés d'office**, ce qui couperait leur tour. Leur vue porte `staleConfirm: true` tant qu'ils tournent avec l'ancien réglage. La réponse du `PATCH` du serveur porte `staleAgents: n`. La relance (prochain message après une fin, ou « Reconnecter ») applique le nouveau réglage. | C'est le finding n° 6. L'opérateur voit l'écart et choisit le moment. |
| DS6 | Erreurs avalées : un `log` est injecté dans `RemoteAgentManagerDeps` (défaut : le journal du daemon). Chaque `catch` aujourd'hui muet écrit une ligne : contexte et message, avec les secrets d'URL retirés par `stripUserinfo`. Sur un `request` perdu dans `onEvent`, le tour est interrompu plutôt que laissé en `needs_input` sans carte. | C'est le finding n° 10 : aujourd'hui, aucun diagnostic n'est possible. |
| DS7 | Plafond de 2000 entrées : le shell liste d'abord les dossiers, puis le reste. Le plafond coupe donc les fichiers avant les dossiers, dans l'ordre d'affichage. | C'est la review F.1. Un dossier coupé du listing devient inatteignable depuis le panneau. |
| DS8 | Mots de secret : on ajoute `csv`, `bak`, `db`, `sqlite`, `log` aux extensions de données. La course `realpath` / lecture reste acceptée et documentée : même utilisateur, sans gain de privilège. | La course demande un accès en écriture au serveur, qui donne déjà tout. |

## Points

Un point = un commit. Après chaque point :
- `npm run gate` en entier ;
- `npm run gate:labo` quand le point touche au relais, au ssh ou aux scripts distants, ce qui demande Docker (`colima start`) ;
- une vérification par mutation : casser le correctif, voir le test échouer, puis restaurer.

- **S.1 `git status` en échec → modifiés inconnus.**
  - `st()` capte le code de sortie de `git status`. Un `awk` compte les lignes et lit un enregistrement final `rc<N>`. `ch` vaut alors un nombre, ou `x`.
  - `repoOf` rend `changes: null` pour `x`.
  - Le web affiche « modifiés : inconnu ».
  - `dirty` suit DS2.
  - Tests : un faux `git` du serveur (`avecGitDuServeur`) qui sort en 124 sur `status`, au milieu de sa sortie ; puis le test web de la stat.
- **S.2 Journal coupé → `truncated`.**
  - `git log` ou `rev-list` (hors HEAD) en échec ou tués donnent un enregistrement `logko`.
  - `parseGitLog` passe alors `truncated: true`.
  - Test : un faux `git` qui coupe `log` après quelques commits et sort en 124.
- **S.3 Badges incomplets.**
  - Le script `LIST` termine la section Git par un enregistrement `gitrc\t<code>`, toujours le dernier écrit.
  - Il manque (sortie coupée) ou il est non nul : `gitPartial: true`.
  - Le web affiche « badges Git incomplets » sous l'arbre.
  - Tests : un faux `git` qui sort en 124 sur `status` ; une sortie coupée par le transport.
- **S.4 Agent en `error` faute de lien.**
  - D'abord, un scénario du labo qui reproduit le problème :
    - le serveur est coupé au démarrage du daemon puis rétabli ;
    - la session est perdue, puis le serveur est injoignable pendant la relance.
  - Ensuite, DS3 :
    - côté `RemoteChild`, une relance qui a perdu le lien avant son premier rattachement ne se traite plus comme un échec de lancement ;
    - côté `agents.ts`, une fin faute de lien donne `idle` ;
    - « Reconnecter » d'un claude tente d'abord le rattachement à l'offset.
  - Tests unitaires (faux ssh, `FAKE_SSH_FAIL`) et labo.
- **S.5 Critère de reprise.** DS4, dans `RemoteDriver`. Tests : une session existante sans `turn_end` ; `--resume` sur une session inconnue. Le faux claude refuse selon le cas.
- **S.6 `confirmDestructive` changé en cours de route.** DS5 : `staleConfirm` dans `ServerAgentView`, `staleAgents` dans la réponse du `PATCH`, un bandeau dans la discussion. Tests daemon et web.
- **S.7 Erreurs tracées.** DS6. Tests :
  - un `record` en échec écrit une ligne de journal sans secret ;
  - un `request` perdu interrompt le tour.
- **S.8 Plafond et mots de secret.** DS7 et DS8. Tests : un dossier de plus de 2000 fichiers et quelques sous-dossiers, où les dossiers restent listés ; les noms `secrets.csv`, `password.bak`, `credentials.db`.

## Journal

- **S.1 `git status` en échec → modifiés inconnus** :
  - `st()` lit le code de sortie de `git status` (enregistrement `rc<N>` après la sortie, compté par `awk`).
  - Un `git status` tué ou en échec donne `ch=x`, puis `changes: null`, puis « modifiés : inconnu » dans le
    panneau, et `dirty` vrai (DS2).
  - Tests :
    - faux `git` du serveur qui écrit une sortie partielle puis sort en 124 ;
    - compte exact d'un statut abouti, propre compris, avec un fichier sans fin de ligne ;
    - test web de la stat.
  - Mutation vérifiée : le compte rendu sans le code de sortie fait échouer le test.
  - Lignes existantes modifiées, toutes déclarées :
    - le calcul de `ch` ;
    - `changes` dans `repoOf` ;
    - `dirty` dans `parseGitLog` ;
    - le type `changes` et sa doc dans `shared/git.ts` ;
    - la stat du panneau.
  - Gate vert (1249 passés). `gate:labo` vert (16/16) : `changes: 4` inchangé sur le vrai git.
  - codegraph est indisponible (erreur interne `statInode`) : lecture directe.
- **S.2 Journal coupé → `truncated`** :
  - Un `git log` en échec ou tué écrit un enregistrement `logko` après sa sortie. Une liste hors HEAD
    (`rev-list`) dans le même cas l'écrit aussi.
  - `parseGitLog` écarte alors l'enregistrement à moitié écrit qui précède la marque et passe `truncated: true`.
  - Tests :
    - `git log` coupé à 150 octets puis sorti en 124, sur les deux portées : tronqué, moins de 3 commits,
      chacun complet (hash de 40 caractères, date valide) ;
    - `rev-list --not HEAD` en échec : tronqué, journal de HEAD intact.
  - Deux mutations vérifiées :
    - sans `partial`, les deux tests échouent ;
    - l'enregistrement partiel gardé fait échouer le premier.
  - Lignes existantes modifiées : les trois commandes du script `LOG`, la construction de `raw` et `truncated`.
  - Gate vert (1251). `gate:labo` vert (16/16).
- **S.3 Badges incomplets** :
  - Le script `LIST` termine la section Git par `gitrc\t<code>`, toujours le dernier enregistrement.
  - `parseListing` passe `gitPartial: true` dans deux cas :
    - l'enregistrement manque (sortie coupée par le transport) ;
    - il est non nul (`git status` tué ou en échec).
  - Les badges reçus avant la coupure restent montrés.
  - Le panneau dit « Badges Git incomplets… » sous l'arbre du dossier concerné.
  - Tests :
    - git abouti ;
    - faux `git` qui sort en 124 sur `status` ;
    - enregistrements forgés : coupés, entiers, hors dépôt ;
    - test web (dit, puis absent) ;
    - labo : `gitPartial: false` sur le vrai git.
  - Mutation vérifiée : `gitPartial` toujours faux fait échouer deux tests.
  - Ligne existante modifiée : l'appel de `badges` dans `parseListing`. Le reste est inséré.
  - Gate vert (1255). `gate:labo` vert (16/16, puis `fichiers.labo.ts` seul après l'assertion ajoutée).
- **S.4 Agent en `error` faute de lien** :
  - **Ce qui était réel, ce qui ne l'était pas.** Le scénario de la review « daemon démarré serveur éteint »
    ne mène pas à `error`. Le rattachement au démarrage part d'un offset, il est donc tenu pour `started`
    et retenté sans fin. Ce scénario devient un test de non-régression (faux ssh et labo).
  - Le défaut réel : une **reprise après session perdue** (`replaceLost`) que le lien interrompt avant
    son premier rattachement. Elle était traitée comme un échec de lancement, d'où `resume_failed`, `exit`
    et `error`.
  - Correctif dans `RemoteChild` : cette reprise est retentée, avec l'état du relais relu à chaque tentative.
    Elle ne finit que sur un refus du serveur lui-même : code de `start` non nul, ni 255, ni délai.
  - « Reconnecter » d'un claude dont l'agent tourne encore (`alive` = `vivant`) le rattache à son offset,
    comme au démarrage, au lieu de le relancer (ce qui tuait le tour en cours). Sinon, la relance garde la main.
  - Non fait, et dit : un `error` resté en base n'est pas rattaché d'office au démarrage. Il faudrait un
    aller-retour ssh par agent fini, à chaque démarrage. « Reconnecter » le fait à la demande.
  - Tests :
    - pilote : reprise coupée par le lien (retentée, jamais de `exit`), reprise refusée par tmux (une fin,
      jamais retentée) ;
    - daemon : redémarrage serveur éteint ; Reconnecter rattaché (même pid, rien de rejoué) ; Reconnecter
      relancé (agent arrêté) ;
    - labo : redémarrage avec le vrai sshd coupé.
  - Quatre mutations vérifiées, chacune fait échouer son test :
    - reprise jamais retentée ;
    - refus jamais posé (le test boucle et expire) ;
    - rattachement au démarrage traité comme un lancement ;
    - `reattach` toujours faux.
  - Ligne existante modifiée : l'import de `relay.js` dans `agents.ts`.
  - Gate vert (1260). `gate:labo` vert (17/17).
- **S.5 Critère de reprise** :
  - Une relance de claude (`relaunch` sans critère imposé) garde `retry` : son critère `hasTurn` et les messages
    envoyés depuis.
  - Si l'agent finit en échec avant d'avoir rien dit, sa fin n'entre pas au fil. Il est relancé une fois avec le
    critère inverse (`--resume` ↔ `--session-id`) et ses messages sont renvoyés.
  - Un second refus est une fin ordinaire (`error`), sans nouvelle tentative.
  - Faux claude : mode `FAKE_CLAUDE_STRICT`, comme le vrai claude. La session existe dès le premier message ;
    `--session-id` d'une session existante et `--resume` d'une inconnue sont refusés. `FAKE_CLAUDE_REFUSE`
    refuse tout démarrage.
  - Tests :
    - premier tour mort avant sa fin, d'où une reprise en `--resume` ;
    - sessions effacées sur le serveur malgré un tour fini, d'où une session neuve ;
    - refus dans les deux sens : une seule nouvelle tentative, deux fins au fil.
  - Deux mutations vérifiées :
    - sans nouvelle tentative, les deux premiers tests échouent ;
    - avec des tentatives sans fin, le troisième échoue.
  - Lignes existantes modifiées : la signature de `relaunch` et son `return this.mount(…)`.
  - Gate vert (1263).
  - `gate:labo` : un premier passage rouge, 3 tests en échec dont 1 en 399 s, tous sur une perte de lien avec le
    conteneur. Parmi eux, `relais.labo.ts` (zsh, ssh en 255), qu'aucune ligne de S.5 ne touche. Puis trois
    passages verts de suite (17/17, 22 s). Instabilité de l'environnement (colima), non reproduite.
