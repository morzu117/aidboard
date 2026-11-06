# Chantier 27 : écran Livraison

| Champ | Valeur |
|---|---|
| État | **Révision 1, 6 novembre 2026.** Spec validée par Julien le 6 novembre (`specs/livraison-v1.md`, ses neuf recommandations). **Plan validé par Julien le 6 novembre.** Aucune relecture du lab : le chantier ne touche pas au contrat swarph (programme §5 bis). |
| Emplacement final | `docs/chantiers/27-livraison.md` sur `main`, dans le premier commit du chantier |
| Base | **be615af** (`origin/main`, PR #120). Les `fichier:ligne` ont été lus sur cette base. |
| Spec | `docs/fusion-aid-swarph/spec-driven-plan/specs/livraison-v1.md` (dossier de travail, hors dépôt), qui adapte la fiche V4 `livraison` et `regles-globales`. Captures `Livraison`, `Livraison-attente`, `Main-livraison` dans `design/aid-refonte-review-2026-11-04-v4.zip`. |
| Programme | `docs/fusion-aid-swarph/spec-driven-plan/programme.md`, phase 2 |
| Validation | Julien (interface purement locale, commander 89702). Recette sous Node 22 et 24. |

## 1. Pourquoi

La V4 répond à une seule question avant un merge : peut-on livrer cette tête Git, et sur quelles preuves ? Le chantier 06 a livré l'ouverture de la PR, sa relecture, le test local et le merge côté daemon, sans aucun écran ; et son merge ne vise aucune tête. Ce chantier donne un écran à ce circuit, attache chaque preuve à une tête précise et fait partir le merge sur la tête affichée, rien d'autre. Ce qui demande une carte, le board ou le téléphone attend.

## 2. État actuel

Abréviations : `T` = `src/daemon/routes/topics.ts`, `G` = `scripts/git/`, `PC` = `web/src/ecrans/PanneauContexte.tsx`, `A` = `web/src/ecrans/Accueil.tsx`.

| Zone | Où | Ce qui existe |
|---|---|---|
| Ouvrir la PR | `T:696-726`, `G/topic-pr.sh` | `git push -u`, `gh pr create`, puis `topic.pr` porte `prNumber` et `prUrl` sur le sujet (`src/shared/model.ts:106-107`). Titre requis |
| Relire la PR | `T:728-742`, `G/topic-pr-refresh.sh:10-11` | `gh pr view --json statusCheckRollup,reviews,mergeable,title,body,url` ; résultat dans `ActionRun.result` (`model.ts:150-160`), lu par le web dans `state.actions`. Aucune tête dans la lecture |
| Test local | `T:490-502`, `G/topic-test.sh` | `npm test`, code de sortie seul, aucune tête |
| Merge | `T:744-800`, `G/topic-merge.sh:16-21` | `gh pr merge <n>` avec stratégie requise, `--delete-branch`, `--subject`, nettoyage enchaîné ; aucune tête visée |
| Diff d'un fichier | `T:407-450` | `diff.ouvrir-fichier { hash, path }` : avant = `hash^`, après = `hash`, dans l'éditeur externe (D32) |
| Journal et base | `T:256-271`, `src/daemon/git/inspect.ts:117`, `:292` | `gitLog` et `gitLiveInfo` contre `topics.base` |
| Revues | `web/src/data/memory.ts:19-49`, `PC:19-24` | Page `<ns>/review/<slug>`, Markdown libre ; le frontmatter accepte toute clé (`src/shared/memory.ts:15`) ; onglet Revue si la page existe |
| Lancer un agent | `src/daemon/routes/agents.ts:62-68` (`POST /api/agents`), `:77-86` (`/input`) ; `src/daemon/pty/manager.ts:1053-1090` | En `stream`, un message envoyé juste après le lancement est enregistré et part au premier tour ; en PTY, le texte est tapé dans le terminal |
| Panneau | `PC:12-31` | Onglets Sujet, Git, Fichiers, puis Revue, Rétro, Passation |
| Accueil | `A:389-510` (`ActionLigne`) | Désarchiver, Trancher, Relire, Suivre, Reprendre, Lancer ; Livrer renvoyé au 27 (`coque-v1.md`) |
| Routes web | `web/src/App.tsx:34` | `/sujets/:topicId` |
| Faux `gh` | `test/fixtures/fake-gh.sh` | `auth status`, `pr create`, `pr view` (contrôles et `mergeable` par variables), `pr merge` journalisé dans `FAKE_GH_MERGE_LOG` ; `AID_GH_BIN` le désigne |

## 3. Cible et hors-périmètre

**Cible** : la fiche `livraison-v1.md`, lignes « Construit », « Construite », « Liste des fichiers seulement » et « Ligne PR seule ».

**Hors-périmètre** (lignes « Plus tard » de la fiche) : confirmation au téléphone et expiration (34, 43) ; critères ; carte et tête publiées sur le board (35, 36) ; findings, corrections, lot et motifs d'écart ; diff en ligne ; panne d'environnement distinguée d'un échec ; relancer un contrôle GitHub. Aucune lecture ni écriture nouvelle du board, aucune commande swarph, aucune colonne en base.

## 4. Décisions

| # | Décision | Raison |
|---|---|---|
| **D121** | L'écran Livraison est la route `/sujets/:topicId/livraison` (`web/src/ecrans/Livraison.tsx`, data-node `livraison.*`). Fil d'Ariane `projet / livraison`, le projet ramène au sujet. Sur un sujet sans worktree ou fusionné, l'écran se lit sans action. Aucun écran pour une discussion de serveur. | Capture `Livraison`. Préfixe nommé comme `board.*` et `carte-board.*`. |
| **D122** | La **tête** de l'écran est `headRefOid` de la PR relue ; sans PR, `HEAD` du worktree. Si `HEAD` local diffère de la tête de la PR, un bandeau le dit (« La tête locale `abc1234` n'est pas sur la PR ») avec Pousser (`git.pousser`), et le merge est bloqué. | Spec, « Où vit l'écran » et bandeau. Ce qu'on livre est ce qui est sur GitHub. |
| **D123** | `topic.merge` accepte `head` (40 caractères hexadécimaux) ; le script passe alors `--match-head-commit <head>`. Le web l'envoie toujours. Sans `head`, comportement d'aujourd'hui (aucun appelant ne l'utilise ; ses tests restent verts). | Q1. GitHub refuse si la tête a bougé : la promesse de la fiche tient côté serveur, pas seulement à l'écran. |
| **D124** | `pr.rafraichir` lit aussi `headRefOid,state,number,baseRefName,headRefName`. `topic.test` publie `{"head": "<sha>"}` avant de lancer `npm test`. | Q7. Chaque contrôle se dit sur une tête. |
| **D125** | `GET /api/topics/:id/git/livraison[?revue=<sha>]` renvoie `head`, `base`, `mergeBase`, les fichiers `base...HEAD` (statut, +, −), les totaux et l'**empreinte** (8 premiers caractères du hash du `git diff mergeBase HEAD`). Avec `revue` : `{ connu, ancetre, retard }` (`retard` = commits de `revue` à `HEAD`). Lecture seule, rien n'est stocké. | Ligne de contexte et fraîcheur, en un appel. Même base que `GET /git/log`. |
| **D126** | **Fraîcheur de la revue** : la page `review` du sujet porte `commit:` dans son frontmatter. « À jour » si `commit` est la tête ; « Obsolète · N commits de retard » (ambre) s'il en est un ancêtre ; « Obsolète · porte sur un commit absent de la branche » s'il ne l'est pas ou est inconnu ; « Revue sans tête connue » (neutre) sans `commit:`. Sans page, la dernière revue GitHub de la PR (`reviews[].commit.oid`) sert, avec les mêmes mots. Sans l'une ni l'autre : « Aucune revue ». | Q2. |
| **D127** | **Merge bloqué** (bouton désactivé, raison dessous, une seule, dans cet ordre) : sujet ou PR fusionnés ; PR fermée ; aucune PR ; PR pas encore relue ; tête locale hors PR (D122) ; revue obsolète ; `mergeable` vaut `CONFLICTING`. Non bloquants mais **cités dans la confirmation** : « aucune revue », « revue sans tête connue », contrôles en panne ou en cours. | Q3. |
| **D128** | **Confirmation sur le Mac** : un dialogue « Fusionner `3f2a91c` dans `main` ? », stratégie (merge commit par défaut, squash, rebase), « Supprimer la branche » et « Nettoyer le sujet après » décochés, la liste de ce qui est cité (D127). Confirmer lance `topic.merge` avec `head`. Un refus de GitHub s'affiche tel quel et l'écran relit la PR. | Q1, Q9. Le chantier 34 remplacera le dialogue. |
| **D129** | **Relancer la revue sur `<tête>`** : lance un agent du sujet (codex par défaut, claude au choix) et lui envoie un message fixe (`messageRevue()`, `web/src/ui/livraisonVue.ts`) : relire `mergeBase...<tête>`, ne modifier aucun fichier, écrire la page `<ns>/review/<slug>` avec `commit: <tête>`, une ligne « Examiné : … » et une ligne « Non examiné : … ». Puis ouvre le sujet sur cet agent. Seulement en transport `stream` ; en PTY, le bouton est désactivé avec la raison. | Q4. |
| **D130** | **Contrôles** : ceux de `statusCheckRollup` (nom, succès / panne / en cours, durée si `startedAt` et `completedAt`, lien) et le dernier `topic.test` du sujet (succès si code 0, sa tête, sa durée). Un contrôle porté par une autre tête que celle de l'écran est montré « sur `<sha>` », grisé, et ne compte pas. « Relancer ce contrôle » pour le test local seulement. | Q7. |
| **D131** | **Avis de revue** : le premier paragraphe de la page (300 caractères au plus), puis les lignes « Examiné : » et « Non examiné : » si elles existent ; lien vers l'onglet Revue. | Fiche, « Avis de revue ». |
| **D132** | **Trace publiée** : la seule ligne « PR vers `<base>` » : « à créer » avec Ouvrir la PR (dialogue : titre prérempli par le nom affiché du sujet, description vide, `topic.pr`), « #N ouverte » avec lien, « fusionnée ». | Q8. |
| **D133** | **Onglet Livraison** du panneau, après Fichiers (`1-3.onglets.livraison`), pour un sujet local : encart « Revue obsolète… » s'il y a lieu, Contrôles exécutés « N sur M », Autorisation de livraison, « Ouvrir la vue livraison ». Il relit la PR à son ouverture (D18). | Capture `Main-livraison`. |
| **D134** | **Livrer** sur l'accueil : sujet avec `prNumber`, non fusionné, sans décision qui attend ; lien vers l'écran. Il passe après Trancher et avant Relire. | `coque-v1.md`, action de ligne. |
| **D135** | `diff.ouvrir-fichier` accepte `depuis` : la révision « avant » devient `depuis` au lieu de `hash^`. L'écran envoie `{ hash: head, depuis: mergeBase, path }`. | Q5. Une ligne modifiée, D32 tenu. |

