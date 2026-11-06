# Chantier 29 : Machines et moteurs

| Champ | Valeur |
|---|---|
| État | **Révision 1, 6 novembre 2026.** Spec validée par Julien le 6 novembre (`specs/machines-v1.md`, ses dix recommandations). **Plan validé par Julien le 6 novembre**, avec consigne d'enchaîner le build en autonomie. Aucune relecture du lab : le chantier ne touche pas au contrat swarph (programme §5 bis). |
| Emplacement final | `docs/chantiers/29-machines.md` sur `main`, dans le premier commit du chantier |
| Base | **e1f109d** (`origin/main`, PR #122). Les `fichier:ligne` ont été lus sur cette base. |
| Spec | `docs/fusion-aid-swarph/spec-driven-plan/specs/machines-v1.md` (dossier de travail, hors dépôt). Elle adapte la fiche V4 `machines`, plus `regles-globales`. Capture `Machines` et `ecrans/Machines.html` dans `design/aid-refonte-review-2026-11-04-v4.zip`. La fiche V4 le dit : sa matrice, l'iPad, OpenRouter et les latences sont illustratifs. |
| Programme | `docs/fusion-aid-swarph/spec-driven-plan/programme.md`, phase 2 |
| Validation | Julien (interface purement locale). Recette sous Node 22 et 24. |

## 1. Pourquoi

Aujourd'hui, « connecté » est la seule chose qu'A-I-D dit d'une machine. Il ne dit ni quels agents y tournent, ni ce qu'ils savent faire depuis le cockpit, ni par quel accès ils parlent au modèle, ni si une clé traîne en clair. La fiche V4 `machines` répond à ces quatre questions sur un seul écran.

Ce chantier l'applique avec les données qu'A-I-D a aujourd'hui. Le mode host et les appareils attendent le 31 ; les fournisseurs qu'aucun agent d'A-I-D n'utilise ne sont pas dessinés.

## 2. État actuel

Abréviations : `SV` = `web/src/ecrans/Serveurs.tsx`, `B` = `web/src/ui/Barre.tsx`, `CX` = `src/daemon/remote/connection.ts`, `RA` = `src/daemon/remote/agents.ts`, `CF` = `src/daemon/config.ts`, `DP` = `src/daemon/pty/disponibles.ts`, `CO` = `web/src/conversation/Composer.tsx`, `AS` = `src/shared/agentSettings.ts`.

| Zone | Où | Ce qui existe |
|---|---|---|
| Barre du haut | `B:61-66`, `B:146` | Accueil, Boîte, Consignes, Serveurs, Réglages. Actif si `pathname === to` |
| Écran Serveurs | `SV:34` (`Carte`), `SV:302` (`Contenu`) | Une carte par serveur : état, latence, discussions, Nouvelle discussion, Configurer |
| Test de connexion | `CX:42-48` (`STEP_LABELS`), `CX:183-211` (`startTest`), `CX:280-397` (`runTest`) | Cinq étapes, en tâche de fond, progression en `server.test`. Enregistre `detected_agents` et `last_test_at`. Aucune promesse de fin exposée |
| Commandes distantes | `CX:223` (`read`) | Une commande, une coupure marque le serveur injoignable et lève 502 |
| Agents du Mac | `DP` (`agentsDisponibles`), `GET /api/agents/disponibles` | claude et codex : trouvé, version (3 s), options |
| Capacités dispersées | `AS:72` (`REMOTE_CONTROL`), `CO:69-70` (`joindre`), `src/daemon/conversation/driver.ts` (`INLINE_IMAGE_TYPES`) | Remote : claude seul. Pièces jointes : agent `stream`, pas sur un serveur. Efforts : selon les options du modèle |
| Transport local | `CF` (`agents.transport`) | `pty` ou `stream` |
| Accès aux modèles | `CF` (`env.strip`) | `ANTHROPIC_API_KEY` et `ANTHROPIC_AUTH_TOKEN` retirées de l'environnement des agents |
| Recherche mémoire | `CF:29`, `CF:71` | `memory.embeddings.provider` : `ollama` par défaut, ou `off` |
| Mémoire libre | — | Rien |
| Migrations | `migrations/` | La dernière est `018_mesh_decision.sql` |

## 3. Cible et hors-périmètre

**Cible** : la fiche `machines-v1.md`, lignes « Construit », « Construite », « Existe ».

**Hors-périmètre** :
- mode host, appareils, QR, révocation, Couper tous les accès (31), app mobile (32) ;
- profils de travail ;
- fournisseurs qu'aucun agent d'A-I-D n'utilise (OpenRouter, Ollama pour un agent, clé ajoutée à la main) ;
- afficher la consommation d'un tour ;
- déplacer une clé vers le trousseau à la place de l'utilisateur.

Aucune lecture ni écriture du board, aucune commande swarph. Une table nouvelle : `server_diagnostics` (D155).

## 4. Décisions

| # | Décision | Raison |
|---|---|---|
| **D151** | **Écran `/machines`** (`web/src/ecrans/Machines.tsx`, data-node `machines.*`). L'entrée « Machines » remplace « Serveurs » dans la barre du haut ; elle est active sur `/machines` et sur `/serveurs…`. L'écran Serveurs reste à `/serveurs`, inchangé. « Ajouter une machine » ouvre `/serveurs/nouveau`. La palette garde « Serveurs » et gagne « Machines ». | Q1. |
| **D152** | **Ton cockpit** : la pilule « Mode host inactif », neutre ; la phrase « Ce cockpit n'écoute que sur ce Mac (127.0.0.1). Les autres appareils viendront avec le mode host. » ; une ligne « Mac local · ici · Héberge le cockpit ». Aucun bouton. | Q2. |
| **D153** | **Table des capacités** (`src/shared/capacites.ts`), seule source de ce qu'une combinaison sait faire. Huit capacités : `outils`, `images`, `approbations`, `interruption`, `reprise`, `effort`, `distant`, `conso`. `capacitesDe(kind, lieu)` avec `lieu = { machine: 'mac' | 'serveur', transport: 'stream' | 'pty' }` (un serveur est toujours en `stream`) :<br>• `stream` : outils, approbations, interruption et reprise vraies ; images sur le Mac seulement ; effort si `agentOptions(kind)` annonce des efforts (ou un de ses modèles) ; distant = `REMOTE_CONTROL[kind]` ; conso fausse ;<br>• `pty` : outils, approbations et interruption vraies (dans le terminal), le reste faux.<br>Le composer lit `images` pour le trombone (`CO:70`). Un test confronte la table à `REMOTE_CONTROL`, `INLINE_IMAGE_TYPES` et aux options. | Q6, règle « Une capacité absente n'est jamais proposée ailleurs ». |
| **D154** | **Diagnostic du Mac** : `GET /api/machines/local` → `{ agents (D143), transport, memoire, mesureA }`, calculé à chaque appel (l'ouverture de l'écran et Diagnostiquer). Lecture seule : `--version` (3 s) et la mémoire. | Q4, Q10. |
| **D155** | **Diagnostic d'un serveur** : `POST /api/machines/serveurs/:id/diagnostic` lance le test de connexion existant (`startTest`) et attend sa fin, puis, si l'étape `shell` est passée, une seule commande distante (`read`) qui rend la version de chaque agent trouvé et la mémoire disponible. Résultat enregistré dans `server_diagnostics` (`migration 019_server_diagnostics.sql` : `server_id` clé, `versions` JSON, `memory_bytes`, `measured_at`, supprimé avec le serveur). Rend `{ test, versions, memoire, mesureA }`. `GET /api/machines/serveurs` rend, par serveur, le dernier diagnostic enregistré et le dernier test en mémoire. `CX` gagne `testFini(serverId)` (la promesse du test en cours, ou du dernier). | Q4. Le test et ses étapes restent ceux de la configuration : un seul test, pas deux. |
| **D156** | **Mémoire disponible** (`src/daemon/machines/memoire.ts`) : sur macOS, `vm_stat` (pages libres, inactives et spéculatives, fois la taille de page lue dans l’en-tête) ; sur Linux, `MemAvailable` de `/proc/meminfo`. Une commande distante essaie l'une puis l'autre. Rendu en octets, affiché en Go à une décimale, avec l'heure. Une sortie illisible donne `null`, affiché « [non mesuré] ». | Q5. `os.freemem()` sous-estime sur macOS. |
| **D157** | **Cartes de machine** : une pour le Mac, une par serveur, dans cet ordre. Nom ; état (Mac : « Disponible » ; serveur : l'état connu, avec la latence) ; « N sessions actives » (Mac : agents claude et codex vivants dans l'état ; serveur : `agents.vivants`). Quatre cases :<br>• **Accès** : « daemon local » ; « alias SSH `<cible>` » ou « SSH `<cible>` » ;<br>• **Agents** : les agents trouvés, avec leur version ; « Aucun agent » ; « Jamais diagnostiqué » ;<br>• **Reprise** : Mac `stream` « session persistante », Mac `pty` « sans reprise » ; serveur « session persistante » si tmux est passé, sinon « sans tmux » ;<br>• **Mémoire libre** : D156, ou « [non mesuré] ».<br>Actions : Diagnostiquer, et pour un serveur Configurer et Ouvrir une discussion. Le diagnostic en cours dit « Diagnostic… » ; en échec, la carte dit l'étape et sa raison. | Q3, Q4. |
| **D158** | **Combinaisons disponibles** (`combinaisons()` dans `web/src/ui/machinesVue.ts`) : une ligne par agent piloté (claude, codex) sur chaque machine, plus cursor là où il a été trouvé (Mac : `trouve` ; serveur : `detectedAgents`). Colonnes : agent, modèle (« Par défaut »), fournisseur (« Anthropic » pour claude, « OpenAI » pour codex), accès (« Abonnement · CLI », ou D159), machine, les huit capacités, l'état. Marques : ✓ capacité vraie et machine diagnostiquée avec l'agent trouvé ; ? capacité vraie et machine jamais diagnostiquée (`detectedAgents` à `null`) ; – capacité fausse. État : **Prêt** (aucune –, `conso` exceptée), **Prêt, limité** (au moins une –, `conso` exceptée), **À tester** (au moins un ?), **Agent non détecté** (l'agent manque au dernier diagnostic de la machine, tout en –). cursor trouvé : une ligne « Détecté, non piloté par A-I-D », tout en –. Filtres : Toutes, Mac local, puis un par serveur. | Q6, Q7. |
| **D159** | **Fournisseurs** : `GET /api/machines/fournisseurs` (`src/daemon/machines/fournisseurs.ts`) → `{ fournisseurs, alertes }`, calculé sur l'environnement du daemon et l'existence de fichiers, **sans jamais lire une valeur** :<br>• **Anthropic · claude CLI** : sans clé dans l'environnement, « Abonnement · identifiants gérés par le CLI » ; avec une clé retirée par `env.strip`, « Abonnement · repli désactivé : la clé de l'environnement n'est pas transmise » ; avec une clé transmise, « Clé API · facturation à l'usage », en ambre ;<br>• **OpenAI · codex CLI** : « Identifiants gérés par le CLI » ; avec `OPENAI_API_KEY` transmise, « Clé API présente · facturation à l'usage possible », en ambre ;<br>• **Ollama** : si `memory.embeddings.provider` vaut `ollama`, « Endpoint local · sans clé · recherche de la mémoire » ;<br>• le secret : « Identifiants gérés par le CLI », « Aucun secret », ou l'alerte.<br>**Alertes** : une variable connue (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`) présente dans l'environnement du daemon (son nom seul) ; `auth.json` présent dans le dossier de codex (`$CODEX_HOME` ou `~/.codex`), qui signale des identifiants dans un fichier plutôt que dans le trousseau. Chaque alerte a « Comment la déplacer », qui déplie la marche à suivre. | Q8, Q9. `account/read` de codex demanderait de lancer codex : pas pour un écran en lecture. |
| **D160** | **Mise à jour** : l'écran lit `/api/machines/local`, `/api/machines/serveurs` et `/api/machines/fournisseurs` à l'ouverture ; l'état et la latence des serveurs suivent l'état existant. Diagnostiquer relit la carte de sa machine. Rien ne tourne en fond. | Q10. |

## 5. Points

Chaque point est un commit, gate vert. Les lignes existantes modifiées sont comptées dans le message de commit. Les styles nouveaux vont dans `web/src/styles/machines.css` (nouveau), jamais dans `maquette.css`.

### 29.1 Le plan, et la table des capacités

- **Fichiers** : ce plan ; `src/shared/capacites.ts` (D153) ; `web/src/ui/machinesVue.ts` : `combinaisons`, `marque`, `etatCombinaison`, `libelleMemoire`, `accesDe` (D157, D158) ; tests `test/capacites.test.ts` (dont la confrontation aux pilotes) et `test/web/machines-vue.test.ts`.
- **Vérification** : `npm run gate`

### 29.2 Le diagnostic du Mac

- **Fichiers** :
  - `src/shared/model.ts` : `Memoire`, `MachineLocale`, `MachineServeur`, `Fournisseur`, `AlerteSecret`, `Fournisseurs` (insérés) ;
  - `src/daemon/machines/memoire.ts` : `parseVmStat`, `parseMeminfo`, `memoireLocale`, `MEMOIRE_CMD` (D156) ;
  - `src/daemon/routes/machines.ts` (nouveau) : `GET /api/machines/local` (D154), branché dans le daemon (insertion) ;
  - tests `test/machines-memoire.test.ts` (sorties synthétiques) et `test/machines-routes.test.ts`.
- **Vérification** : `npm run gate`

### 29.3 Le diagnostic d'un serveur

- **Fichiers** :
  - `migrations/019_server_diagnostics.sql` ;
  - `CX` : `testFini` (insertion, et la promesse du test gardée à `CX:203`, lignes modifiées comptées) ;
  - `src/daemon/machines/diagnostic.ts` : la commande distante des versions et de la mémoire, son analyse, l'enregistrement (D155) ;
  - `src/daemon/routes/machines.ts` : `POST /api/machines/serveurs/:id/diagnostic`, `GET /api/machines/serveurs` ;
  - tests dans `test/machines-routes.test.ts`, par le faux ssh (`test/fixtures/fake-ssh.sh`) : diagnostic complet, agent sans version, shell en échec (ni versions ni mémoire), relecture après coup, serveur supprimé.
- **Vérification** : `npm run gate`

### 29.4 Fournisseurs et alertes de secret

- **Fichiers** :
  - `src/daemon/machines/fournisseurs.ts` : `fournisseurs(env, config, codexHome)` (D159), pure sur ses entrées ;
  - `src/daemon/routes/machines.ts` : `GET /api/machines/fournisseurs` ;
  - tests `test/machines-fournisseurs.test.ts` : sans clé, clé retirée, clé transmise, `OPENAI_API_KEY`, `auth.json` présent, Ollama coupé. Aucune valeur de clé dans la réponse (vérifié sur une valeur synthétique).
- **Vérification** : `npm run gate`

### 29.5 L'écran Machines : cockpit et cartes

- **Fichiers** :
  - `web/src/App.tsx` : la route, insérée ;
  - `B:65` : l'entrée Machines (D151, ligne modifiée comptée), et l'état actif sur `/serveurs…` ;
  - `web/src/ui/Layout.tsx` : « Machines » dans la palette (insertion) ;
  - `web/src/ecrans/Machines.tsx` (nouveau) : Ton cockpit (D152), cartes (D157), Diagnostiquer ;
  - `web/src/data/machines.ts` (nouveau) ;
  - `web/src/styles/machines.css` ;
  - `test/web/machines.test.tsx` (nouveau) ; `test/web/serveurs.test.tsx:109` suit l'entrée renommée (ligne comptée).
- **Vérification** : `npm run gate`, puis `npm run gate:e2e` (la barre change)

### 29.6 Combinaisons, fournisseurs, et le composer lit la table

- **Fichiers** :
  - `Machines.tsx` : la matrice et ses filtres (D158), les fournisseurs et les alertes (D159) ;
  - `CO:70` : `joindre` passe par `capacitesDe` (ligne modifiée comptée) ;
  - tests dans `test/web/machines.test.tsx` ; le test existant du trombone sur un serveur reste inchangé et vert.
- **Vérification** : `npm run gate`

### 29.7 E2E et fiche de recette

- **Fichiers** :
  - `e2e/machines.spec.ts` : son propre daemon, en `stream`, devant les faux claude et codex. Il déroule : l'entrée Machines de la barre, Ton cockpit, la carte du Mac (agents et versions synthétiques, mémoire mesurée), Diagnostiquer, la matrice du Mac (images ✓, contrôle distant ✓ claude et – codex), la ligne Anthropic, Configurer d'une machine absent du Mac ;
  - `docs/recette-chantier-29-machines.md` : la recette réelle couvre un serveur (Diagnostiquer, versions, mémoire, matrice du serveur, images –) et l'alerte de secret.
- **Vérification** : `npm run gate` et `npm run gate:e2e`

## 6. Pièges

- **Aucun secret lu** : la détection teste `key in env` et `existsSync`, jamais une valeur ni un contenu. Les tests posent une valeur synthétique et vérifient qu'elle n'apparaît nulle part dans la réponse.
- **Le test de connexion est unique** : Diagnostiquer passe par `startTest`. Un test déjà en cours (lancé depuis la configuration) est attendu, pas doublé.
- **`detected_agents` vaut `null` sans test, `[]` sans agent** : « Jamais diagnostiqué » contre « Aucun agent ».
- **La commande distante** n'utilise que les agents trouvés, dont les noms viennent de `KNOWN_AGENTS` (jeu fermé), jamais d'une saisie.
- **`vm_stat`** : la taille de page est lue dans l'en-tête (16 Kio sur Apple Silicon, 4 Kio sur Intel).
- **Les e2e et tests qui visent « Serveurs » dans la barre** : `test/web/serveurs.test.tsx:109` seulement au relevé.
- **`test/web/maquette-css.test.ts`** : rien dans `maquette.css`.
- **Jamais le vrai claude ni le vrai codex** en test ou en e2e : `test/fixtures/bin-stream`.
- **Daemon de travail de Julien** : des agents y tournent. Aucun redémarrage ni changement d'installation sans son accord.

## 7. Fini quand

- Les points 29.1 à 29.7 sont commités, un par point, `npm run gate` vert sur chacun, et `npm run gate:e2e` vert en 29.5 et 29.7.
- La recette de Julien est faite sous Node 22 et 24, et sa fiche est remplie.
- Julien a mergé la PR.
