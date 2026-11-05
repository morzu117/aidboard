# Chantier 26 : écran Sujet

| Champ | Valeur |
|---|---|
| État | **Révision 1, 5 novembre 2026.** Spec validée par Julien le 5 novembre (`specs/sujet-v1.md`, ses six recommandations, « hors chaîne » et « Interrompre »). **Plan validé par Julien le 5 novembre.** Aucune relecture du lab : le chantier ne touche pas au contrat swarph (programme §5 bis). |
| Emplacement final | `docs/chantiers/26-ecran-sujet.md` sur `main`, dans le premier commit du chantier |
| Base | **1587295** (`origin/main`, PR #119). Les `fichier:ligne` ont été lus sur cette base. |
| Spec | `docs/fusion-aid-swarph/spec-driven-plan/specs/sujet-v1.md` (dossier de travail, hors dépôt), qui adapte la fiche V4 `sujet` et `regles-globales`. Captures `Main`, `Main-profil`, `Main-git`, `Main-fichiers`, `Main-livraison` dans `design/aid-refonte-review-2026-11-04-v4.zip`. |
| Programme | `docs/fusion-aid-swarph/spec-driven-plan/programme.md`, phase 2 |
| Validation | Julien (interface purement locale, commander 89702). Recette sous Node 22 et 24. |

## 1. Pourquoi

La V4 veut qu'on sache où en est un sujet sans relire la conversation : un en-tête qui dit l'étape et ce qui attend, des onglets d'agents qui disent leur état en mots, un panneau qui commence par le sujet. L'écran actuel a déjà la conversation, les repères, le composer, Git et Fichiers (chantiers 15, 16). Ce chantier réarrange l'écran et complète ce qui a une source aujourd'hui ; tout ce qui demande une carte liée attend.

## 2. État actuel

Abréviations : `S` = `web/src/ecrans/Sujet.tsx`, `PC` = `web/src/ecrans/PanneauContexte.tsx`, `CV` = `web/src/conversation/`.

| Zone | Où | Ce qui existe |
|---|---|---|
| En-tête | `S:405-528` | Fil d'Ariane `projet / sujet` (`:408`) ; titre `topic.title` (`:419`) ; Ouvrir dans l'éditeur (`:424`) ; menu ··· : Nettoyer le sujet, Copier le chemin du worktree (`:434-490`) ; pastilles état (`:494`), branche avec sélecteur (`:501`), base, index (`:519-527`) |
| Nom affiché | `NavPlacement.displayName` (`src/shared/model.ts:235`), `PATCH /api/nav/placements/:topicId` (`src/daemon/routes/nav.ts:254`) ; cache de module de la barre `navCache` (`web/src/ui/Nav.tsx:46`), `getNavCacheSnapshot` (`:54`), `patchPlacement` (`:243-258`) | La barre lit `displayName ?? branch` ; l'en-tête ne lit pas `displayName`. Renommer, épingler, masquer, archiver : menu de la barre seulement (`Nav.tsx:547-582`) |
| Phase | `Topic.phase` (`model.ts:5` : `plan`, `dev`, `review`, `triage`, `retro`), événement `topic.phase` (`src/daemon/events/projectors.ts:91`), `PHASES` (`web/src/ui/rangement.ts:40`) | Aucun rendu sur l'écran Sujet |
| Prochaine chose | `prochaineChose()` (`rangement.ts:49`) | Rendue sur l'accueil seulement (25) |
| Onglets d'agents | `S:722-778` ; `agentView()` (`web/src/ui/Statut.tsx:25-53`) ; `roleLabel` (`web/src/ui/roles.ts:3-9`) | Type, puis le rôle, ou le statut pour un agent `free` (`S:751`) : « En cours », « Attend une réponse », « À relire », « En veille »… ; + Agent (`S:756`), Arrêter en deux temps (`S:782-823`) |
| Fil | `CV/Message.tsx:68-84`, `CV/ToolCallGroup.tsx:37`, `CV/DecisionCard.tsx:50` | En-tête d'une réponse : type, serveur (discussion distante seulement), heure |
| Zone de saisie | `CV/Composer.tsx` (props `:31-50`, commandes `/` `:64-88`, `:242-308`, Arrêter qui interrompt le tour `:362-372`) ; `CV/ComposerReglages.tsx` (chips mode `:162-172`, modèle `:173-183`) ; `MODES` (`src/shared/agentSettings.ts:78-89`) | Chip mode « ▸▸ Demander / Modifs auto / Auto / Plan » ; chip modèle et effort. Aucun `@` |
| Fichiers du worktree | `GET /api/topics/:id/files` (`src/daemon/routes/files.ts:127`, arbre avec budget et `truncated`) | Utilisé par l'onglet Fichiers seulement |
| Panneau | `PC:8-40` | Onglets Plan, Git, Fichiers, puis Revue, Rétro, Passation si leur page mémoire existe ; Plan = page mémoire `plan` en markdown (`PC:171-178`) |
| Onglet Fichiers | `web/src/ecrans/OngletFichiers.tsx` (data-node `3-4.*`, `:220-423`) | Pas d'état de l'index |

## 3. Cible et hors-périmètre

**Cible** : la fiche `sujet-v1.md`, lignes « Construit », « Complété », « Renommé », « Partiel » et « Gardé ».

**Hors-périmètre** (lignes « Plus tard » de la fiche) : mesh, carte et publication dans le fil d'Ariane ; Reprendre (28) ; Conduite ; préréglages, fournisseur, accès et limites du profil (29) ; séparateur d'étape et tentative ; référence, effet et états de publication d'une décision ; objectif, critères, plan en étapes, bloc board et « ce qui fait foi » ; onglet Livraison (27) ; « + Agent » limité à ce qui est installé. Aucune lecture ni écriture nouvelle du board, aucune commande swarph nouvelle, aucune colonne en base.

## 4. Décisions

| # | Décision | Raison |
|---|---|---|
| **D111** | Le titre de l'en-tête est `displayName ?? title`. Le nom affiché vient du cache de module de la barre ; `Nav.tsx` gagne `ecouterPlacementsNav` et `annoncerPlacementNav`, sur le modèle de `annoncerPrefsNav` (25) : un renommage fait dans l'en-tête atteint la barre affichée, et inversement. Si le cache est vide (premier écran ouvert), l'en-tête lit `GET /api/nav` une fois. | Un seul nom affiché. Pas de second magasin, pas de second abonnement à `/api/nav`. |
| **D112** | Le menu ··· gagne Renommer (le titre devient un champ, Entrée enregistre, Échap annule, vide revient au titre), Épingler / Désépingler, Archiver / Désarchiver. Archiver = `placement.archived`, comme dans la barre. Nettoyer le sujet et Copier le chemin restent. Tous passent par `PATCH /api/nav/placements/:topicId`. | Choix de Julien (Q6). Aucune route nouvelle. |
| **D113** | Barre d'étapes : cinq segments, un par phase dans l'ordre `PHASES`. Fait avant la phase courante, en cours sur elle (ambre si une décision attend, bleu sinon), à venir après. Ligne : « Phase 2 sur 5 · Dév ». Rien quand `phase` est vide. La barre est décorative (`aria-hidden`), la ligne porte l'information. | Choix de Julien (Q1). Les étapes d'une carte la remplaceront. |
| **D114** | Prochaine chose dans l'en-tête : `prochaineChose()` de D108, ambre si une question attend (`pending`). | Même règle que l'accueil. |
| **D115** | État d'un onglet d'agent en texte, par une fonction `etatOnglet(agent)` : « au travail » (`working`, `starting`), « attend ta réponse » (`needs_input`, ou `idle` sur une question), « libre » (`idle`), « en pause », « erreur », « en veille », « arrêté ». Le rôle reste affiché en second pour un agent de la chaîne ; `roleLabel('free')` devient « hors chaîne » et n'est plus affiché dans l'onglet. `agentView()` ne change pas : l'accueil, la barre et la Boîte la gardent. | V4. Deux « libre » levés (choix de Julien). |
| **D116** | L'« Arrêter » du composer devient « Interrompre » ; son `data-node` (`.arreter`) ne change pas. | Choix de Julien : un mot par action. |
| **D117** | Le chip de mode devient « Permissions » : libellés de `MODES` « Demander avant d'écrire » (`default`), « Modifier sans demander » (`acceptEdits`), « Tout accepter » (`auto`), « Plan seulement » (`plan`) ; codex garde ses deux modes, mêmes libellés. Les valeurs et `/mode` ne changent pas. Le chip modèle devient « Profil » : `kind · modèle · effort · Mac local`, il ouvre le même menu. | Choix de Julien (Q2, Q3). Aucun réglage nouveau. |
| **D118** | `@` dans le champ ouvre la liste des fichiers du worktree, filtrée par la saisie, comme le menu `/` ; Entrée ou clic insère `@chemin`. La liste vient d'un seul `GET /api/topics/:id/files?scope=tout` par ouverture du menu, aplatie côté client ; si l'arbre est tronqué, la liste le dit. `Composer` gagne une prop optionnelle `topicId` : sans elle (discussion de serveur), pas de menu `@`. | La source existe ; la discussion de serveur n'a pas de worktree local. |
| **D119** | Panneau : l'onglet Plan s'appelle **Sujet**. Il montre d'abord « Prochaine décision » (la question en attente la plus urgente, ambre, avec « Voir la question », qui sélectionne l'onglet de cet agent), puis le plan tel qu'aujourd'hui. Son id interne et son `data-node` `1-3.onglets.plan` ne changent pas. L'état de l'index passe de l'en-tête (`1-3.entete.index`) en tête de l'onglet Fichiers (`3-4.index`). | Choix de Julien (Q4 : Livraison avec le 27). Garder `plan` évite de réécrire les tests ; l'index est un état des fichiers, pas du sujet. |
| **D120** | « Mac local » dans l'en-tête d'une réponse d'agent quand il n'y a pas de serveur. | Un agent de sujet tourne toujours sur le Mac. |