## 5. Points

Chaque point est un commit, gate vert. Les lignes existantes modifiées sont comptées dans le message de commit. Les styles nouveaux vont dans `web/src/styles/livraison.css` (nouveau), jamais dans `maquette.css`.

### 27.1 Le plan, et les règles de l'écran

- **Fichiers** : ce plan ; `web/src/ui/livraisonVue.ts` (nouveau) : `lireControles` (D130), `fraicheurRevue` (D126), `blocageMerge` et `citations` (D127), `lireAvis` (D131), `messageRevue` (D129) ; `test/web/livraison-vue.test.ts`.
- **Vérification** : `npm run gate`

### 27.2 La lecture Git de la livraison

- **Fichiers** : `src/shared/git.ts` : `LivraisonGit` (inséré) ; `src/daemon/git/inspect.ts` : `gitLivraison` (inséré) ; `T` : `GET /api/topics/:id/git/livraison` (inséré) ; `web/src/data/git.ts` : `fetchLivraison` ; `test/topic-livraison.test.ts` (dépôt temporaire : fichiers, totaux, empreinte stable, `revue` ancêtre, absent, inconnu).
- **Vérification** : `npm run gate`

### 27.3 Le merge sur une tête

- **Fichiers** : `G/topic-merge.sh` (insertion : `--match-head-commit`) ; `T` : `head` lu et validé, `AID_MERGE_HEAD` passé (quelques lignes modifiées dans le type du corps) ; `test/fixtures/fake-gh.sh` : refus `FAKE_GH_HEAD_MOVED` ; `test/topic-merge.test.ts` : cas ajoutés (tête passée, tête invalide 422, tête bougée refusée), cas existants inchangés.
- **Vérification** : `npm run gate`

