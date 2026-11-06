# Chantier 28 : Boîte de réception, Nouveau sujet et Reprendre

| Champ | Valeur |
|---|---|
| État | **Révision 1, 6 novembre 2026.** Spec validée par Julien le 6 novembre (`specs/boite-nouveau-sujet-reprendre-v1.md`, ses douze recommandations). **Plan validé par Julien le 6 novembre.** Aucune relecture du lab : le chantier ne touche pas au contrat swarph (programme §5 bis). |
| Emplacement final | `docs/chantiers/28-boite-nouveau-sujet-reprendre.md` sur `main`, dans le premier commit du chantier |
| Base | **b972ecd** (`origin/main`, PR #121). Les `fichier:ligne` ont été lus sur cette base. |
| Spec | `docs/fusion-aid-swarph/spec-driven-plan/specs/boite-nouveau-sujet-reprendre-v1.md` (dossier de travail, hors dépôt). Elle adapte les fiches V4 `boite`, `nouveau-sujet` et `reprendre`, plus `regles-globales`. Captures `Boite`, `NouveauSujet` et `NouveauSujet-local`, et l'écran `ecrans/Reprise.html`, dans `design/aid-refonte-review-2026-11-04-v4.zip`. |
| Programme | `docs/fusion-aid-swarph/spec-driven-plan/programme.md`, phase 2 |
| Validation | Julien (interface purement locale, commander 89702). Recette sous Node 22 et 24. |

## 1. Pourquoi

Trois écrans de la V4 répondent chacun à une confusion :

- **la Boîte** mélange aujourd'hui ce qui attend une décision, ce qui se relit et ce qui informe ;
- **Nouveau sujet** crée une branche sans dire avec quel agent ni où vont les données ;
- **Reprendre** désigne trois opérations différentes. Sur un serveur, Reconnecter rattache l'agent ou le relance, selon ce qu'il trouve, sans le dire.

Ce chantier les applique avec les données qu'A-I-D a aujourd'hui. Ce qui demande le board, une carte, les profils ou les agents des serveurs dans l'état attend.

## 2. État actuel

Abréviations : `B` = `web/src/ecrans/Boite.tsx`, `L` = `web/src/ui/Layout.tsx`, `NS` = `web/src/dialogues/NouveauSujet.tsx`, `A` = `web/src/ecrans/Accueil.tsx`, `S` = `web/src/ecrans/Sujet.tsx`, `D` = `web/src/ecrans/Discussion.tsx`, `M` = `src/daemon/pty/manager.ts`, `RA` = `src/daemon/remote/agents.ts`, `RD` = `src/daemon/routes/serverDiscussions.ts`.

| Zone | Où | Ce qui existe |
|---|---|---|
| Groupes de la Boîte | `B:11-17`, `B:409-635` (`Contenu`) | Les agents locaux par ton (attente, erreur, relire, cours, pause), triés par urgence. Filtre par projet |
| Élément d'agent | `B:59-170` (`Article`) | Type, agent, projet / branche, âge, question et options, Reprendre (pause), Ouvrir le terminal |
| DM du mesh | `B:269-343` (`ArticleMesh`), `B:345-407` (`SectionMesh`), `B:187-262` (`OuvrirCell`) | « À traiter » (question, unblock), « Informations », texte brut encadré, Vu, Ouvrir la cell |
| Marque Vu | `src/daemon/mesh/service.ts:121-130`, `src/daemon/routes/mesh.ts:34-40` | `mesh_inbox.seen_at`, écrite en direct, hors journal |
| Migrations | `migrations/` | La dernière est `017_maintenance_secrets.sql` |
| Compteur de la Boîte | `L:74` | `waiting` = agents en `needs_input` |
| Nouveau sujet | `NS`, ouvert par `L:63-69` et `L:179-188` | Dialogue Projet, Ajouter un projet…, Titre, Type, aperçu de branche. `POST /api/topics`, puis la page du sujet. Sans projet, Nouveau projet passe d'abord (`L:61-69`) |
| Création d'un sujet | `src/daemon/routes/topics.ts:113` | `{ workspaceId, title, type, slug? }`, sujet en `draft` jusqu'à la fin de `topic.create` |
| Lancer un agent | `src/daemon/routes/agents.ts:62-69`, `M:456-457` | `{ topicId, kind }`. Le binaire est cherché par `resolveOnPath`, sinon 422 « introuvable dans le PATH du daemon » |
| Options d'un agent | `src/shared/agentSettings.ts:99` (`agentOptions`), `src/daemon/routes/agents.ts:162-170` | Modes, modèles, efforts, par agent existant seulement |
| Reprise locale | `M:601-650` | `streamOrResume` : un agent `stream` repart sous le même id au prochain message, `--resume` s'il a une session. `isResumable` (`web/src/ui/Statut.tsx:17`) : claude ou codex en `stream` |
| Reprise distante | `RA:502-508` (`reconnect`), `RA:515-535` (`reattach`), `RA:697-728` (`relaunchOnce`, `relaunch`), `RD:156-160` | `reconnect` rattache si `relayAlive` répond `vivant`, sinon relance sur la session. La relance arrête d'abord l'ancien relais |
| Sonde du relais | `src/daemon/remote/relay.ts:265-271` (`parseAlive`) | `vivant`, `perdu`, `inconnu`, `fini <code>` |
| Suivi d'un agent distant | `RA:96`, `RA:255-259`, `RA:875-897` | `coupe` ou `echec`, en mémoire, dans la vue de l'agent (`ServerAgent.suivi`) |
| Bandeau de la discussion | `D:93-135` (`BandeauSuivi`), `D:219-240` | Machine injoignable, Session perdue, Suivi coupé. Reconnecter est sur la ligne d'échec du fil (`web/src/conversation/Conversation.tsx:242-260`, `:456`) |
| « Reprendre » | `A:507-518`, `web/src/ecrans/Serveurs.tsx:258-268` | À l'accueil, un lien vers le sujet ; sur Serveurs, vers la discussion |
| Menu ··· du sujet | `S:488-545` | Renommer, Épingler, Archiver, Nettoyer |
| E2E | `e2e/helpers.ts:38-64` | `registerWorkspace` attend le dialogue « Nouveau sujet » ; `createTopic` remplit Titre et clique « Créer le sujet ». 21 specs l'appellent |

## 3. Cible et hors-périmètre

**Cible** : la fiche `boite-nouveau-sujet-reprendre-v1.md`, lignes « Construit », « Construite », « Existe » et « Affichée ».

**Hors-périmètre** (lignes « Plus tard » de la fiche) :
- commandes et accusés, carte offerte, Répondre à un pair, canaux (35, 36) ;
- création depuis une carte ou une issue, champ de démarrage de l'accueil ;
- profils, fournisseurs, plafonds, autre machine que le Mac (29) ;
- demandes des agents de serveur dans la Boîte, transfert d'une discussion de serveur ;
- référence publiée d'une décision.

Aucune lecture ni écriture nouvelle du board, aucune commande swarph. Une seule colonne en base : `mesh_inbox.decided_at` (D137).

## 4. Décisions

| # | Décision | Raison |
|---|---|---|
| **D136** | **Natures de la Boîte**, calculées par `natureDe()` (`web/src/ui/boiteVue.ts`) :<br>• **Décisions** : agent en `needs_input` non suspendu, ou en `idle` sur une question (`statusReason === 'question'`) ; DM mis en décision (D137) ;<br>• **À relire** : agent en `idle`, et agent en `error`, en rouge ;<br>• **Informations** : agent en cours ou en démarrage (« Rien à faire de ton côté »), agent en pause, DM non vus et non mis en décision.<br>Filtres Tout, Décisions, À relire, Informations, avec compteurs ; le filtre par projet reste. Le sous-titre dit « Agents de ce Mac et messages du mesh ». | Q1. Commandes n'apparaît pas sans accusés (35). |
| **D137** | **« En faire une décision »** : `POST /api/mesh/dm/:id/decision` pose `mesh_inbox.decided_at` (migration `018_mesh_decision.sql`), écrite en direct comme Vu (12.4), idempotente. `MeshDm.decidedAt`. Le DM passe en Décisions avec son origine (mesh, expéditeur, âge) et le rappel « Rien n'a été lancé. Un message de pair ne vaut pas autorisation, et sa cell n'a aucun accès à ta machine ni à tes sessions. » Ses actions : Ouvrir la cell, Vu. Vu le retire de la Boîte, comme aujourd'hui. | Q2. |
| **D138** | **Une décision d'agent** montre, en ambre : projet / sujet, l'étape (`topic.phase` quand elle existe), l'agent, « Mac local », l'âge, la question et ses options. **Voir le contexte** ouvre `/sujets/:id?agent=:agentId`. | Q3. Les options et la réponse existent (`B:59-170`). |
| **D139** | **Un tour à relire** montre l'agent, projet / sujet, la première ligne du dernier message (`statusMessage`, 140 caractères au plus) et l'âge. L'action est **Livrer** si la PR du sujet est ouverte (D134), sinon **Relire** (`/sujets/:id?agent=`). Un agent en erreur garde son détail de sortie et « Ouvrir le terminal ». | Fiche, « Tour à relire ». |
| **D140** | **Compteur ambre** de la barre : le nombre de Décisions de D136 (agents et DM), par la même fonction. | Q4. Une seule définition, pour la barre et la Boîte. |
| **D141** | **Nouveau sujet est un écran**, `/sujets/nouveau` (`web/src/ecrans/NouveauSujet.tsx`, data-node `nouveau-sujet.*`), à deux colonnes et un pied fixe. `openNewTopic(workspaceId?)` y navigue (`?projet=`). Sans projet, Nouveau projet s'ouvre d'abord, puis on revient à l'écran. Annuler fait un retour arrière, ou va à l'accueil sans historique. Le dialogue `NS` est supprimé. | Q5. |
| **D142** | **Colonne « Le besoin »** : Projet et « Ajouter un projet… », Type, Titre, « Branche : `<type>/<slug>` », « Base : `<base du projet>` » non modifiable, et l'encart « ○ local · Ce sujet reste sur cette machine. Aucune autre machine ne le retrouvera tant que tu ne l'auras pas publié. » Pas de sélecteur d'origine. | Q6, captures `NouveauSujet-local`. |
| **D143** | **`GET /api/agents/disponibles[?workspaceId=]`** rend, pour `claude` et `codex` : `trouve` (`resolveOnPath`), `version` (`<bin> --version`, 3 s au plus, `null` en cas d'échec) et les options de `agentOptions(kind)`. Avec `workspaceId`, il rend aussi `baseEnRetard` : `git rev-list --count <base>..origin/<base>` dans le dépôt du projet, sans fetch, `null` si `origin/<base>` est inconnu. Lecture seule, à l'ouverture de l'écran et au changement de projet. | Q7, « Vérifié à l'instant ». |
| **D144** | **Colonne « La façon de travailler »** : Agent (claude, codex, aucun ; un agent introuvable est grisé, avec la raison), Modèle (défaut de l'agent, ou un modèle de ses options), Machine « Mac local », Permissions (les modes de l'agent, défaut « Demander avant d'écrire »), Accès « Abonnement · aucun repli payant ». **Vérifié à l'instant** : ✓ « claude détecté, version X », ✕ « codex introuvable dans le PATH du daemon », ! « `main` en retard de N commits sur `origin/main` ». **Phrase de données** (`phraseDonnees()`) : « Le modèle tourne chez Anthropic. Les outils et les fichiers restent sur ce Mac. » (OpenAI pour codex ; rien avec « aucun »). | Q7. Les profils attendent le 29. |
| **D145** | **« Créer et demander un plan »** :<br>1. `POST /api/topics` ;<br>2. l'écran attend que le sujet passe `active` dans l'état, en disant « Création du worktree… » ;<br>3. `POST /api/agents`, puis `PATCH /settings` si le modèle ou le mode diffèrent du défaut, puis `/input` avec `messagePlan()` (`web/src/ui/nouveauSujetVue.ts`) : suivre le rôle `plan` du noyau, écrire `<ns>/plan/<slug>`, ne modifier aucun fichier ;<br>4. l'écran passe sur `/sujets/:id?agent=:agentId`.<br>Si `topic.create` échoue, l'écran passe sur le sujet, qui montre déjà l'échec. Si l'agent ne part pas, le sujet est ouvert et l'erreur est dite sur sa page. Avec « aucun », le bouton dit « Créer le sujet » et fait 1 puis va sur le sujet. Le pied dit « À la création : rien n'est publié. Tu pourras publier plus tard. » | Q8. En PTY, l'agent part, mais le message est tapé dans le terminal (`M`, comme au 27) : accepté. |
| **D146** | **Dialogue Reprendre** (`web/src/dialogues/Reprendre.tsx`, data-node `reprendre.*`). Pour un agent local ou un agent de serveur : un titre selon l'état (« Le suivi de claude est coupé », « La session de claude est perdue », « claude est arrêté »), puis « Que veux-tu retrouver ? ». La **situation** donne l'état du processus, l'âge du dernier événement et « Aucune tâche n'a été relancée ». Viennent ensuite trois options, chacune avec Revient et Ne revient pas, et un bouton principal dont le libellé suit le choix. Les règles sont dans `optionsReprise()` (`web/src/ui/repriseVue.ts`). | Q9, Q10. |
| **D147** | **Disponibilité des options** :<br>• **Reconnecter** : seulement un agent de serveur dont la sonde dit `vivant`. C'est alors l'option par défaut. En local, toujours grisée (« Un agent local ne perd pas son suivi sans s'arrêter »).<br>• **Reprendre la session** : un agent `stream` claude ou codex avec une session (local), ou un agent de serveur avec une session et au moins un tour. **Grisée** si la sonde dit `vivant` (« Le processus répond : le relancer couperait son tour »), si la machine est injoignable, ou sans session (PTY). Par défaut quand Reconnecter ne l'est pas.<br>• **Transférer à un autre agent** : sujets locaux seulement, actif, avec worktree ; jamais pour une discussion de serveur. | Q10. Une coupure ne relance jamais une tâche active. |
| **D148** | **Côté daemon**, cinq routes nouvelles. Rien n'est modifié dans `reconnect`, `send` ni la ligne d'échec existante :<br>• `GET /api/server-agents/:id/processus` → `{ etat: 'vivant'|'arrete'|'injoignable', dernierEvenement }`. Elle passe par `relayAlive` avec une limite de 10 s : `perdu`, `fini` et `inconnu` donnent `arrete`, et un échec SSH donne `injoignable` ;<br>• `POST /api/server-agents/:id/rattacher` : `reattach` seul, 409 si le relais n'est pas vivant ;<br>• `POST /api/server-agents/:id/relancer` : `relaunchOnce` avec `resume: true`, 409 si la sonde dit `vivant`, et 409 sans session ;<br>• `POST /api/agents/:id/reprendre` : `streamOrResume` sans message, 409 si l'agent vit, 409 hors `stream` ;<br>• `GET /api/topics/:id/git/transfert` → `{ branche, base, commits, nonPousses, dirty }`. `commits` : les sujets des commits `origin/<base>..HEAD`, 20 au plus. `nonPousses` : `git rev-list --count origin/<branche>..HEAD`, ou tous les commits depuis la base si `origin/<branche>` n'existe pas. Lecture seule. | Q11, Q12. Séparer ce que `reconnect` fait d'un bloc. `aheadBehind` compte depuis `origin/<base>`, pas les commits non poussés. |
| **D149** | **Transférer** : choix claude ou codex, autre que l'agent d'origine par défaut. Le web arrête l'ancien agent s'il vit (`DELETE /api/agents/:id`), lance le nouveau et lui envoie `messageTransfert()`. Le message donne la branche, la base, les commits depuis la base, la présence de fichiers non commités (à voir par `git status`), les slugs des pages plan et passation du sujet quand elles existent, et « La conversation de l'agent précédent ne te suit pas ». Puis le dialogue ouvre le sujet sur le nouvel agent. **Alerte**, seulement avec Transférer :<br>• « N commits non poussés » avec « Pousser d'abord » (`git.pousser`) si `nonPousses > 0` (`git/transfert`) ;<br>• « Des fichiers ne sont pas commités : le nouvel agent les verra, sans leur raison. » si `dirty`.<br>Rien ne bloque. | Q12. |
| **D150** | **Entrées du dialogue** :<br>• à l'accueil, Reprendre l'ouvre quand l'agent le plus urgent du sujet ne vit plus (arrêté, en veille, en erreur), sinon le lien d'aujourd'hui ;<br>• dans le menu ··· du sujet, « Reprendre… », quand un agent du sujet ne vit plus. Le choix de l'agent : celui de l'onglet ouvert, sinon le plus récent ;<br>• dans le bandeau Suivi coupé ou Session perdue d'une discussion, un bouton « Reprendre… » ;<br>• sur Serveurs, Reprendre l'ouvre quand l'agent de la discussion a un suivi coupé ou en échec, sinon il ouvre la discussion.<br>Reconnecter sur la ligne d'échec reste tel quel. | Q9. |

## 5. Points

Chaque point est un commit, gate vert. Les lignes existantes modifiées sont comptées dans le message de commit. Les styles nouveaux vont dans `web/src/styles/boite.css`, `nouveau-sujet.css` et `reprendre.css` (nouveaux), jamais dans `maquette.css`.

### 28.1 Le plan, et les règles des trois écrans

- **Fichiers** : ce plan ; trois modules de fonctions pures, avec leurs tests `test/web/boite-vue.test.ts`, `test/web/nouveau-sujet-vue.test.ts` et `test/web/reprise-vue.test.ts` :
  - `web/src/ui/boiteVue.ts` : `natureDe`, `compterNatures`, `decisionsEnAttente` (D136, D140) ;
  - `web/src/ui/nouveauSujetVue.ts` : `phraseDonnees`, `verifications`, `messagePlan` (D144, D145) ;
  - `web/src/ui/repriseVue.ts` : `optionsReprise`, `titreReprise`, `REVIENT`, `alerteTransfert`, `messageTransfert` (D146, D147, D149).
- **Vérification** : `npm run gate`

### 28.2 Mettre un DM en décision

- **Fichiers** :
  - `migrations/018_mesh_decision.sql` ;
  - `src/shared/model.ts` : `MeshDm.decidedAt`, inséré ;
  - `src/daemon/mesh/service.ts` : `markDecision`, inséré, et `decidedAt` dans `inbox()` (1 ligne ajoutée) ;
  - `src/daemon/routes/mesh.ts` : la route, insérée ;
  - tests dans `test/mesh-service.test.ts` et `test/mesh-routes.test.ts` : idempotence, 404, DM vu ensuite. Les attentes qui listent un `MeshDm` complet gagnent `decidedAt: null`, et ces lignes sont comptées.
- **Vérification** : `npm run gate`

### 28.3 La Boîte par nature

- **Fichiers** :
  - `B` : filtres par nature avec compteurs, sections Décisions (agents et DM, D137, D138), À relire (D139) et Informations ; « En faire une décision » sur un DM, « Voir le contexte » ;
  - `L:74` : le compteur passe par `decisionsEnAttente` (D140, 1 ligne modifiée) ;
  - `web/src/styles/boite.css` ;
  - `test/web/boite.test.tsx` : les tests existants qui comptent les groupes par ton sont annoncés et mis à jour ici.
- **Vérification** : `npm run gate`

### 28.4 Les agents disponibles

- **Fichiers** :
  - `src/shared/model.ts` : `AgentsDisponibles` ;
  - `src/daemon/routes/agents.ts` : `GET /api/agents/disponibles`, inséré (D143) ;
  - `test/fixtures/bin-stream/claude` et `codex` : `--version` rend une version synthétique (insertion) ;
  - `test/agents-disponibles.test.ts` : trouvé, introuvable, version en échec, base en retard sur un dépôt temporaire avec origine.
- **Vérification** : `npm run gate`

### 28.5 L'écran Nouveau sujet : le besoin

- **Fichiers** :
  - `web/src/App.tsx` : la route, insérée **avant** `/sujets/:topicId` ;
  - `web/src/ecrans/NouveauSujet.tsx` (nouveau) : colonne « Le besoin » (D142), pied avec Annuler et « Créer le sujet » ;
  - `L` : `openNewTopic` navigue, l'enchaînement Nouveau projet → écran est gardé, le rendu du dialogue est retiré (lignes modifiées comptées) ;
  - `NS` supprimé ;
  - `e2e/helpers.ts` : `registerWorkspace` attend l'écran, `createTopic` y remplit le titre (lignes modifiées comptées, les 21 specs inchangées) ;
  - `web/src/styles/nouveau-sujet.css` ;
  - `test/web/nouveau-sujet.test.tsx` (nouveau). Les tests web qui ouvraient le dialogue sont annoncés et suivis.
- **Vérification** : `npm run gate`, puis `npm run gate:e2e` (le helper change)

### 28.6 La façon de travailler, et Créer et demander un plan

- **Fichiers** :
  - `NouveauSujet.tsx` : la seconde colonne (D144) par `/api/agents/disponibles`, et le parcours de D145 avec son état « Création du worktree… » ;
  - tests : agent introuvable grisé, modèle et mode envoyés, message envoyé, navigation, échec de création, « aucun agent ».
- **Vérification** : `npm run gate`

### 28.7 La reprise côté daemon

- **Fichiers** :
  - `RA` : `processus`, et `rattacher` et `relancer` publics (insertions ; `reattach` et `relaunchOnce` réutilisés tels quels) ;
  - `RD` : trois routes, insérées ;
  - `M` : `reprendre(agentId)`, inséré, et sa route dans `src/daemon/routes/agents.ts` (D148) ;
  - `src/daemon/git/inspect.ts` : `gitTransfert`, inséré, et `GET /api/topics/:id/git/transfert` dans `src/daemon/routes/topics.ts` (D148) ;
  - tests ajoutés dans `test/server-discussions.test.ts` (faux relais : vivant, perdu, injoignable, 409 sur relance d'un vivant) et `test/agent-stream.test.ts` (reprise sans message, 409 vivant, 409 PTY). Les cas existants de `reconnect` restent inchangés.
- **Vérification** : `npm run gate`

### 28.8 Le dialogue Reprendre

- **Fichiers** :
  - `web/src/dialogues/Reprendre.tsx` (nouveau) : situation, sonde à l'ouverture et « Vérifier à nouveau », trois options, Revient et Ne revient pas, bouton principal (D146, D147) ;
  - `web/src/data/reprise.ts` (nouveau) ;
  - `web/src/styles/reprendre.css` ;
  - `test/web/reprendre.test.tsx` : local en veille, serveur vivant (Reconnecter par défaut, reprise grisée), serveur arrêté, injoignable.
- **Vérification** : `npm run gate`

### 28.9 Transférer à un autre agent

- **Fichiers** :
  - `Reprendre.tsx` : choix de l'agent, alerte et « Pousser d'abord » (D149), arrêt de l'ancien agent, lancement, message, navigation ;
  - tests.
- **Vérification** : `npm run gate`

### 28.10 Les entrées de Reprendre

- **Fichiers** :
  - `A:507-518` : Reprendre ouvre le dialogue selon D150 (lignes modifiées comptées) ;
  - `S:488-545` : « Reprendre… » dans le menu ···, inséré ;
  - `D:113-135` : « Reprendre… » dans les deux bandeaux (insertion dans `BandeauSuivi`) ;
  - `web/src/ecrans/Serveurs.tsx:258-268` : selon le suivi (lignes modifiées comptées) ;
  - tests dans `test/web/accueil.test.tsx`, `test/web/sujet-entete.test.tsx`, `test/web/discussion.test.tsx` et `test/web/serveurs.test.tsx`.
- **Vérification** : `npm run gate`

### 28.11 E2E et fiche de recette

- **Fichiers** :
  - `e2e/boite-nouveau-sujet-reprendre.spec.ts` : son propre daemon, en `stream`, devant les faux claude et codex. Il déroule :
    - Nouveau sujet par l'écran, avec claude, puis le message de plan au fil ;
    - « aucun agent » ;
    - la Boîte : une question du faux claude en Décisions, Voir le contexte, le tour terminé en À relire, les compteurs et le compteur de la barre ;
    - un agent arrêté, puis Reprendre à l'accueil : Reprendre la session, puis Transférer à codex avec l'alerte des fichiers non commités.
  - `docs/recette-chantier-28-boite-nouveau-sujet-reprendre.md` : la recette réelle couvre aussi un agent de serveur (suivi coupé, Reconnecter ; session perdue, Reprendre la session) et un DM du mesh mis en décision.
- **Vérification** : `npm run gate` et `npm run gate:e2e`

## 6. Pièges

- **`/sujets/nouveau` avant `/sujets/:topicId`** : sinon « nouveau » se lit comme un id de sujet.
- **Le helper e2e** : 21 specs créent leurs sujets par `createTopic`. Il change en 28.5, avec `gate:e2e` dans ce point et non seulement à la fin.
- **La sonde coûte un aller-retour SSH** : seulement à l'ouverture du dialogue et sur « Vérifier à nouveau », jamais en tâche de fond. Une relance n'est jamais lancée sans une sonde qui l'autorise (D148).
- **Relancer arrête l'ancien relais** (`RA:710-716`) : c'est pourquoi `relancer` refuse un relais vivant côté serveur, et pas seulement à l'écran.
- **`--version` d'un binaire qui ne répond pas** : limite de 3 s, `version: null`, et l'agent reste proposé s'il est trouvé.
- **Un DM reste une donnée d'un pair** même mis en décision : texte brut encadré, jamais rendu en Markdown ni envoyé à un agent.
- **`test/web/maquette-css.test.ts`** : rien dans `maquette.css`.
- **e2e sur un daemon partagé** (leçon du 25) : la spec lance son propre daemon et ses propres sujets.
- **Jamais le vrai claude ni le vrai codex** en test ou en e2e : `test/fixtures/bin-stream`.
- **Daemon de travail de Julien** : des agents y tournent. Aucun redémarrage ni changement d'installation sans son accord.

## 7. Fini quand

- Les points 28.1 à 28.11 sont commités, un par point, `npm run gate` vert sur chacun, et `npm run gate:e2e` vert en 28.5 et 28.11.
- La recette de Julien est faite sous Node 22 et 24, et sa fiche est remplie.
- Julien a mergé la PR.