## 5. Points

Chaque point est un commit, gate vert. Les lignes existantes modifiées sont comptées dans le message de commit. Les styles nouveaux vont dans `web/src/styles/sujet.css` (nouveau), jamais dans `maquette.css`.

### 26.1 Le plan, et les règles de l'écran

- **Fichiers** : ce plan ; `web/src/ui/sujetVue.ts` (nouveau) : `etatOnglet` (D115), `etapesPhase` (D113) ; `test/web/sujet-vue.test.ts`.
- **Vérification** : `npm run gate`

### 26.2 Le nom affiché partagé

- **Fichiers** : `web/src/ui/Nav.tsx` : `ecouterPlacementsNav`, `annoncerPlacementNav`, et `patchPlacement` annonce son changement (quelques lignes modifiées) ; `S` : le titre lit `displayName ?? title` (1 ligne modifiée) ; tests dans `test/web/sujet.test.tsx` et `test/web/nav.test.tsx`.
- **Vérification** : `npm run gate`

### 26.3 Le menu ··· complété

- **Fichiers** : `S` : Renommer en place, Épingler, Archiver (D112) ; tests.
- **Vérification** : `npm run gate`

### 26.4 Barre d'étapes et prochaine chose

- **Fichiers** : `S` (sous les chips Git) ; `web/src/styles/sujet.css` ; tests (phase vide, phase courante, ambre sur une question).
- **Vérification** : `npm run gate`