### 27.4 La PR et le test relus sur une tête

- **Fichiers** : `G/topic-pr-refresh.sh` (1 ligne modifiée, D124) ; `G/topic-test.sh` (insertion) ; `T:407-430` : `depuis` (D135, 1 ligne modifiée) ; `test/fixtures/fake-gh.sh` : `pr view` rend `headRefOid` (par défaut `git rev-parse HEAD` du dossier courant, sinon `FAKE_GH_HEAD`), `state`, `FAKE_GH_REVIEWS` (lignes modifiées comptées) ; tests ajoutés dans `test/topic-pr-refresh.test.ts`, `test/topic-test.test.ts` et `test/editor.test.ts` (`diff.ouvrir-fichier`).
- **Vérification** : `npm run gate`

### 27.5 L'écran : titre, contexte, fichiers, trace

- **Fichiers** : `web/src/App.tsx` (route insérée) ; `web/src/ecrans/Livraison.tsx` (nouveau) ; `web/src/data/livraison.ts` (nouveau : relire la PR par `pr.rafraichir` et attendre son `ActionRun`, lire `git/livraison`) ; `web/src/styles/livraison.css` ; titre et ligne de contexte (D122, D125), bandeau tête locale, liste des fichiers avec le diff dans l'éditeur (D135), trace publiée et Ouvrir la PR (D132), état « gh non authentifié » ; `test/web/livraison.test.tsx`.
- **Vérification** : `npm run gate`

