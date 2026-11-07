# Chantier 31 : Mode host par le tailnet

| Champ | Valeur |
|---|---|
| État | **Révision 1, 7 novembre 2026.** Relecture du plan par le lab (DM 91366) : validé, sous deux conditions reprises ici, le cookie de demande (D176) et `statusReason` (D175), plus trois ajouts (D175, D180, D183, 31.2). Validation finale du lab après le build et l'e2e. *Révision 0 :* Spec : recommandations validées par Julien le 7 novembre. Relecture de la spec par le lab faite le 7 novembre (DM 91348) : elle tient, avec quatre conditions obligatoires (M1 à M4) et un second port par défaut, retenu par Julien. Le lab relit ce plan, puis valide le chantier (programme §5 bis, DM 89702). |
| Emplacement final | `docs/chantiers/31-mode-host.md` sur `main`, dans le premier commit du chantier |
| Base | **13e128a** (`origin/main`, PR #124). Les `fichier:ligne` ont été lus sur cette base. |
| Spec | `specs/mode-host-v1.md`, révision 1 (dossier de travail, hors dépôt ; copie sur morzu-vps dans `~/work/aid-specs/`). |
| Programme | `programme.md`, ligne 31 ; §3 invariants 6 à 9 ; §5 bis ; §7 |
| Prérequis | **Question 0 de la spec, encore ouverte** : HTTPS activé dans la console Tailscale de Julien (MagicDNS et certificats). Les points 31.2 à 31.11 n'en dépendent pas ; la recette, si. |
| Validation | Le lab (pair distinct du constructeur), plus la recette de Julien sur son Mac et un téléphone, sous Node 22 et 24. |

## 1. Pourquoi

Le cockpit n'est joignable que depuis le Mac. Ce chantier l'ouvre aux autres appareils de Julien, **sur son tailnet seulement**, en HTTPS. Un appareil entre par un QR montré sur le Mac et approuvé sur le Mac. Il reçoit un accès de 8 heures, qu'on peut révoquer tout de suite. Dans cette version, il lit ce qu'une liste permet, une version masquée de l'état et le board, et gère les appareils. Il n'écrit rien d'autre.

La frontière repose sur un **port à part**, que seul Tailscale Serve atteint et qui ne connaît que le principal `appareil`. Le port du Mac ne change pas.

## 2. État actuel

Abréviations : `SE` = `src/daemon/security.ts`, `SV` = `src/daemon/server.ts`, `MA` = `src/daemon/main.ts`, `CF` = `src/daemon/config.ts`, `TS` = `src/daemon/mesh/tailscale.ts`, `SN` = `src/daemon/state/snapshot.ts`, `EV` = `src/daemon/ws/events.ts`, `BO` = `src/daemon/routes/board.ts`, `AS` = `src/daemon/artefacts/serveur.ts`, `MC` = `web/src/ecrans/Machines.tsx`, `DR` = `src/cli/commands/doctor.ts`.

| Zone | Où | Ce qui existe |
|---|---|---|
| Écoute | `MA:276`, `CF:145-146` | `127.0.0.1:<port>` ; `host` ≠ `127.0.0.1` refusé dans la config. **Inchangé** par ce chantier. |
| Hôtes et origines | `SE:95-107` | 421 hors `127.0.0.1:<port>` et `localhost:<port>` ; 403 sur une origine étrangère |
| Principaux | `SE:18-19`, `SE:71-79` | `admin` (cookie ou bearer), `run` (jeton de run) |
| Garde D165 | `SE:148-168` | Par cookie : `Sec-Fetch-Site` ≠ `same-origin` → 403 ; absent sur `/api/` sans `x-aid-cockpit: 1` → 403 ; `/ws/` exige l'Origin exacte |
| CSP | `SE:177-194` | `connect-src` vers `ws://127.0.0.1:<port>` ; `frame-src` vers les artefacts ; `frame-ancestors 'none'` |
| Second port, modèle à reprendre | `AS` (chantier 30) | Instance Fastify à part, sans plugin cookie, `127.0.0.1` seulement, 421 hors de ses hôtes, journal masqué, port occupé sans lever |
| État du cockpit | `src/shared/state.ts:3-22`, `SN` | `StateSnapshot` : workspaces, topics, runs, agents, actions, `mesh.inbox` (**corps des DM**) |
| Agent | `src/shared/model.ts:121-148` | `command` (argv), `statusMessage`, `statusDetail`, `lastTool`, `pending` : **du texte d'agent ou d'outil** |
| Flux d'événements | `EV:12-40` | Envoie l'événement entier (`{kind:'event', event}`) et les messages éphémères |
| Board | `BO:27-38`, D94 (chantier 24) | Cache mémoire de 5 s par vecteur d'arguments, requêtes identiques fusionnées, `?fresh=1` le contourne |
| Tailscale | `TS:1-38` | `tailscale status --json` lu, jamais piloté (D37) ; seul `BackendState` est lu |
| Écran Machines | `MC:441` | « Mode host inactif », le Mac seul, aucun bouton d'appareil |
| Migrations | `migrations/019_server_diagnostics.sql` | La dernière ; ce chantier ajoute la 020 |
| Interface servie | `SV:237-238` | `@fastify/static` sur `webRoot`, `setNotFoundHandler` pour le routage de la SPA |
| `aid doctor` | `DR` | Lignes du daemon, du port des artefacts (30.4), des agents |

## 3. Cible et hors-périmètre

**Cible** : `specs/mode-host-v1.md`, révision 1, questions 1 à 9, « La frontière » et « Pièges connus ».

**Hors-périmètre** :
- l'app mobile installée, ses trois onglets et ses notifications (32) ;
- les confirmations par le téléphone et le PDA A-I-D (34, 43) ;
- le SSO swarph et le flux d'appareil RFC 8628 vers le gateway (33) ;
- les artefacts sur un appareil ;
- toute écriture depuis un appareil autre que la gestion des appareils ;
- piloter Tailscale (`tailscale serve` reste lancé par Julien, D37).

## 4. Décisions

| # | Décision | Raison |
|---|---|---|
| **D171** | **Le port des appareils.** Une troisième instance Fastify (`src/daemon/host/serveur.ts`), sur `127.0.0.1` seulement, au port `modeHost.port` (`CF`, par défaut le port du daemon + 20, soit 4890). Elle ne démarre que si `modeHost.actif` vaut `true`, et refuse le port du daemon, 4871 et le port des artefacts.<br>• **Elle n'enregistre que ses propres routes** (D174). Elle ne partage ni le hook `onRequest` de `SE` ni aucune route du port du Mac : ce qui n'y est pas déclaré n'existe pas (404).<br>• Elle ne connaît que le cookie `__Host-aid_appareil`. `Authorization` est ignoré, et le cookie `aid_session` aussi : ni jeton admin, ni cookie du Mac, ni jeton de run n'y ouvre rien (401).<br>• 421 si `Host` n'est pas le nom `.ts.net` du Mac (D173) ; 403 si une `Origin` est présente et n'est pas `https://<nom>`. La garde D165 y est reprise pour le cookie d'appareil : `Sec-Fetch-Site` ≠ `same-origin` → 403, absent sur `/api/` sans `x-aid-cockpit: 1` → 403.<br>• Le journal reprend le sérialiseur de `AS`, chemins d'appairage masqués, aucun en-tête.<br>• Port occupé : le daemon démarre quand même, l'état le dit, `aid doctor` le signale. | Spec Q1 et Q2 révisées ; lab M2 et recommandation du second port. La frontière tient par construction, quelle que soit la façon dont Serve transmet `Host`. |
| **D172** | **Le mode host, interrupteur du Mac.** *Révision 31.3 : la clé est `modeHost`, pas `host`, qui reste l'adresse d'écoute (`CF:6`, toujours `127.0.0.1`).* `modeHost.actif` (`CF`, `false` par défaut) et `modeHost.port`. `PUT /api/host` `{ actif }`, sur le port du Mac seulement, démarre ou arrête l'instance de D171 sans redémarrer le daemon, puis écrit `config.yaml`. Éteindre révoque tous les appareils et annule les demandes d'appairage (D177). `GET /api/host` rend `{ actif, port, disponible, raison?, nom, compte, serve, funnel }` (D173). | Spec Q8. |
| **D173** | **Ce que le daemon lit de Tailscale.** `TS` lit aussi, dans `tailscale status --json`, `Self.DNSName` (le nom `.ts.net`, sans le point final) et le login du compte du Mac (`User[Self.UserID].LoginName`). Il lit `tailscale serve status --json` pour savoir si Serve vise `127.0.0.1:<modeHost.port>` en HTTPS, et si un **Funnel** est actif sur ce service. Il ne lance jamais `tailscale serve` (D37). Si le nom manque ou si Serve ne vise pas le bon port, l'écran donne la commande exacte : `tailscale serve --bg --https=443 http://127.0.0.1:<modeHost.port>`. Un Funnel actif empêche l'activation (« Funnel actif : le cockpit serait sur internet ») et `aid doctor` le signale (✗). Le nom est relu à l'activation et toutes les 60 s quand le mode est actif, jamais en tâche de fond sinon. | Spec Q1, Q8 ; « Rien sur internet ». |
| **D174** | **La liste des routes de l'appareil (lab M1).** Le port des appareils déclare exactement :<br>• les fichiers de l'interface (`@fastify/static`, même `webRoot`) et le repli de la SPA ;<br>• `GET /api/state`, **état masqué** (D175) ;<br>• `GET /api/board/projects`, `GET /api/board/projects/:projectId/cards`, `GET /api/board/cards/:cardId`, par la même `MeshService.read` (D178) ;<br>• `GET /api/appareils`, `DELETE /api/appareils/:id` (révoquer), `POST /api/appareils/moi/deconnexion` ;<br>• `POST /appairage/reclamer`, `GET /appairage/:demandeId` (D176, sans cookie) ;<br>• `GET /ws/signal` (D175).<br>Rien d'autre : ni terminaux ni leur historique, ni `input`/`answer`, ni événements ou transcripts d'un sujet, ni fichiers, mémoire, index structurel, machines, hooks, daemon, serveurs, artefacts. Un test énumère les routes du port du Mac (hook `onRoute`) et vérifie que chacune, appelée sur le port des appareils avec un cookie d'appareil valide, rend 404, sauf celles de la liste. | Spec Q4 révisée ; lab M1 ; revue 0.b, points 3 et 7. |
| **D175** | **L'état masqué et le signal.** `etatPourAppareil(snapshot)` (`src/daemon/host/masque.ts`) construit l'état **champ par champ, par liste d'autorisation** :<br>• workspaces : `id`, `name` ;<br>• topics : les champs d'affichage du board et de l'accueil (titre, slug, état, branche, horodatages), sans chemin de worktree. Le titre et la branche sont du texte de Julien, ce qui est accepté et dit dans la spec ;<br>• runs et actions : `id`, `topicId`, `status`, horodatages ;<br>• agents : `id`, `runId`, `kind`, `role`, `transport`, `status`, `statusReason` **ramené à une liste fermée** (`permission`, `question`, sinon `autre`, puisque `projectors.ts:42` y écrit `clip(d.reason, 32)`, un texte que l'agent fournit), `statusAt`, `pausedAt`, `createdAt`, `updatedAt`, et `attend: boolean` à la place de `pending`. **Jamais** `command`, `cwd`, `statusMessage`, `statusDetail`, `lastTool`, `pending`, `sessionId`, `pid` ;<br>• `mesh` : l'état et, pour l'inbox, `id`, `from`, `kind`, `createdAt` et la marque locale. **Jamais** `content`.<br>Un champ ajouté plus tard à `StateSnapshot` n'apparaît pas chez l'appareil tant qu'il n'est pas ajouté ici. `/ws/signal` n'envoie que `{ kind: 'changed' }` (anti-rebond de 250 ms), à chaque événement stocké ou éphémère, sans contenu ; l'appareil relit `GET /api/state`. | Spec Q4 ; lab M1 (flux d'événements : pas de flux masqué à maintenir). |
| **D176** | **L'appairage (spec Q3, lab M4).**<br>• `POST /api/host/appairages` (port du Mac, `admin`) : crée une demande, `{ demandeId, code, expireA }`. Le code fait 32 octets aléatoires en base64url, sert une fois et vit 5 minutes. Le QR porte `https://<nom>/appairer#<code>`, avec le code dans le fragment, donc jamais dans un journal. Une nouvelle demande annule la précédente. Une seule demande vivante.<br>• `POST /appairage/reclamer` (port des appareils, sans authentification) `{ code, nom }` : la première réclamation valide rend `{ demandeId, codeCourt }`, un code court de 6 caractères (alphabet sans ambiguïté) à comparer. **Une seconde réclamation du même code annule la demande** ; le Mac affiche « Deux appareils ont essayé ce code : demande annulée ». Plafond : 5 réclamations par minute et par source (D179), 429 au-delà. Code inconnu, expiré ou annulé : 404, même corps, sans le répéter.<br>• Le Mac affiche le code court, le nom proposé et l'identité Tailscale (D179) **avant** les boutons. `POST /api/host/appairages/:id/approuver` (port du Mac, `admin`) `{ sansIdentite?: true }` : sans identité Tailscale, refus (409) sauf si `sansIdentite` est coché (« Appareil taggé, sans identité Tailscale »). `…/refuser` annule.<br>• **La demande est liée à l'appareil par un cookie (lab, DM 91366).** `demandeId` voyage dans le chemin, et pourrait donc fuir par un journal, un proxy ou l'historique. `POST /appairage/reclamer` pose aussi `__Host-aid_demande` (`HttpOnly`, `Secure`, `SameSite=Strict`, `Max-Age` de 5 minutes). `demandeId` fait 128 bits aléatoires au moins. `/appairer` porte `Referrer-Policy: no-referrer`.<br>• `GET /appairage/:demandeId` (port des appareils) exige **le chemin et ce cookie**. Sans le cookie, ou avec un autre, il rend 404, même corps qu'un inconnu. L'appareil attend. Une fois approuvé, la première lecture efface `__Host-aid_demande` et pose le cookie (`__Host-aid_appareil`, `HttpOnly`, `Secure`, `SameSite=Strict`, `path=/`, `Max-Age` de 8 h) et rend `{ etat: 'approuve' }` ; les suivantes, `{ etat: 'consomme' }`, sans cookie. Un chemin qui a fuité n'ouvre donc rien. | Spec Q3 ; lab M4 ; fiche Meta-Edge (défense contre un QR piégé). |
| **D177** | **Le registre des appareils (spec Q5).** Migration `020_appareils.sql` : `appareils(id, nom, identite, cree_a, dernier_contact, expire_a, revoque_a, empreinte)`. `empreinte` = SHA-256 du jeton de 32 octets, jamais le jeton. Le module `src/daemon/host/appareils.ts` est pur, avec une horloge injectée : émettre, authentifier (empreinte, non révoqué, non expiré), toucher (`dernier_contact`, au plus une écriture par minute), révoquer, tout révoquer, purger les demandes.<br>• **8 heures, sans prolongation.** À l'échéance, 401 `{ error: 'expire' }`, et l'interface affiche « Accès expiré. Nouveau QR requis pour revenir. ».<br>• **Révoquer agit tout de suite** : 401 `{ error: 'revoque' }` à la requête suivante, et les sockets de l'appareil sont fermées (registre des sockets par appareil). L'interface affiche « Accès coupé. Nouveau QR requis pour revenir. ».<br>• Révoquer, sur le Mac (`DELETE /api/host/appareils/:id`) ou depuis un appareil (`DELETE /api/appareils/:id`), ne demande pas de confirmation (règles globales). « Couper tous les accès » (`POST /api/host/couper`, Mac seulement) révoque tout et annule la demande en cours ; le Mac reste.<br>• Le registre survit au redémarrage ; les accès non expirés aussi. | Spec Q5 et Q8 ; fiche Machines. |
| **D178** | **Le budget de lecture du board (D97).** Sur le port des appareils, `?fresh=1` est ignoré et le cache de D94 garde la lecture **60 s** (au lieu de 5 s) pour les vecteurs demandés par un appareil. Les lectures simultanées restent fusionnées (D94). Le Mac garde ses 5 s et son bouton Relire. Aucune lecture en tâche de fond. Le plafond de 4 commandes par fiche ouverte, accepté par le lab, tient quel que soit le nombre d'appareils. | Spec Q7 ; D97. |
| **D179** | **L'identité Tailscale et la source (lab M3).** La mesure de 31.2 décide :<br>• si Serve **pose et remplace** `Tailscale-User-Login` (un client ne peut pas imposer le sien, taggé ou non), l'identité est exigée égale au compte du Mac (D173) à chaque requête d'un appareil qui l'a fournie à l'appairage, 403 sinon ;<br>• si un client peut faire passer le sien, depuis un nœud taggé ou non, l'identité n'est **qu'affichée** à l'appairage, marquée « non vérifiable », et jamais exigée. La spec et ce plan sont révisés en conséquence, et le lab prévenu.<br>La source du plafond de D176 est l'en-tête d'adresse que Serve pose (mesuré en 31.2) ; s'il manque, le plafond devient global (5 par minute en tout). Ces en-têtes ne valent jamais seuls : sans cookie d'appareil valide, ils n'ouvrent rien. | Lab M3 ; spec, « Pièges connus ». |
| **D180** | **L'interface sur un appareil.** La SPA demande `GET /api/appareils/moi` au démarrage (route de la liste D174, rend `{ id, nom, expireA }`, 404 sur le port du Mac). Si elle répond, l'interface passe en **mode appareil** : la barre ne montre que l'Accueil (sujets et agents en lecture, sans action), le Board et « Appareils connectés » ; aucun bouton d'écriture n'est rendu. Le flux passe par `/ws/signal` au lieu de `/ws/events`. Sur 401 `expire` ou `revoque`, l'écran plein « Accès expiré » ou « Accès coupé », avec la phrase de D177. La page `/appairer` lit le fragment, réclame, montre le code court, attend l'approbation, puis recharge. Le mode appareil ne remplace pas la liste du daemon : c'est elle qui refuse. | Spec Q4 ; fiche Mobile, « Ajouter ce téléphone » et « Appareils connectés » (sans la mise en page mobile, qui est au 32). |
| **D181** | **Le QR.** Rendu côté client, dans Machines, par la dépendance `qrcode-generator` (MIT, sans dépendance, 1.4.4), en SVG inline. Aucune requête vers un service de QR. **Validée par Julien le 7 novembre** : une dépendance nouvelle, ajoutée au point 31.9. Autre choix : un encodeur écrit à la main (~300 lignes), écarté. | Fiche Machines ; règle 9 (rien de chargé depuis un CDN). |
| **D183** | **`/ws/signal`, mêmes gardes que `/ws/` sur le Mac (lab, DM 91366).** L'Origin doit être exactement `https://<nom>`, et le cookie d'appareil valide. Un appareil révoqué ou expiré voit sa socket fermée avec le code **4401** et la raison (`revoque`, `expire`), jamais une fermeture muette. L'interface affiche alors l'écran de D177. | Lab, DM 91366. |
| **D182** | **`aid doctor`.** Trois lignes, si `modeHost.actif` : port des appareils (✓ ou ⚠ occupé) ; Serve vers `127.0.0.1:<modeHost.port>` en HTTPS (✓, sinon ⚠ avec la commande de D173) ; **aucun Funnel** sur ce service, et Serve ne vise ni 4870, ni 4871, ni le port des artefacts (✗ sinon). | « Rien sur internet » ; spec, « Pièges connus » (pont Tauri). |

## 5. Points

Chaque point est un commit, avec le gate vert. Le message de commit compte les lignes existantes modifiées. Les styles nouveaux vont dans `web/src/styles/host.css` (nouveau).

### 31.1 Le plan

- **Fichiers** : ce plan.
- **Vérification** : `npm run gate`

### 31.2 La sonde de Serve (lab M3), sans code de produit

- **Pourquoi** : D179 dépend de ce que Serve transmet. On le mesure avant d'écrire l'identité.
- **Fichiers** :
  - `scripts/sonde-serve.mjs` : un serveur HTTP sur `127.0.0.1:4899` qui rend en JSON les en-têtes reçus (`Host`, `X-Forwarded-*`, `Tailscale-*`), les valeurs comprises, et rien d'autre ;
  - `docs/mesure-serve-31.md` : la procédure et le tableau à remplir.
- **La procédure**, sur le Mac de Julien et sur sa décision (elle change la config Tailscale du Mac, le temps de la mesure) :
  1. `tailscale serve --bg --https=443 http://127.0.0.1:4899` ;
  2. depuis le téléphone (nœud d'utilisateur), une requête simple, puis une requête qui pose elle-même `Tailscale-User-Login: forge@example` et `X-Forwarded-For: 203.0.113.9` ;
  3. la même chose depuis un nœud **taggé**, s'il y en a un sur le tailnet (sinon, le noter) ;
  4. `tailscale serve reset` à la fin. **La fiche note que le reset a été fait et que `tailscale serve status` est vide ensuite** (lab, DM 91366) : sinon la sonde, qui renvoie les en-têtes, resterait joignable sur le tailnet.
- **Ce qu'on note** : `Host` reçu ; présence, valeur et origine (Serve ou client) de chaque en-tête `Tailscale-*` ; l'en-tête d'adresse. Le résultat fixe D179 et les tests de 31.5.
- **Vérification** : `npm run gate`. La mesure elle-même n'est pas dans le gate. **Elle bloque 31.6 (identité) et seulement lui.**

### 31.3 Le mode host dans la config, et ce que le daemon lit de Tailscale

- **Fichiers** :
  - `CF` : `modeHost: { actif, port }` (insertions), validation (port ≠ daemon, 4871, artefacts) ;
  - `TS` : lecture du nom, du compte, de `serve status` et du Funnel (D173), sur une exécution injectée ;
  - `src/daemon/routes/host.ts` : `GET /api/host` ;
  - `DR` : D182 ;
  - les tests : `test/config.test.ts` (défauts, refus), `test/tailscale.test.ts` (JSON synthétiques : nom, compte, Serve absent, Serve sur un autre port, Funnel actif), `test/doctor.test.ts`.
- **Vérification** : `npm run gate`

### 31.4 Le registre des appareils et les demandes d'appairage

- **Fichiers** : `migrations/020_appareils.sql` ; `src/daemon/host/appareils.ts` (D177, pur) ; `src/daemon/host/appairage.ts` (D176, pur : demande unique, code, code court, première réclamation, seconde qui annule, plafond par source, expiration à 5 minutes) ; tests `test/host-appareils.test.ts` et `test/host-appairage.test.ts`, horloge injectée : 8 h exactes, pas de prolongation, empreinte seule en base (le jeton n'apparaît dans aucune ligne), révocation, tout révoquer, purge.
- **Vérification** : `npm run gate`

### 31.5 Le port des appareils

- **Fichiers** :
  - `src/daemon/host/serveur.ts` : D171, avec seulement les fichiers de l'interface et `GET /api/appareils/moi` dans ce point ;
  - `MA` : démarrage et arrêt, à côté de celui des artefacts (insertion) ; `PUT /api/host` (D172) ;
  - `test/host-serveur.test.ts` :
    - 421 hors du nom `.ts.net` (dont `127.0.0.1:<port>`, `localhost`, le nom avec un autre port) ;
    - 403 sur une Origin étrangère, `null`, ou en `http://` ;
    - **le jeton admin en bearer, le cookie `aid_session` valide et un jeton de run valent 401** ;
    - un cookie d'appareil révoqué ou expiré, 401 avec sa raison ;
    - Sec-Fetch-Site ;
    - aucun `Set-Cookie` hors de D176 ;
    - port occupé ; refus des ports interdits ;
    - journal sans cookie ni code ;
    - **les fichiers servis sur 4890 ne portent rien du Mac** (lab, DM 91366) : `index.html` est identique, à l'octet près, à celui d'un build sans état du daemon. Aucun amorçage en ligne, aucune config, aucun jeton admin, aucune URL du Mac. Le repli de la SPA aussi.
  - Sur le port du Mac, un test vérifie qu'un cookie `__Host-aid_appareil` valide n'ouvre rien (401).
- **Vérification** : `npm run gate`

### 31.6 L'appairage

- **Fichiers** : les routes de D176, sur les deux ports ; D179 selon la mesure de 31.2 ; `test/host-appairage-routes.test.ts`, sur le vrai daemon :
  - le parcours complet ;
  - un code réutilisé ;
  - une seconde réclamation, qui annule et le dit au Mac ;
  - le plafond, 429 ;
  - un code expiré ;
  - l'approbation sans identité refusée, puis acceptée avec la case ;
  - l'approbation depuis le port des appareils impossible (la route n'y existe pas) ;
  - le cookie posé une seule fois ;
  - `demandeId` étranger ;
  - **un `demandeId` juste, sans le cookie de demande ou avec un autre, rend 404, même corps** ;
  - le cookie de demande effacé à la pose du cookie d'appareil ;
  - `Referrer-Policy: no-referrer` sur `/appairer`.
- **Vérification** : `npm run gate`. **Attend la mesure de 31.2** pour la partie identité.

### 31.7 L'état masqué, le signal et le board

- **Fichiers** :
  - `src/daemon/host/masque.ts` (D175) ;
  - `GET /api/state`, `/ws/signal` et les routes du board (D178) sur le port des appareils ;
  - `BO` : TTL de 60 s et `fresh` ignoré pour un appareil (insertion) ;
  - les tests :
    - `test/host-masque.test.ts` : un `StateSnapshot` synthétique où chaque champ texte porte un marqueur ; aucun marqueur de `command`, `cwd`, `statusMessage`, `statusDetail`, `lastTool`, `pending`, `content` dans la sortie ; les clés de sortie sont **exactement** celles de la liste ;
    - `/ws/signal` n'envoie que `{kind:'changed'}` ; Origin absente, `null` ou étrangère refusée ; cookie absent refusé ; révocation et expiration ferment en 4401 avec la raison (D183), un test chacun ;
    - `statusReason` d'un texte quelconque sort `autre` ;
    - le board ne relit pas avant 60 s pour deux appareils.
- **Vérification** : `npm run gate`

### 31.8 La liste fermée, révoquer et couper

- **Fichiers** :
  - `GET /api/appareils`, `DELETE /api/appareils/:id`, `POST /api/appareils/moi/deconnexion` (port des appareils) ;
  - `GET /api/host/appareils`, `DELETE /api/host/appareils/:id`, `POST /api/host/couper` (port du Mac) ;
  - le registre des sockets par appareil (D177) ;
  - les tests :
    - `test/host-liste.test.ts` : **toutes les routes du port du Mac**, collectées par `onRoute`, appelées sur le port des appareils avec un cookie valide, rendent 404, sauf la liste de D174. Une route ajoutée au Mac sans décision fait échouer ce test ;
    - révoquer ferme les sockets ouvertes de l'appareil, et lui seul ;
    - couper ferme tout ;
    - éteindre le mode host arrête l'écoute.
- **Vérification** : `npm run gate`

### 31.9 L'écran Machines, « Ton cockpit »

- **Fichiers** :
  - `MC:441` et alentour : la pilule (inactif, actif, Serve absent, Funnel), l'interrupteur, la commande Serve à copier ;
  - « Ajouter un appareil » : QR (D181, dépendance ajoutée ici), temps restant, « Nouveau code », puis le code court, le nom, l'identité et l'avertissement « Si tu n'as pas lancé cette connexion, refuse », Approuver, Refuser, la case sans identité ;
  - la liste (nom, identité, dernier contact, expiration), Révoquer, Couper tous les accès ;
  - `web/src/data/host.ts`, `web/src/styles/host.css` ;
  - `test/web/host.test.tsx`.
- **Vérification** : `npm run gate`, puis `npm run gate:e2e`.

### 31.10 L'interface sur un appareil

- **Fichiers** :
  - D180 : le mode appareil (barre réduite, aucun bouton d'écriture, `/ws/signal`) ;
  - `web/src/ecrans/Appairer.tsx` ;
  - les écrans « Accès coupé » et « Accès expiré » ;
  - « Appareils connectés » ;
  - `test/web/appareil.test.tsx`.
- **Vérification** : `npm run gate`, puis `npm run gate:e2e`.

### 31.11 L'e2e de la frontière, et la fiche de recette

- **Fichiers** :
  - `e2e/mode-host.spec.ts`. Son propre daemon, mode host actif, port des appareils au port de l'e2e + 20. Devant lui, un frontal HTTPS local qui joue Serve (certificat autosigné créé par `openssl` dans le setup, nom `aid-e2e.ts.net` résolu vers `127.0.0.1` par `--host-resolver-rules`, `ignoreHTTPSErrors`), et une sortie `tailscale` synthétique. Il vérifie :
    - le parcours d'appairage entre deux contextes de navigateur, le Mac et l'appareil ;
    - le mode appareil ;
    - l'état masqué vu de la page ;
    - une écriture et un terminal refusés ;
    - la révocation qui coupe une page ouverte ;
    - Couper tous les accès ;
    - le cookie du Mac sans effet sur le port des appareils.
  - `docs/recette-chantier-31-mode-host.md` : la recette réelle sur le Mac et un téléphone, sous Node 22 et 24. Elle comprend la mesure de 31.2 si elle n'est pas faite, et la note sur la porte 0.b : elle ne s'applique pas à une recette sans pair ni gateway swarph, et s'applique entière sinon. À côté, une note du lab : **le board est lu avec le jeton de pair du Mac**, donc un appareil lit le board aussi largement que le Mac.
- **Vérification** : `npm run gate` et `npm run gate:e2e`

## 6. Pièges

- **Serve en local.** Tout processus du Mac peut joindre `127.0.0.1:4890` en posant `Host`, `X-Forwarded-*` et `Tailscale-*`. Sans cookie d'appareil valide, il n'obtient rien. Ces en-têtes ne valent jamais seuls (D179).
- **`__Host-` exige `Secure`, et `Secure` exige HTTPS.** Le port des appareils est en HTTP derrière Serve : le cookie est posé `Secure` quand même, et le navigateur l'accepte parce que la page est en HTTPS. En e2e, le frontal HTTPS local en tient lieu. Le cookie du Mac reste sans `Secure`.
- **La CSP du port des appareils** : `connect-src 'self'` (le `wss://` de même origine est couvert par `'self'` en CSP 3, à vérifier dans Safari en recette), pas de `frame-src` (aucun artefact), `frame-ancestors 'none'`.
- **Un champ nouveau dans `StateSnapshot`** n'arrive pas chez l'appareil : c'est voulu (D175). Le test des clés exactes le rappelle.
- **Une route nouvelle sur le port du Mac** fait échouer `test/host-liste.test.ts` tant qu'on n'a pas décidé si un appareil y a droit. C'est voulu (D174).
- **Les ports.** 4890 pour les appareils. L'e2e utilise 4871 à 4873, ses artefacts 4881 à 4883, ses appareils 4891 à 4893. Jamais 4871 (pont Tauri) ni 4880.
- **Le Mac endormi** : l'appareil voit une erreur réseau, rendue lisible (« Mac injoignable »), sans plus.
- **Changer la config Tailscale de Julien** (31.2, recette) : sur sa décision seulement. Aucun `tailscale serve` n'est lancé par A-I-D ni par un test.
- **Jamais le vrai claude, codex, gh ni tailscale** en test ou en e2e : sorties synthétiques.
- **Le daemon de travail de Julien** : aucun redémarrage ni changement d'installation sans son accord.

## 7. Fini quand

- Les points 31.1 à 31.11 sont commités, un par point, avec `npm run gate` vert sur chacun et `npm run gate:e2e` vert en 31.9, 31.10 et 31.11.
- La mesure de 31.2 est faite et D179 tranché, lab prévenu.
- Le lab a relu le plan, puis validé le chantier.
- La recette de Julien est faite sur son Mac et un téléphone, sous Node 22 et 24, et sa fiche est remplie.
- Julien a mergé la PR.