### 26.5 Onglets d'agents

- **Fichiers** : `S:722-755` : état en texte (`1-3.terminaux.onglet-N.etat`), rôle seulement pour la chaîne (`S:751` modifiée) ; `roles.ts` (1 ligne) ; onglet actif souligné en menthe ; tests existants qui lisent `.role` d'un agent `free` mis à jour.
- **Vérification** : `npm run gate`

### 26.6 « Mac local » dans le fil

- **Fichiers** : `CV/Message.tsx:73` ; `test/web/conversation.test.tsx`.
- **Vérification** : `npm run gate`

### 26.7 Permissions, Profil, Interrompre

- **Fichiers** : `src/shared/agentSettings.ts:78-89` (libellés) ; `CV/ComposerReglages.tsx:162-183` ; `CV/Composer.tsx:371` ; tests qui lisent « Mode : », « Demander », « Modifs auto » ou l'« Arrêter » du composer (`commandes.test.ts`, `conversation.test.tsx`, `sujet.test.tsx`, `e2e/commandes-slash.spec.ts`, `e2e/cell-swairm.spec.ts`) mis à jour.
- **Vérification** : `npm run gate`, `npm run gate:e2e`

### 26.8 `@` fichier

- **Fichiers** : `CV/Composer.tsx` (prop `topicId`, menu `@`) ; `web/src/conversation/fichiersMention.ts` (nouveau : aplatir, filtrer) ; `S` passe `topicId` ; tests.
- **Vérification** : `npm run gate`