### 27.6 Contrôles et revue

- **Fichiers** : `Livraison.tsx` : tuiles Contrôles et Revue, colonne Contrôles exécutés avec Relancer le test local (D130), Avis de revue (D131) ; la page `review` est lue par `fetchSubjectMemory`, `?revue=` part avec son `commit` ; tests.
- **Vérification** : `npm run gate`

### 27.7 Autoriser le merge

- **Fichiers** : `Livraison.tsx` : bouton « Autoriser le merge de `<tête>` », raison du blocage (D127), tuile Autorisation ; `web/src/dialogues/ConfirmerMerge.tsx` (nouveau, D128) ; refus de GitHub affiché, puis relecture ; tests.
- **Vérification** : `npm run gate`

### 27.8 Relancer la revue

- **Fichiers** : `Livraison.tsx` : « Relancer la revue sur `<tête>` » avec le choix codex / claude (D129) ; tests (agent lancé, message envoyé, navigation, PTY désactivé).
- **Vérification** : `npm run gate`

### 27.9 Onglet Livraison et Livrer

- **Fichiers** : `PC` : onglet `livraison` après Fichiers, inséré dans `ONGLETS_FIXES` et `DATA_NODE` (D133) ; `web/src/ecrans/OngletLivraison.tsx` (nouveau) ; `A` : branche Livrer dans `ActionLigne` (D134, insérée) ; tests dans `test/web/panneau-contexte.test.tsx` et `test/web/accueil.test.tsx` (les tests qui comptent les onglets du panneau sont annoncés et mis à jour ici).
- **Vérification** : `npm run gate`

### 27.10 E2E et fiche de recette

- **Fichiers** : `e2e/livraison.spec.ts` : son propre daemon, faux `gh` par `AID_GH_BIN`, faux claude `stream` ; ouvrir la PR, relire, revue absente puis page `review` avec `commit:` (à jour, puis obsolète après un commit poussé : merge bloqué), merge confirmé et `--match-head-commit` au journal, onglet Livraison, Livrer sur l'accueil ; `docs/recette-chantier-27-livraison.md`.
- **Vérification** : `npm run gate` et `npm run gate:e2e`

## 6. Pièges

- **Jamais le vrai `gh`** en test ni en e2e : `AID_GH_BIN` vers `test/fixtures/fake-gh.sh`. La recette réelle se fait sur un dépôt jetable de Julien, jamais sur `aidboard`.
- **Tête courte ou longue** : le frontmatter `commit:` peut être abrégé ; il est résolu par `git rev-parse` dans la route (D125), jamais comparé en texte.
- **`pr.rafraichir` est asynchrone** : l'écran attend l'`ActionRun` qu'il a lancé (son `actionId`), pas « le dernier » d'un autre onglet.
- **Le frontmatter d'une page écrite par un agent** : vérifier en 27.8 que l'outil mémoire du kernel garde `commit:` ; sinon le message demande de l'écrire en tête de corps, et `fraicheurRevue` lit les deux.
- **`test/web/maquette-css.test.ts`** : rien dans `maquette.css`.
- **e2e sur un daemon partagé** (leçon du 25) : la spec lance son propre daemon et ses propres sujets.
- **Daemon de travail de Julien** : des agents y tournent. Aucun redémarrage ni changement d'installation sans son accord.

## 7. Fini quand

- Les points 27.1 à 27.10 sont commités, un par point, `npm run gate` et `npm run gate:e2e` verts.
- La recette de Julien est faite sous Node 22 et 24, et sa fiche est remplie.
- La PR cite la carte du chantier 27 dans le projet 18, si elle existe ; Julien l'a mergée.
