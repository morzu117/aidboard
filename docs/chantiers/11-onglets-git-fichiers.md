# 11 — Page Sujet : onglets Agents / Git / Fichiers (écrans 3.1 à 3.6)

## Index structurel : indisponible cette session

`index_status` a répondu « index indisponible : lecture directe » (serveur MCP `aid`), et
le MCP tiers `codegraph` (toléré en transition) n'a pas pu se connecter non plus. Tout le
rayon d'impact ci-dessous vient d'une lecture directe (`grep`/`Read` du code), **pas** d'un
`index_impact` déclaré. L'exécutant qui ouvre ce plan avec l'index de nouveau disponible
doit le requêter lui-même avant le premier point, pas se fier à cette section.

## Pourquoi

L'export `design/aid-export-git-flow/` (écrans 3.1 à 3.6, importé par ce chantier) montre
la page Sujet actuelle (`web/src/ecrans/Sujet.tsx`) réorganisée en trois onglets — Agents,
Git, Fichiers — là où elle n'affiche aujourd'hui qu'une seule vue (les terminaux d'agent).
Git et Fichiers n'existent pas : aucun graphe de commits, aucun sélecteur de branche,
aucun explorateur de worktree, aucune visionneuse Markdown. Ce chantier construit les
trois onglets, le sélecteur de branche et le bandeau de dérive (3.6), sans toucher à ce
que le chantier 07 (git flow : draft → sync → PR → fusion → archive) a déjà livré.

## État actuel

- `Sujet.tsx:420-494` affiche directement les terminaux d'agent (onglets par agent, pas de
  notion d'« onglet de contenu »). Aucune barre `onglets.agents|fichiers|git` n'existe :
  les data-node `1-3.onglets.*` de l'export n'ont pas d'équivalent dans le code.
- `src/daemon/git/inspect.ts:68-97` sait déjà lire `currentBranch`, et `gitLiveInfo`
  (avance/retard, rebase en cours) en direct, jamais stocké (D16, chantier 07). Rien pour
  lister des commits, des branches ou un statut de fichiers.
- `src/daemon/routes/fs.ts` ne sert que le sélecteur de dossier à l'enregistrement d'un
  workspace (liste de dossiers sous `$HOME`, `MAX_ENTRIES = 1000`) — sans rapport avec un
  explorateur de worktree avec statut git.
- `src/daemon/actions/editor.ts:16-45` ouvre déjà le worktree entier dans l'éditeur
  configuré (`editor.open`, utilisé par `1-3.actions.editeur`) ; rien pour ouvrir un
  fichier précis ni un diff.
- `src/shared/model.ts:66-84` (`Topic`) porte déjà `branch`, `base`, `worktree`,
  `prNumber`, `prUrl`, `stashRef` (chantier 07) — aucun champ supplémentaire n'est requis
  par ce chantier, y compris pour « rattacher » (D27, réutilise `branch`).
- `src/daemon/routes/topics.ts:22-34` (`TOPIC_ACTIONS`) liste les actions de chantier 07
  (`topic.sync`, `topic.pr`, `topic.merge`, …) — aucune action git de lecture/écriture pour
  ce chantier n'y figure encore.
- Aucune dépendance de rendu Markdown ni de coloration syntaxique n'est installée
  (`package.json`) : la visionneuse (3.4) et la vue source (3.5) partent de zéro.
- `docs/chantiers/README.md` §5 classe « diff et Monaco » hors périmètre v0.1 ; ce chantier
  ne les remet pas en cause (D33 ci-dessous), ce qui change la portée réelle de
  `diff.ouvrir`/`diff.ouvrir-fichier` dans l'export.

## Cible et hors-périmètre