### 26.9 Panneau : onglet Sujet, index dans Fichiers

- **Fichiers** : `PC:10-14` (libellé), contenu de l'onglet (D119) ; `S:519-527` retiré de l'en-tête ; `OngletFichiers.tsx` (en tête) ; `test/web/panneau-contexte.test.tsx`, `test/web/sujet.test.tsx` et `e2e/repli-index.spec.ts`, qui lisent `1-3.entete.index`, mis à jour.
- **Vérification** : `npm run gate`, `npm run gate:e2e`

### 26.10 E2E et fiche de recette

- **Fichiers** : `e2e/sujet.spec.ts` (nouveau) : renommer depuis l'en-tête et le voir dans la barre, épingler, archiver ; état des onglets ; Interrompre ; `@` insère un chemin ; onglet Sujet avec la prochaine décision ; index dans Fichiers. `docs/recette-chantier-26-sujet.md` (nouveau).
- **Recette de Julien** : sous Node 22 et 24, sur une instance à part. Rien n'est lancé sur le daemon de travail sans son accord.
- **Vérification** : `npm run gate:e2e`, la fiche remplie, citée dans la PR.

## 6. Pièges

- **`test/web/maquette-css.test.ts`** : rien dans `maquette.css`.
- **`data-node` épinglés** : `1-3.entete.titre` est lu par quatre tests web, `e2e/pilotage.spec.ts` et `e2e/helpers.ts` : il ne change pas, seul son texte suit D111. `1-3.onglets.plan` et `.arreter` gardent leur nom (D116, D119). `1-3.entete.index` disparaît : ses tests sont annoncés en 26.9.
- **e2e sur un daemon partagé** (leçon du 25) : chaque épreuve lit son propre sujet, et rien ne laisse un état qui gêne une spec suivante dans l'ordre alphabétique (un sujet archivé ou renommé est le sien).
- **Deux sujets de nom** : la barre retombe sur la branche, l'en-tête sur le titre. D111 ne change pas ces replis, seulement la source du nom affiché.
- **`agentView()`** est utilisée par l'accueil, la barre et la Boîte : D115 ajoute une fonction, elle ne la modifie pas.
- **Composer partagé** avec la discussion de serveur : `topicId` optionnel, aucun changement de comportement sans lui ; « Mac local » seulement sans serveur.
- **Daemon de travail de Julien** : des agents y tournent. Aucun redémarrage ni changement d'installation sans son accord.

## 7. Fini quand

- Les points 26.1 à 26.10 sont commités, un par point, `npm run gate` et `npm run gate:e2e` verts.
- La recette de Julien est faite sous Node 22 et 24, et sa fiche est remplie.
- La PR cite la carte du chantier 26 dans le projet 18, si elle existe ; Julien l'a mergée.
