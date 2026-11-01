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