| Écran | Construit | Omis (et pourquoi) |
| --- | --- | --- |
| 3.1 Onglet Agents | Reclassement de la vue actuelle sous un onglet, comportement inchangé | Rien de neuf : c'est la vue d'aujourd'hui |
| 3.2 Onglet Git | Graphe (calculé côté client), historique, détail de commit, situation (avance/retard déjà connu), fetch, push, recherche, portée | Résolution de conflit en dehors de `topic.sync` (déjà hors périmètre, chantier 07) |
| 3.3 Changer de branche | Sélecteur ancré, filtre, groupes, confirmation, créer une branche (ici / depuis la base), recréer une branche extraite ailleurs | Fusion de branches hors du flux PR (chantier 07 couvre déjà `topic.merge`) |
| 3.4 Onglet Fichiers | Explorateur (arbre + statut git), filtre tout/modifiés, visionneuse Markdown (blocs, sommaire, cases à cocher, copier le code) | Édition du fichier dans le navigateur (l'éditeur externe reste la seule écriture, cf. `editor.open`) |
| 3.5 Fichier en source | Numéros de ligne, bascule aperçu/source pour un `.md` | Coloration syntaxique (D31) : pas de nouvelle dépendance type Shiki/Monaco |
| 3.6 Worktree hors de la branche du sujet | Détection de dérive (HEAD détachée ou branche différente), bandeau, « revenir », « rattacher » | Rien de neuf par ailleurs : réutilise le graphe et la situation de 3.2 |

Hors périmètre confirmé par `docs/chantiers/README.md` §5 et non remis en cause ici :
rendu de diff en app (Monaco), édition de fichier dans le navigateur, Swairm.

## Décisions prises

- **D22 — L'onglet actif (agents/git/fichiers) est un état UI pur, jamais persisté.**
  État React local de `Sujet.tsx`, reflété dans `?onglet=` (comme `?agent=` l'est déjà pour
  l'agent sélectionné, `Sujet.tsx:61-63`), défaut `agents`. Aucune table, aucune colonne.
- **D23 — Lecture à la demande hors file ; écriture en file partagée.** Toute lecture
  (journal de commits, détail d'un commit, liste de branches, arbre de fichiers, contenu
  d'un fichier) est un `GET` direct, à l'ouverture de l'onglet ou au clic sur
  « rafraîchir », jamais injecté dans `/api/state` ni son tick de sondage — même
  raisonnement que D16/D18 (chantier 07) appliqué à des lectures plus coûteuses (`git log`,
  `git status` sur tout le worktree). Toute écriture qui touche les refs partagées du dépôt
  (fetch, push, changer de branche, créer une branche) passe par la même `WorkspaceQueue`
  que `topic.sync`/`topic.pr`/`topic.merge` (D19 étendu), jamais un `GET` mutant.
- **D24 — Le graphe de commits se calcule côté client.** Le backend renvoie les commits
  bruts (`hash`, `parents`, `auteur`, `date`, `message`, `refs`, `dansHead`) via
  `git log --topo-order --format=…`; aucune géométrie ni couleur de voie n'est calculée ni
  stockée côté serveur — l'algorithme de `design/aid-export-git-flow/README.md` (« Graphe
  git ») se réimplémente tel quel dans le composant React.
- **D25 — Changer de branche partage la file (D19), via un script dédié.** Nouveau
  `scripts/git/topic-switch.sh` (même contrat que `topic-sync.sh` : `AID_REPO_ROOT
  AID_BRANCH AID_WORKTREE` + `AID_TARGET_BRANCH`), appelé par une nouvelle action
  `topic.branch-changer`. Le non-commité réutilise exactement le vocabulaire `AID_DIRTY_ACTION`
  de D21 (chantier 07) : absent → refus net (code 2) ; `stash` → `git stash push -u` avant
  `git switch`. Aucun second mécanisme de gestion du worktree sale.
- **D26 — Créer une branche ne change ni `topics.branch` ni l'état du sujet.** C'est un
  changement de branche du worktree comme un autre : même script, mode `AID_CREATE=1`
  (`git switch -c`), que la branche parte de la base du sujet ou de HEAD (`branche.creer`
  vs `branche.creer-ici`).
- **D27 — « Rattacher » (3.6) est la seule action de ce chantier qui écrit en base.**
  `sujet.rattacher-branche` met à jour `topics.branch` sur la branche courante du worktree
  (aucune migration : la colonne existe déjà). « Revenir » (`branche.revenir`) ne touche
  pas la base : il réutilise `topic-switch.sh` pour ramener le worktree sur `topic.branch`
  déjà connu.
- **D28 — La dérive (3.6) se lit en direct, jamais stockée.** Extension de `gitLiveInfo`
  (`src/daemon/git/inspect.ts:80`) avec `onTopicBranch: boolean` (`currentBranch(worktree)
  === topic.branch` ; faux aussi en HEAD détachée) — même raisonnement que D16.
- **D29 — Arbre de fichiers et statut git se lisent ensemble, à chaque requête.**
  `git status --porcelain=v1 --untracked-files=all` fusionné à un parcours de répertoire
  borné (même garde `MAX_ENTRIES` que `src/daemon/routes/fs.ts:15`, appliquée au worktree).
  La portée « modifiés » filtre côté serveur sur les chemins présents dans le statut. Le
  chemin demandé est toujours résolu puis vérifié sous `topic.worktree` (jamais de
  traversée `../`, même règle que `fs.ts` sous `$HOME`) ; un fichier binaire (détection par
  octet nul dans les premiers 8 Ko) ou de plus de 1 Mo renvoie l'état vide « trop gros »
  (3.5) plutôt que son contenu.
- **D30 — Visionneuse Markdown : `marked` en tokenizer, jamais de HTML injecté tel quel.**
  Nouvelle dépendance `marked` (lexer seulement) ; le front mappe les tokens vers les
  `data-type` du README de l'export (h1/h2/h3/paragraphe/liste/tableau/code/citation) et les
  rend lui-même (JSX), sans `dangerouslySetInnerHTML` — un `README.md` d'une branche
  distante n'est pas un contenu de confiance. Le sommaire (`data-ancre`) est dérivé des
  titres de niveau 2 trouvés dans les tokens, pas d'un second parseur.
- **D31 — Vue source sans coloration syntaxique en v1.** Numéros de ligne et police
  monospace seulement — pas de nouvelle dépendance (Shiki, Monaco…), cohérent avec le
  hors-périmètre v0.1 « diff et Monaco » (`docs/chantiers/README.md` §5). La bascule
  aperçu/source (`visionneuse.mode`) n'a de sens que pour un `.md` ; tout autre fichier
  s'ouvre directement en source.
- **D32 — `diff.ouvrir`/`diff.ouvrir-fichier`/`editeur.ouvrir-fichier` délèguent à
  l'éditeur externe, pas à un rendu interne.** Extension d'`openInEditor`
  (`src/daemon/actions/editor.ts:27`) pour accepter un chemin de fichier précis (le patron
  `{path}` existe déjà) ; `diff.ouvrir-fichier` ajoute l'argument diff natif de l'éditeur
  configuré quand il en connaît un (ex. `code --diff <base> <fichier>`), sinon ouvre
  simplement le fichier — repli déclaré, pas un échec. Aucun visualiseur de diff en app.
- **D33 — Fetch et push sont des actions en file, pas des boutons qui appellent `git`
  en direct.** Deux scripts minimaux (`scripts/git/topic-fetch.sh`,
  `scripts/git/topic-push.sh`), même contrat que les scripts existants, actions
  `git.fetch` et `git.pousser` ajoutées à `TOPIC_ACTIONS`. Le bouton « Pousser » reste
  `disabled` quand `aheadBehind.ahead === 0` (déjà la règle affichée par l'export).

## Points

### 11.1 — Onglets de la page Sujet (reclassement, sans effet)

Fichiers : `web/src/ecrans/Sujet.tsx`, `test/web/sujet.test.tsx` (ajouts).

- Introduit la barre `1-3.onglets.{agents,fichiers,git}` au-dessus de la zone de contenu
  actuelle ; la vue agents (terminaux, `+ Agent`, `Arrêter`) devient le contenu de l'onglet
  `agents`, sélectionné par défaut — aucun changement de comportement pour cet onglet.
  `fichiers` et `git` affichent un espace réservé (« à venir ») jusqu'à 11.3/11.8.
- État : React local + `?onglet=`, par D22. Ne pas persister, ne pas toucher à `?agent=`.
- Test : onglet par défaut = agents ; changer d'onglet puis revenir ne perd pas l'agent
  sélectionné ; l'URL reflète l'onglet actif.

Vérification : `npm run gate`.

### 11.2 — Backend Git : journal de commits et dérive

Fichiers : `src/daemon/git/inspect.ts` (`onTopicBranch`, D28), `src/daemon/routes/topics.ts`
(nouvelle route `GET /api/topics/:id/git/log`), `test/git-log.test.ts` (nouveau).

- `GET /api/topics/:id/git/log` : `git log --topo-order --format=…` sur
  `origin/<base>..HEAD` (commits du sujet) plus une fenêtre bornée des branches locales et
  distantes visibles (pour les refs décorées sur l'historique partagé, cf. export) ; renvoie
  les commits bruts (D24), jamais de géométrie.
- `onTopicBranch` ajouté à `gitLiveInfo` : même passage que l'avance/retard, pas un second
  appel git.
- Test : dépôt de test avec quelques commits sur la branche du sujet et sur main ; vérifie
  la forme renvoyée et `onTopicBranch` vrai/faux (HEAD détachée incluse).

Vérification : `npm run gate`.

### 11.3 — Onglet Git, UI (écran 3.2)

Fichiers : `web/src/ecrans/Sujet.tsx` (ou nouveau `web/src/ecrans/OngletGit.tsx`), nouveau
composant de graphe (algorithme D24), `test/web/onglet-git.test.tsx` (nouveau).

- Graphe (voies 0/1/2, nœuds, commit WIP en pointillé, commits absents de HEAD en opacité
  réduite — algorithme exact de `design/aid-export-git-flow/README.md`), liste des commits,
  panneau de détail (`git.selectionner` → fichiers modifiés, stat, parents, refs), filtre
  (`git.filtrer`), portée (`git.portee`), recherche (`historique.recherche`).
  « Voir la base » (`git.voir-base`) : lien vers `origin/<base>` (pas d'action réseau).
- États vide (aucun commit depuis la base) et erreur (`.git/index.lock`) comme listés dans
  le README de l'export.

Vérification : `npm run gate`.

### 11.4 — Fetch et push (écran 3.2, boutons de situation)

Fichiers : `scripts/git/topic-fetch.sh`, `scripts/git/topic-push.sh` (nouveaux),
`src/daemon/routes/topics.ts` (`git.fetch`, `git.pousser` ajoutés à `TOPIC_ACTIONS`),
`test/topic-fetch.test.ts`, `test/topic-push.test.ts`.

- Conforme à D33 : même file que `topic.sync`. `git.pousser` refuse (422) si
  `aheadBehind.ahead === 0` — même règle que le bouton `disabled` côté UI, vérifiée aussi
  côté serveur.
- Test : fetch met à jour `origin/<base>` localement ; push avec et sans avance.

Vérification : `npm run gate`.

### 11.5 — Changer de branche : backend (écran 3.3)

Fichiers : `src/daemon/git/inspect.ts` (liste des branches avec méta), `scripts/git/topic-switch.sh`
(nouveau, D25/D26), `src/daemon/routes/topics.ts` (`topic.branch-changer`, `GET
/api/topics/:id/git/branches`), `test/topic-switch.test.ts`, `test/git-branches.test.ts`.

- Liste des branches : nom, dernier commit (hash, date), avance/retard vs base du sujet,
  `worktree` (chemin si extraite ailleurs — un autre sujet A-I-D ou un worktree externe),
  groupée comme l'export (branche du sujet / branches liées / autres).
- `topic-switch.sh` : contrat D25. Dirty-handling = vocabulaire D21 (`AID_DIRTY_ACTION`).
  `AID_CREATE=1` pour `branche.creer`/`branche.creer-ici` (D26).
- 409 si la branche cible est déjà extraite dans un autre worktree A-I-D (le script ne
  tente pas un `git switch` qui échouerait de toute façon).
- Test : changer de branche chemin heureux, refus sur dirty, `stash`, branche déjà extraite
  ailleurs (409), création de branche (ici et depuis la base).

Vérification : `npm run gate`.

### 11.6 — Changer de branche : UI (écran 3.3)

Fichiers : `web/src/ecrans/Sujet.tsx` (ou nouveau composant), `test/web/changer-branche.test.tsx`.

- Sélecteur en couche flottante (`data-layer="overlay"`, ancré sous `entete.branche`,
  largeur max 460 px — valeurs du README de l'export), filtre, groupes, confirmation avant
  le changement effectif (texte + commande affichée, comme l'export le montre).
- Branche extraite ailleurs : `aria-disabled="true"`, pas `disabled` (visible, mais non
  activable) ; action `branche.recreer` proposée à la place.
- États vide (aucune branche ne correspond au filtre) et erreur (`git switch` refusé,
  modifications locales écrasées).

Vérification : `npm run gate`.

### 11.7 — Backend Fichiers : arbre, statut et contenu (écran 3.4/3.5)

Fichiers : `src/daemon/routes/topics.ts` (ou nouveau `src/daemon/routes/files.ts`),
`test/topic-files.test.ts` (nouveau).

- `GET /api/topics/:id/files?scope=tout|modifies&path=…` : arbre + statut git fusionnés
  (D29), borné par `MAX_ENTRIES`.
- `GET /api/topics/:id/files/content?path=…` : contenu brut d'un fichier, résolu et
  vérifié sous `topic.worktree` (garde anti-traversée, D29) ; 422 si binaire ou > 1 Mo.
- Test : portée « modifiés » ne renvoie que les chemins du statut ; traversée `../` rejetée
  (422) ; fichier binaire rejeté ; fichier supprimé/renommé pendant la lecture (état vide
  3.4).

Vérification : `npm run gate`.

### 11.8 — Onglet Fichiers, UI : explorateur et visionneuse Markdown (écran 3.4)

Fichiers : `web/src/ecrans/Sujet.tsx` (ou nouveau composant), ajout de la dépendance
`marked` (`package.json`), nouveau module de rendu Markdown (D30), `test/web/visionneuse-markdown.test.tsx`.

- Explorateur : arbre avec badges de statut, filtre tout/modifiés (`fichiers.portee`),
  rafraîchir, replier tout (`fichiers.replier`), compteur total/modifiés.
- Visionneuse : blocs typés (D30), cases à cocher `- [x]` barrées/grisées, code en ligne,
  gras, liens, blocs de code avec bouton Copier (`md.copier-code`), sommaire des H2
  (`visionneuse.ancre`, masqué téléphone/tablette).
- Fil d'Ariane du chemin (`visionneuse.chemin`), copier le chemin (`fichier.copier-chemin`),
  révéler dans le Finder/Explorer (`fichier.reveler`), mentionner dans l'agent
  (`agent.mentionner-fichier`) et ouvrir dans l'éditeur (`editeur.ouvrir-fichier`, via 11.11).
- État vide (aucun fichier modifié, filtre « Modifiés »).

Vérification : `npm run gate`.

### 11.9 — Vue source et bascule aperçu/source (écran 3.5)

Fichiers : même composant que 11.8, `test/web/visionneuse-source.test.tsx`.

- Numéros de ligne, police monospace (D31). Bascule `visionneuse.mode` (aperçu ⇄ source)
  visible seulement pour un `.md` ; tout autre fichier affiche directement la source.
- États vide (fichier vide) et erreur (binaire ou trop gros — réutilise le 422 de 11.7).

Vérification : `npm run gate`.

### 11.10 — Worktree hors de la branche du sujet (écran 3.6)

Fichiers : `web/src/ecrans/Sujet.tsx`, `src/daemon/routes/topics.ts`
(`sujet.rattacher-branche`, D27 ; `branche.revenir` réutilise `topic-switch.sh` de 11.5),
`test/topic-rattacher.test.ts`.

- Bandeau de dérive quand `!onTopicBranch` (D28) : branche courante du worktree, raison
  (HEAD détachée vs branche différente), actions « Revenir » et « Rattacher ».
- `sujet.rattacher-branche` : met à jour `topics.branch`, émet l'événement existant
  `topic.state`-like déjà utilisé pour les changements de branche (vérifier le motif
  employé par `syncTopicBranches` pour rester cohérent, pas un nouveau type d'événement).
- États vide (HEAD détachée) et erreur (branche du sujet supprimée en local).

Vérification : `npm run gate`.

### 11.11 — Ouvrir un fichier ou un diff dans l'éditeur

Fichiers : `src/daemon/actions/editor.ts`, `src/daemon/routes/topics.ts`
(`editeur.ouvrir-fichier`, `diff.ouvrir`, `diff.ouvrir-fichier`), `test/editor.test.ts`
(complété).

- Conforme à D32 : `openInEditor` accepte un chemin de fichier précis en plus du worktree
  entier ; `diff.ouvrir-fichier` ajoute l'argument diff natif de l'éditeur configuré quand
  il en connaît un, sinon ouvre le fichier simplement (repli déclaré).
- Test : chemin précis transmis par variable, jamais par une chaîne shell (même garde que
  `openInEditor` aujourd'hui, `src/daemon/actions/editor.ts:26`).

Vérification : `npm run gate`.

### 11.12 — Recette

Fichiers : `docs/recette-onglets-git-fichiers.md` (nouveau, sur le modèle de
`recette-v0.3.md`).

- Grille de recette manuelle : parcours des six écrans (3.1 à 3.6) sur un sujet réel, avec
  un vrai `gh`/`git`, en suivant l'export écran par écran.

Vérification : `npm run gate` et `npm run gate:e2e`.

## Pièges

- Ne jamais stocker l'avance/retard, le journal de commits, la liste des branches ou le
  statut de fichiers en base — même trap que D16 (chantier 07), étendu à des lectures plus
  coûteuses.
- `git fetch`/`push`/`switch` concurrents sur le même dépôt depuis des worktrees liés :
  rester dans la même `WorkspaceQueue` (D19/D23), ne pas être tenté par une file plus fine.
- Le dirty-handling de `topic-switch.sh` réutilise le vocabulaire `AID_DIRTY_ACTION` de
  `topic-cleanup.sh` (D21) : ne pas réinventer un second jeu de valeurs.
- Chemin de fichier venant du client : toujours résolu puis vérifié sous `topic.worktree`
  avant lecture — une requête `path=../../…` ne doit jamais sortir du worktree.
- Contenu Markdown d'un fichier du dépôt : jamais `dangerouslySetInnerHTML` sur le texte
  brut ou sur un rendu HTML du token stream — un README de branche distante peut contenir
  du HTML malveillant (D30).
- `onglet.choisir` (data-action déjà utilisé par les onglets de terminal d'agent,
  `Sujet.tsx:434`) et `onglet.agents`/`onglet.fichiers`/`onglet.git` (nouveaux, barre de
  contenu) désignent deux choses différentes dans l'export : garder des identifiants
  distincts côté code, ne pas réutiliser le même nom de state ni le même data-action pour
  les deux barres d'onglets.
- `diff.ouvrir`/`editeur.ouvrir-fichier` ne sont pas un nouveau visualiseur de diff en app :
  Monaco reste hors périmètre (README §5). Ne pas être tenté d'en ajouter un « juste pour
  cet écran ».
- L'index structurel (`index_explore`/`index_impact`) était indisponible à l'écriture de ce
  plan : le dev qui l'exécute doit le requêter lui-même en phase dev, pas supposer que le
  rayon d'impact ci-dessus en vient.

## Fini quand

- Les six écrans (3.1 à 3.6) ont une implémentation qui suit, onglet par onglet, l'export
  `design/aid-export-git-flow/`.
- `npm run gate` et `npm run gate:e2e` verts en entier.
- Changer de branche, créer une branche, rattacher une branche et revenir à la branche du
  sujet fonctionnent sur un vrai dépôt de test (test automatique, pas seulement manuel).
- Un fichier Markdown du worktree s'affiche en aperçu structuré et en source, sans jamais
  injecter de HTML brut.
- Aucun test des chantiers 02, 04, 06 ou 07 n'a changé de résultat.
