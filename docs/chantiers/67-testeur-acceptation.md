# Chantier 67 : le testeur d'acceptation écrit les tests rouges avant le dev

| Champ | Valeur |
|---|---|
| État | **Révision 0, 25 novembre 2026.** C'est le « testeur d'acceptation avant le dev » de l'analyse du 16 novembre (§2.2), repris par la note d'idéation du 17 novembre (§10.3, §13.3, risque 3 du §14). Julien a tranché trois choix le 25 novembre : le testeur écrit **avant** le dev ; la phase vit dans le **noyau**, désactivée par défaut et activée d'abord sur A-I-D ; la table des intentions (`data-action`) vient **plus tard**. |
| Emplacement final | `docs/chantiers/67-testeur-acceptation.md` sur `main` |
| Base | `main` (2427d91) |
| Organisation | Comme au 60. cell-gestion gère le chantier ; Codex CLI écrit le code et les tests de chaque point ; cell-gestion relit, lance le gate, commite et ouvre la PR. **À partir du 67.3, chaque point passe d'abord par une session de testeur distincte (DM53).** |
| Dépend de | Le skill `contrat-acceptation` (#186), qui écrit les critères dans le plan. Aucune PR ouverte (61 à 66) n'est requise. |
| Validation | Le gate est vert à chaque point, puis `gate:e2e`. Le chantier ne touche ni au contrat swarph ni au daemon. Merge sur le oui de Julien, CI verte. |

## 1. Pourquoi

Le développeur écrit aujourd'hui le code **et** ses propres tests. Ses tests vérifient ce que son code fait, pas ce que le plan demandait. La revue le voit parfois, la recette de Julien le voit toujours, mais tard : c'est le ping-pong que la note du 17 novembre veut supprimer.

La note pose une règle (§13.3) : « celui qui écrit les tests ne voit pas le code, celui qui écrit le code ne touche pas aux tests ». Le merge automatique (§10.2) et la boucle dans le daemon en dépendent. Sans critère écrit à l'avance par un autre, un gate vert ne prouve que la cohérence du dev avec lui-même.

Le risque 3 du §14 dit aussi ce qu'il faut mesurer : pour une interface ou un pas de configuration, le test est difficile à écrire à l'avance. Si le testeur ne couvre qu'un tiers des points, le merge automatique n'en couvre qu'un tiers. Ce chantier pose donc la phase **et** la mesure de sa couverture.

## 2. Cible et hors-périmètre

**Cible.**
- Une phase `acceptation` dans le noyau, entre `plan` et `dev`, avec son rôle. Elle n'est active que dans un projet qui la déclare.
- Des tests d'acceptation reconnaissables : un commit à part par point, marqué, qui ne touche que les chemins de test.
- Trois contrôles mécaniques, sans modèle, dans une commande `aid acceptation` :
  - le dev n'a pas touché aux fichiers d'acceptation ;
  - les tests étaient rouges avant le dev, et sont verts à la tête ;
  - la part des points du plan couverte par des tests d'acceptation.
- Le gate du noyau gagne ces contrôles quand la phase est active.
- A-I-D active la phase, et ce chantier s'en sert à partir du 67.3.

**Hors-périmètre.**
- La table des intentions (`data-action`) et le vérificateur sur l'application lancée : un chantier suivant, sur les `data-node` du 56.
- Lancer le testeur depuis le daemon : c'est la boucle dans le daemon. Ici, l'orchestrateur (cell-gestion, ou l'humain) lance le testeur comme il lance le dev.
- Le merge automatique.
- Le choix du fournisseur du testeur : le routage du chantier 66 le fera. Ici, le testeur est une session à contexte neuf.

## 3. Décisions

### DM50. La phase `acceptation`, dans le noyau, désactivée par défaut

- `kernel/policy/phases.md` gagne la phase `acceptation`, entre `plan` et `dev`.
  - **Lit** : la page du plan, avec son contrat d'acceptation, et le code de la base. Jamais une branche de dev : elle n'existe pas encore.
  - **Écrit** : les tests, dans un commit par point (DM51), et une section « Acceptation » dans le plan, par point : couvert, ou non testable à l'avance avec sa raison (DM52).
- `kernel/roles/acceptation.md` décrit le rôle. Il écrit des tests qui échouent **pour la bonne raison** : une assertion sur le comportement demandé, pas une erreur d'import. Quand le plan nomme une fonction ou une route qui n'existe pas encore, le test l'importe ou l'appelle quand même, et l'échec attendu est noté dans la section du plan. Il n'écrit rien hors des chemins de test.
- `kernel/defaults.yml` ne change pas : `phases` reste `[plan, dev, review, triage, retro]`. Un projet active la phase en redéclarant `phases` dans son `agent.yml`.
- `kernel/policy/orchestration.md` : la boucle gagne une étape `0. ACCEPTATION` avant `BUILD`, et le gate un cinquième contrôle (DM54), seulement quand la phase est déclarée.
- `kernel/roles/dev.md` : quand la phase est active, le dev lit les tests rouges, et **ne les modifie pas**. S'il pense qu'un test est faux, il s'arrête et le signale dans son handoff. C'est une escalade, pas un re-dev.
- `kernel/commands/sync.md` rend la phase dans `{{phases.table}}` comme les autres.

### DM51. Un test d'acceptation se reconnaît à son commit

- Le testeur commite les tests d'un point dans un seul commit, avec le trailer `Acceptation: <point>` (par exemple `Acceptation: 67.3`).
- Ce commit ne touche que les chemins d'acceptation du projet. Par défaut, `test/` et `e2e/`. Un projet les redéclare sous `acceptation.chemins` dans son `agent.yml`.
- Les **fichiers d'acceptation** d'une branche sont ceux qu'ajoute ou modifie un commit marqué, entre la base et la tête.
- Un re-dev du testeur (un test faux, signalé par le dev et confirmé) est un nouveau commit marqué, avec le même point. Il ne se mélange jamais à du code.

### DM52. La couverture se mesure, elle ne se suppose pas

- Un point du plan est un titre `### <n>.<m>` ou `### <n>.<m> …`. Le titre `### <n>.1` (le plan lui-même) est exclu.
- Un point est **couvert** s'il a au moins un commit `Acceptation:` sur la branche.
- Un point est **non testable à l'avance** si la section du plan porte une ligne `- _Acceptation._ Non testable à l'avance : <raison>.` Une raison est obligatoire. Les raisons attendues : un pas de configuration sur une vraie machine, un rendu à juger à l'œil, de la documentation seule.
- Un point ni couvert ni justifié est **manquant**, et c'est une erreur.
- La mesure rend : le nombre de points, couverts, non testables (avec les raisons), manquants, et la part couverte. Elle va dans la note de révision du dernier point, puis dans la rétro.

### DM53. Ce chantier se teste lui-même, à partir du 67.3

- Pour chaque point à partir du 67.3, cell-gestion lance d'abord une session Codex **testeur**. Son brief contient le plan et le rôle `acceptation`, et rien d'autre.
- Puis une session Codex **dev**, distincte, avec les tests rouges.
- Avant le 67.3, `aid acceptation` n'existe pas encore : cell-gestion fait le contrôle à la main, avec `git diff --name-only` sur les fichiers du commit marqué.
- À la fin, la mesure du DM52 porte sur les points 67.3 à 67.6.

### DM54. Les trois contrôles, et le gate

`aid acceptation <sous-commande> --base <ref>`, sans daemon, dans le dépôt courant. Chaque sous-commande rend un code de sortie (0 si tout va bien) et, avec `--json`, un objet stable.

1. **`aid acceptation verifier`.** Il lit les commits marqués entre la base et `HEAD`. Il échoue si :
   - un commit marqué touche un fichier hors des chemins d'acceptation ;
   - un commit **non marqué**, postérieur au premier commit marqué du même point, modifie, renomme ou supprime un fichier d'acceptation.

   Il nomme chaque fichier et chaque commit en faute.
2. **`aid acceptation preuve`.** Sa sortie JSON suit le DM55. Pour chaque point couvert, il lance les fichiers d'acceptation deux fois, dans des worktrees temporaires :
   - au commit marqué : ils doivent **échouer** ;
   - à `HEAD` : ils doivent **passer**.

   Les commandes viennent de `acceptation.lancer` dans `agent.yml`, une par chemin, avec `{fichiers}`. Pour A-I-D : `npx vitest run {fichiers}` pour `test/`, et `npx playwright test {fichiers}` pour `e2e/`. Un test vert dès le commit marqué est signalé : il ne prouve rien. Les worktrees sont supprimés, même en cas d'échec.
3. **`aid acceptation couverture --plan <fichier>`.** La mesure du DM52.

Le gate du noyau (`orchestration.md`) gagne le contrôle 5 quand la phase est active : `verifier` et `preuve` passent, et `couverture` n'a aucun point manquant. Un échec de `verifier` est un dépassement de périmètre : il remonte à l'humain, comme le contrôle 3.

### DM55. La sortie de `preuve` suit la forme de preuve du comité #1737

- Le comité a ratifié une forme d'objet de preuve, qui n'est pas encore imposée par la passerelle (lab, DM 105739). `aid acceptation preuve --json` la suit, pour qu'une preuve d'A-I-D puisse servir telle quelle le jour où la passerelle l'exigera.
- Les clés rendues :
  - `schema_version` (1), `repo` (`owner/name`), `head` (la tête) et `base` (le commit marqué), en sha complet ;
  - `outcome` : `pass`, `fail` ou `cannot_evaluate` ;
  - `commands` : chaque commande réellement lancée, avec son `argv`, son code de sortie et la tête où elle a tourné ;
  - `not_checked` : ce qui n'a pas été vérifié, par exemple un point sans commande de lancement ; la liste peut être vide ;
  - `suites` : `head` et `base`, chacune avec `passed`, `failed` et les identifiants des tests ; `pass_to_fail` doit rester vide ;
  - une extension facultative, `fail_to_pass` : les tests rouges au commit marqué et verts à la tête. C'est le fait que ce chantier prouve. Il n'existe pas encore dans la forme du comité, et nous le proposons comme extension, sans détourner `pass_to_fail`.
- `relationship` n'est jamais rendue par A-I-D : c'est la passerelle qui la calcule.
- Une preuve sans toutes les clés obligatoires n'en est pas une. Le texte autour ne remplace pas une clé manquante.

### DM56. L'interface que le testeur et le dev partagent

Le testeur écrit avant le code. Il lui faut donc des noms fixés par le plan, et le dev doit les respecter.

- **La commande.** `aid acceptation <verifier|preuve|couverture> --base <ref> [--plan <fichier>] [--json]`, dans le dépôt courant, sans daemon. `src/cli/aid.ts` l'aiguille avant l'analyse stricte des options, comme `kernel`, vers `runAcceptation(args: string[], opts?: { cwd?: string; out?: (ligne: string) => void; err?: (ligne: string) => void }): Promise<number>` dans `src/cli/commands/acceptation.ts`.
- **Les codes de sortie.** 0 si le contrôle passe. 1 s'il échoue. 2 pour une erreur d'usage ou d'environnement : sous-commande inconnue, `--base` absent, ref introuvable, dossier hors d'un dépôt git, `--plan` absent pour `couverture`.
- **La sortie.** Sans `--json`, une ligne par faute ou par point, en français. Avec `--json`, un seul objet JSON sur la sortie standard, et rien d'autre.
- **Le manifeste.** `acceptation.chemins` et `acceptation.lancer` sont lus dans `agent.yml`, à la racine du dépôt. Sans `agent.yml` ou sans `acceptation.chemins`, les chemins sont `test/` et `e2e/`.
- **Le cœur de chaque contrôle**, une fonction pure côté résultat, testable sans la CLI, dans `src/acceptation/` :
  - `verifierAcceptation({ depot, base, chemins }): Promise<RapportVerifier>`, dans `verifier.ts`. `RapportVerifier` vaut `{ ok: boolean; points: Record<string, { commits: string[]; fichiers: string[] }>; fautes: { commit: string; fichier: string; raison: 'hors_chemins' | 'modifie_par_dev' | 'renomme_par_dev' | 'supprime_par_dev' }[] }`. Les commits sont des sha complets. Sans commit marqué, `ok` vaut `true` et `points` est vide.
  - `prouverAcceptation({ depot, base, chemins, lancer }): Promise<PreuveD5[]>`, dans `preuve.ts`, avec la forme du DM55 et les règles du DM57. `lancer` est un objet `{ [chemin]: commande }`.
  - `mesurerCouverture({ depot, base, plan }): Promise<RapportCouverture>`, dans `couverture.ts`. `RapportCouverture` vaut `{ points: { point: string; etat: 'couvert' | 'non_testable' | 'manquant'; raison?: string }[]; total: number; couverts: number; nonTestables: number; manquants: number; part: number }`. `part` est la part couverte parmi les points testables, entre 0 et 1.
- Le trailer se lit avec `git log --format=%(trailers:key=Acceptation,valueonly)`. Sa valeur est le point, sans espace autour.

### DM57. Comment `preuve` lance les tests

Le DM54.2 et le DM55 disent ce que `preuve` prouve. Voici comment, pour que le testeur et le dev partent des mêmes règles.

- **Une preuve par point.** `prouverAcceptation` rend une liste de `PreuveD5`, une par point couvert, dans l'ordre des points. Pour un point, `base` est son **premier** commit marqué, et ses fichiers d'acceptation sont ceux de ce commit. `head` est `HEAD`.
- **Le grain est le fichier.** Chaque fichier d'acceptation est lancé seul, une fois à `base` et une fois à `head`. Il passe si sa commande rend 0. Les `ids` des suites sont les chemins des fichiers.
- **La commande.** Le fichier prend la commande de `acceptation.lancer` dont le chemin est le préfixe de son chemin. La chaîne est découpée sur les espaces, sans shell, et `{fichiers}` est remplacé par le chemin du fichier, en un seul argument. Un fichier sans commande va dans `not_checked`.
- **Les worktrees.** Chaque lancement a lieu dans un worktree détaché et temporaire (`git worktree add --detach`), sous le dossier temporaire du système. Si le dépôt a un `node_modules` à sa racine, le worktree reçoit un lien symbolique vers lui. Le worktree est retiré, même en cas d'échec ou de délai dépassé. Une commande a dix minutes au plus, sinon elle compte comme un échec et sa durée dépassée est notée.
- **Le résultat d'un point.**
  - `pass` : chaque fichier échoue à `base` et passe à `head`. Ils vont tous dans `fail_to_pass`.
  - `fail` : un fichier passe déjà à `base` (il ne prouve rien), ou échoue encore à `head`. `pass_to_fail` reçoit un fichier qui passait à `base` et échoue à `head`.
  - `cannot_evaluate` : au moins un fichier sans commande, et aucun autre échec.
- **`repo`** vient de l'URL du remote `origin`, réduite à `owner/name`. Sans remote `origin`, c'est une erreur d'environnement (code 2).
- **Le code de sortie.** 0 si chaque point est `pass`. 1 si un point est `fail` ou `cannot_evaluate`. 2 pour une erreur d'usage ou d'environnement. Sans point couvert, la liste est vide et le code est 0.
- **La sortie.** Avec `--json`, l'objet `{ "preuves": [...] }`. Sans `--json`, une ligne par point : le point, son résultat, et les fichiers en faute.

## 4. Points

### 67.1 Le plan

Ce document, et une ligne dans `README.md`.

### 67.2 Le noyau (DM50, DM51)

- `kernel/policy/phases.md`, `kernel/roles/acceptation.md`, `kernel/roles/dev.md`, `kernel/policy/orchestration.md`, `kernel/commands/sync.md`, `kernel/manifest.schema.yml` (les clés `acceptation.chemins` et `acceptation.lancer`).
- Le `CHANGELOG.md` du noyau et sa version.
- Le `agent.yml` d'A-I-D déclare la phase, et ses chemins et commandes.
- Les tests existants du noyau (le rendu de `/sync`, le schéma) couvrent la phase déclarée et la phase absente.

_Acceptation._ Ce point est écrit sans testeur : l'outil n'existe pas encore (DM53).
- _Révision 67.2._ Deux passes. La première montait `kernel.version` à 0.10.0, une version qui n'existe pas : depuis la fusion, la version du noyau est celle d'aidboard (`kernel/commands/sync.md` §2). La reprise remet 0.9.1. `CLAUDE.md` et `AGENTS.md` seront rendus de nouveau par `/sync` après la prochaine release. Gate 4 687.

### 67.3 `aid acceptation verifier` (DM51, DM54.1, DM56)

La commande, la lecture des trailers, les chemins du manifeste, la sortie JSON. Les tests travaillent sur des dépôts git temporaires :
- un commit marqué propre ;
- un commit marqué qui touche `src/` ;
- un commit de dev qui modifie, renomme ou supprime un fichier d'acceptation ;
- un re-dev du testeur, marqué ;
- aucune base ou aucun commit marqué.

- _Acceptation._ Couvert par `test/acceptation-verifier.test.ts` (1534b4b), seize cas écrits par le testeur depuis le plan seul : commit marqué propre ; `hors_chemins` ; `modifie_par_dev`, `renomme_par_dev` et `supprime_par_dev` ; re-dev marqué sans faute ; aucun commit marqué ; chemins par défaut, sans `agent.yml` ou sans la clé, et chemins déclarés ; codes de sortie 0, 1 et 2 (sous-commande inconnue, `--base` absent, ref introuvable, hors d'un dépôt) ; `--json`. Échec attendu au commit marqué : l'import de `src/acceptation/verifier.js`, absent. Les nouveaux modules ne peuvent pas échouer sur une assertion avant d'exister.
- _Révision 67.3._ Premier point passé par le testeur : une session testeur, puis une session dev distincte. Les seize tests d'acceptation passent, et leur fichier est identique à 1534b4b. Le dev n'a signalé aucun test faux, et n'a ajouté aucun test. Gate 4 703.

### 67.4 `aid acceptation preuve` (DM54.2, DM55, DM56, DM57)

Les deux lancements, la sortie JSON du DM55, les worktrees temporaires et leur nettoyage, le test vert dès le commit marqué, une commande absente du manifeste. Les tests utilisent un dépôt temporaire avec un faux lanceur, sans vitest ni playwright réels.

- _Acceptation._ Couvert par `test/acceptation-preuve.test.ts` (9fea6d3), dix cas écrits par le testeur depuis le plan seul, avec un faux lanceur : rouge puis vert et `fail_to_pass` ; vert dès le commit marqué ; rouge persistant ; `pass_to_fail` ; `not_checked` et `cannot_evaluate`, et `fail` qui l'emporte ; une preuve par point, dans l'ordre des points, avec son premier commit marqué et ses seuls fichiers ; les clés du DM55, les sha complets, `repo`, `commands`, les suites et l'absence de `relationship` ; un chemin avec des espaces passé en un seul argument, sans shell ; le worktree détaché, son lien `node_modules`, et son retrait après un succès comme après un échec ; `--json` ; les codes 0, 1 et 2, dont l'absence d'`origin` ; la liste vide sans point couvert. Échec attendu au commit marqué : l'import de `src/acceptation/preuve.js`, absent, et huit cas de la CLI sur le code de sortie (2 au lieu de 0 ou 1). Non testé à l'avance : le délai de dix minutes, que l'interface publique ne permet ni de régler ni de simuler sans une vraie attente.
- _Révision 67.4._ Une passe du testeur, puis une passe du dev. Les dix tests d'acceptation passent, et les fichiers d'acceptation du 67.3 et du 67.4 n'ont pas changé. Le dev n'a signalé aucun test faux. Il a ajouté un test du délai, avec un délai injectable en interne. La cell de gestion a vérifié à part que le retrait d'un worktree ne suit pas le lien `node_modules`. Gate 4 714, sans worktree ni dossier `aid-preuve-` restant.

### 67.5 `aid acceptation couverture` (DM52, DM54.3, DM56)

La lecture des titres de points, des lignes « Non testable à l'avance » et des commits marqués. Les tests portent sur un plan d'exemple : un point couvert, un point justifié, un point manquant, une raison vide, le point `.1` exclu.

### 67.6 Le gate, la fiche de recette et la mesure

- `aid doctor` signale un projet qui déclare la phase sans `acceptation.lancer`.
- La fiche `docs/recette-chantier-67-testeur-acceptation.md` : un vrai chantier suivant, passé par le testeur, et sa mesure de couverture.
- La note de révision rend la mesure du chantier 67 lui-même (DM53).

## 5. Pièges

- **Le testeur qui lit le code du dev.** Avant le dev, il n'y en a pas. Le brief du testeur ne cite jamais une branche de dev, ni un worktree de dev.
- **Le test rouge pour une mauvaise raison.** Une erreur de syntaxe ou d'import rend aussi un test rouge. Le rôle demande une assertion sur le comportement. La preuve compare seulement rouge et vert, donc la revue du testeur lit les messages d'échec au commit marqué.
- **Le dev qui « corrige » un test.** C'est le contrôle 1. Le brief du dev le dit, et `verifier` le prouve.
- **Les worktrees de `preuve`.** Ils vivent sous `$TMPDIR`, et sont supprimés même en cas d'échec. Les inodes du VPS sont comptés.
- **Aucun vrai nom** de cell, de dépôt ni d'hôte dans les fixtures (gardes 49 et 54).

## 6. Fini quand

- 67.2 à 67.6 sont mergés, avec la CI verte et le oui de Julien.
- La mesure de couverture du chantier 67 est écrite, avec la raison de chaque point non testable.
