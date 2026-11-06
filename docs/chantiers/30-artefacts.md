# Chantier 30 : Panneau d'artefacts

| Champ | Valeur |
|---|---|
| État | **Révision 0, 6 novembre 2026, à valider par Julien.** Spec validée par Julien le 6 novembre (`specs/artefacts-v1.md`, ses sept recommandations). Relecture légère du lab faite le 6 novembre (DM 91260 et 91262, programme §5 bis) : les quatre couches tiennent, deux corrections exigées avant le plan, reprises en D165, D166 et D167. |
| Emplacement final | `docs/chantiers/30-artefacts.md` sur `main`, dans le premier commit du chantier |
| Base | **b5ecb50** (`origin/main`, PR #123). Les `fichier:ligne` ont été lus sur cette base. |
| Spec | `specs/artefacts-v1.md` (dossier de travail, hors dépôt ; copie sur morzu-vps dans `~/work/aid-specs/`). Pas de fiche V4 pour cet écran (programme 0.d) : la spec en tient lieu. |
| Programme | `programme.md`, ligne 30 ; §3 règle 9 ; §5 bis |
| Validation | Julien. Recette sous Node 22 et 24, dans le navigateur **et** dans l'app (WKWebView). |

## 1. Pourquoi

Les agents produisent des choses à regarder, pas à relire ligne à ligne : une page HTML, un rapport Markdown, un graphique interactif, un schéma SVG. Aujourd'hui, A-I-D n'affiche un `.html` qu'en source.

Ce chantier ajoute un onglet Artefacts à l'écran Sujet. Le Markdown y est rendu dans la page. Le HTML et le SVG tournent sur une **origine isolée** : ils ne voient ni le cookie du cockpit, ni son API, ni le réseau par `fetch`, XHR ou WebSocket.

## 2. État actuel

Abréviations : `SE` = `src/daemon/security.ts`, `SV` = `src/daemon/server.ts`, `MA` = `src/daemon/main.ts`, `CF` = `src/daemon/config.ts`, `FI` = `src/daemon/routes/files.ts`, `OF` = `web/src/ecrans/OngletFichiers.tsx`, `PC` = `web/src/ecrans/PanneauContexte.tsx`, `MD` = `web/src/ui/markdown.tsx`, `CO` = `web/src/conversation/Composer.tsx`.

| Zone | Où | Ce qui existe |
|---|---|---|
| Garde du worktree | `FI:29-42` (`resolveUnderWorktree`) | Chemin résolu sur le réel, symlinks compris ; 404 introuvable, 422 hors worktree |
| Lecture d'un fichier | `FI:12` (`MAX_CONTENT_BYTES`, 1 Mo), `FI:55` (`isBinary`) | 1 Mo au plus, binaire refusé |
| Statut git des fichiers | `FI:9` (`gitFileStatuses`), `FI:117` (`pruneToModified`) | La portée « modifiés » |
| Rendu Markdown | `MD:237` (`renderMarkdown`) | Tokens rendus en JSX, sans `innerHTML` |
| Visionneuse de Fichiers | `OF:220-222` | Aperçu ou source d'un `.md` ; tout le reste en source |
| Onglets du panneau | `PC:13-35` (`ONGLETS_FIXES`, `DATA_NODE`) | Sujet, Git, Fichiers, Livraison, puis les onglets de mémoire |
| Hôte et origine | `SE:92-105` | 421 si `Host` ≠ `127.0.0.1:<port>` ou `localhost:<port>` ; 403 si `Origin` présente et étrangère |
| Cookie de session | `SE:117-123` | `HttpOnly`, `SameSite=Strict`, `path=/` |
| GET authentifié par cookie | `SE:147-151` | Un GET sans `Origin` passe (c'est une navigation). Seuls les autres verbes et `/ws/` exigent l'`Origin` |
| CSP de la page | `SE:161-174` | `default-src 'self'` ; pas de `frame-src` ni de `frame-ancestors` |
| Journal des requêtes | `SV:83-84` (`redactToken`), `SV:109-114` | Méthode, URL (`?token=` masqué), hôte ; aucun en-tête. Seules les requêtes en échec sont écrites |
| Écoute | `MA:261`, `CF:62-66` | `127.0.0.1:4870` par défaut ; `AidPortInUse` sur `EADDRINUSE` |
| Ports de l'e2e | `e2e/global-setup.ts:7`, `e2e/remote-control.spec.ts:15` | 4871, 4872, 4873 |
| Pont Tauri | `SE:163-166` | 4871 |
| App Tauri | `app/src-tauri/src/lib.rs:115`, `app/src-tauri/capabilities/default.json` | La fenêtre `main` charge le cockpit en `WebviewUrl::External`. La capacité `default` n'a aucune entrée `remote` |
| Pièce jointe sur un serveur | `CO:58`, `CO:70-75` | `useAgentRoutes().distant` décide de ce qui est permis hors du Mac |

## 3. Cible et hors-périmètre

**Cible** : `specs/artefacts-v1.md`, sections « L'onglet Artefacts », « La frontière d'origine », « Règles » et « Pièges connus », corrigées par la relecture du lab.

**Hors-périmètre** :
- la bibliothèque de graphiques et Mermaid ;
- les artefacts d'un sujet sur un serveur, en mode host (31) ou sur le téléphone (32) ;
- la surveillance du fichier, le rechargement automatique et le journal des violations de CSP ;
- `postMessage` entre l'artefact et le cockpit.

Aucune lecture ni écriture du board, aucune commande swarph, aucune migration.

## 4. Décisions

| # | Décision | Raison |
|---|---|---|
| **D161** | **Ce qu'est un artefact.** Un fichier du worktree du sujet en `.html`, `.htm`, `.md` ou `.svg`. `GET /api/topics/:id/artefacts` (`src/daemon/routes/artefacts.ts`) rend les fichiers de ces types qui ont un statut git (portée « modifiés » de `FI`), avec le statut et l'heure de modification, du plus récent au plus ancien. Un fichier de ces types ouvert depuis Fichiers (D168) s'affiche aussi, même sans statut. | Q1. |
| **D162** | **Le second port.** Une seconde instance Fastify (`src/daemon/artefacts/serveur.ts`), lancée au démarrage du daemon, sur `127.0.0.1` seulement. Son port est `artefacts.port` (`CF`), par défaut le port du daemon + 10 (4880). Elle refuse de démarrer sur le port du daemon et sur 4871.<br>• Pas de plugin cookie, aucune route de l'API : seulement `GET /a/:jeton`. Tout le reste répond 404, tout autre verbe 405.<br>• 421 si `Host` n'est pas `127.0.0.1:<port>` ni `localhost:<port>`. **C'est aussi la défense contre le DNS rebinding**, et le code le dit.<br>• Le journal reprend le sérialiseur de `SV:113`, chemin masqué en `/a/***`. Aucun en-tête n'est écrit : le navigateur envoie le cookie de session à ce port aussi.<br>• Port occupé : le daemon démarre quand même, `GET /api/artefacts/etat` rend `{ disponible: false, port, raison }`, l'onglet le dit et `aid doctor` le signale (⚠). *Révision 30.4 : une route à part plutôt qu'un champ de `/api/state`, pour ne pas toucher au modèle de l'état.* | Q3 ; lab point 4 et point 5. |
| **D163** | **Le lien.** `POST /api/topics/:id/artefacts/lien`, corps `{ path }`, sur le port principal, authentifié. Il lit le fichier **à cet instant** : garde de `FI`, 1 Mo, binaire refusé, type parmi ceux de D161. Il garde en mémoire `{ contenu, type, empreinte, expireA }` sous un jeton de 32 octets aléatoires en base64url, puis rend `{ url, expireA }`. L'URL suit l'hôte de la page (`127.0.0.1` ou `localhost`) et ne contient ni le jeton admin, ni le cookie, ni l'id du sujet.<br>Le jeton est **limité dans le temps, pas à un seul usage** : il reste valable 10 minutes, autant de fois qu'on veut, et se perd au redémarrage. Les jetons expirés sont purgés à chaque émission ; au-delà de 200 jetons vivants, le plus ancien part. La réponse porte `Cache-Control: no-store`. | Q3 ; lab point 5 : dire « limité dans le temps ». |
| **D164** | **Les réponses du second port.** `Content-Type` `text/html; charset=utf-8` pour `.html` et `.htm`, `image/svg+xml` pour `.svg`. Le second port ne sert jamais un `.md` (D167).<br>`Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors http://127.0.0.1:<port> http://localhost:<port>`, avec le port du daemon.<br>Plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, et aucun `Set-Cookie`. Jeton inconnu ou expiré : 404, sans corps qui le répète. | La spec, couche 3. |
| **D165** | **Le port principal ne répond plus à un document étranger.** Correction exigée par le lab (MUST 2). Dans le hook `onRequest` de `SE`, pour un principal `admin` venu par cookie :<br>• `Origin: null` vaut refus (403 « origine refusée ») sur toutes les routes ;<br>• sur `/api/` et `/ws/`, un `Sec-Fetch-Site` présent et différent de `same-origin` vaut refus (403 « requête inter-site »).<br>Un client sans `Sec-Fetch-Site`, c'est-à-dire le CLI, les agents (bearer) ou un `inject` de test, n'est pas touché.<br>**Écart avec la lettre du lab**, à lui signaler : il demandait de refuser tout ce qui n'est pas `same-origin`, en-tête absent compris. Refuser l'absence casserait les clients bearer, et une page qui navigue depuis l'artefact envoie toujours l'en-tête : Chromium depuis la version 76, Firefox depuis la 90, WebKit depuis Safari 16.4. La recette le vérifie dans WKWebView (D170).<br>*Révision 30.8 (lab, DM 91283) : la règle suit l'authentification. En bearer, l'absence de `Sec-Fetch-Site` ne refuse rien. Par cookie, son absence vaut 403 sur `/api/` (« requête sans provenance »), sauf avec `x-aid-cockpit: 1`, que seul le fetch du cockpit pose (`src/shared/cockpit.ts`, `web/src/data/api.ts`). Sur `/ws/`, l'Origin exacte du cockpit, déjà exigée, est maintenant testée.* | Lab, MUST 2 (a), et L1. La garde ne dépend plus de la façon dont le navigateur traite le cookie pour une origine opaque. |
| **D166** | **La CSP de la page change sur une seule ligne** (`SE:169-170`). Elle gagne `frame-src http://127.0.0.1:<port des artefacts> http://localhost:<port des artefacts>` et `frame-ancestors 'none'`. Aucune page du cockpit n'en encadre une autre : rien, ni l'API ni le cockpit, ne s'affiche donc dans le cadre d'un artefact. | Spec, couche 4 ; lab, MUST 2 (b). |
| **D167** | **L'onglet Artefacts** (`web/src/ecrans/OngletArtefacts.tsx`, data-node `1-3.onglets.artefacts`), placé après Fichiers. Absent quand l'agent du sujet est distant (`useAgentRoutes().distant`, comme `CO:58` ; à confirmer en 30.6).<br>• **Liste** : nom, type, statut, heure, triée par heure. Si elle est vide : « Aucun artefact sur ce sujet. Un agent en crée en écrivant un fichier .html, .md ou .svg. »<br>• **Markdown** : `renderMarkdown` (`MD:237`) dans la page, avec le contenu lu par `GET /api/topics/:id/files/content`. Ni iframe ni lien.<br>• **HTML et SVG** : `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src={url}>`, sans aucun autre jeton de sandbox. Hauteur réglable.<br>*Révision 30.9 (lab, DM 91283) : « Ouvrir à part » ouvre une enveloppe, `/v/<jeton>` sur le port des artefacts : aucun script (`default-src 'none'`), le cadre sandboxé seul, `frame-src 'self'`, `frame-ancestors 'none'`. L'artefact y est de nouveau un cadre. Pas de `sandbox` sur l'enveloppe, à la différence de la proposition du lab : une origine opaque ne satisferait pas le `frame-ancestors` de l'artefact, qui accepte maintenant aussi son propre port. Sans script, l'enveloppe ne fait rien de son origine. Le second port ne renvoie jamais le chemin ni la requête. Reste noté par le lab (DM 91330), sans correction : ce `frame-ancestors` admet tout le port des artefacts, donc un artefact qui connaît le `/a/<jeton>` d'un autre peut l'encadrer. Il lui faut un jeton valide, et chaque cadre reste opaque.*<br>• **Recharger** redemande un lien et met à jour « Lu à ». **Ouvrir à part** est un `<a target="_blank" rel="noopener noreferrer">` vers le même lien.<br>• **La phrase sous le cadre, corrigée (lab MUST 1)** : « Ni fetch, ni XHR, ni WebSocket : cet artefact ne charge rien. Il peut encore naviguer dans son propre cadre. »<br>• **Cadre fermé à la deuxième page.** Au deuxième événement `load` du cadre, l'onglet le remplace par « L'artefact a quitté sa page : cadre fermé. Recharger pour le rouvrir. » Cela limite la fuite sans l'empêcher : la requête est déjà partie. Le code le dit. | Q2, Q4, Q5, Q6 ; lab MUST 1. |
| **D168** | **Fichiers renvoie vers Artefacts.** La visionneuse (`OF:220`) gagne « Ouvrir dans Artefacts » pour un `.html`, `.htm`, `.md` ou `.svg`. Le lien sélectionne l'onglet Artefacts et ce fichier. | Q1. |
| **D169** | **L'e2e mesure la frontière.** Il n'utilise que des artefacts synthétiques. Un artefact de test vérifie, par ses propres scripts, que :<br>• `document.cookie` est vide ;<br>• `localStorage` lève `SecurityError` ;<br>• `fetch` vers l'API du daemon échoue ;<br>• `fetch` vers un serveur local « extérieur » échoue ;<br>• une navigation du cadre vers `GET /api/state` du port principal reçoit 403 (D165).<br>*Révision 30.7, mesurée sous Chromium : dans le cadre, cette navigation ne part pas (le `frame-src` du cockpit, D166, s'applique à chaque navigation du cadre). Elle est mesurée « à part » : 401, sans cookie (SameSite=Strict) et avec `Sec-Fetch-Site: cross-site`.*<br>Il publie son verdict dans son titre, que le test lit ; une page qui ne publie rien est un échec.<br>**La limite connue est épinglée, pas cachée** : `location.href` et `<meta http-equiv=refresh>` vers ce serveur extérieur **l'atteignent**, et le test l'affirme. L'onglet ferme ensuite le cadre (D167).<br>*Révision 30.7, mesurée sous Chromium : dans le cadre, elles ne l'atteignent pas (`frame-src` du cockpit) ; la limite est réelle « à part », et le test l'affirme là. La fermeture au second load ne joue pas pour un script qui navigue pendant le chargement (un seul load) : épinglé. WebKit n'est pas mesuré : recette.* | Spec, règles ; lab MUST 1 et MUST 2 : « l'e2e est l'endroit où chaque point se mesure ». |
| **D170** | **Tauri.** Un test lit `app/src-tauri/capabilities/*.json` et échoue si une capacité porte une entrée `remote`. Une telle capacité donnerait l'IPC à une origine chargée par URL, comme le cockpit, et a fortiori l'artefact.<br>La recette, faite dans l'app, vérifie :<br>• sur une page « Ouvrir à part » : `localStorage` lève `SecurityError` et `document.cookie` est vide, ce qui prouve l'origine opaque sous WebKit (le lab n'a pas pu l'évaluer) ;<br>• que `window.__TAURI_INTERNALS__` est absent dans le cadre ;<br>• que WKWebView envoie `Sec-Fetch-Site` (D165) ;<br>• où s'ouvre « Ouvrir à part ». Le navigateur système est attendu ; une nouvelle fenêtre de webview est un défaut à corriger, à porter dans la fiche. | Lab point 3. |

## 5. Points

Chaque point est un commit, avec le gate vert. Le message de commit compte les lignes existantes modifiées. Les styles nouveaux vont dans `web/src/styles/artefacts.css` (nouveau), jamais dans `maquette.css`.

### 30.1 Le plan

- **Fichiers** : ce plan.
- **Vérification** : `npm run gate`

### 30.2 Le test de focus du panneau, rendu robuste

- **Pourquoi** : `test/web/panneau-contexte.test.tsx:190` (« repli sur Plan… y rend le focus ») a échoué une fois sous Node 24 en CI sur la PR #123, puis est passé à la relance. Son `expect` sur le focus est synchrone, juste après un `waitFor`. Ce chantier ajoute un onglet au même panneau.
- **Fichiers** : `test/web/panneau-contexte.test.tsx:188-190`, dont les assertions passent dans un `waitFor` (lignes modifiées comptées). Aucune ligne de produit.
- **Vérification** : `npm run gate`, et 20 passages de ce fichier sous Node 24.

### 30.3 Le port principal refuse un document étranger

- **Fichiers** :
  - `SE` : `Origin: null` et `Sec-Fetch-Site` (D165), insérés dans le hook `onRequest` ;
  - `frame-ancestors 'none'` (D166, ligne CSP modifiée et comptée). `frame-src` arrive en 30.4 avec le port ;
  - des tests dans `test/security.test.ts` :
    - un GET par cookie avec `Sec-Fetch-Site: cross-site`, puis `same-site`, donne 403 ;
    - avec `same-origin`, 200 ;
    - sans l'en-tête, 200 ;
    - par bearer avec `cross-site`, 200 ;
    - `Origin: null`, 403 ;
    - un `/ws/` inter-site, 403 ;
    - la navigation de premier niveau `/?token=` (`Sec-Fetch-Site: none`), qui pose toujours le cookie.
- **Vérification** : `npm run gate`, puis `npm run gate:e2e`. Le cockpit entier passe par ce hook : l'e2e prouve qu'aucun écran n'est cassé.

### 30.4 Le second port et le lien

- **Fichiers** :
  - `CF` : `artefacts.port` (insertion) ;
  - `src/daemon/artefacts/jetons.ts` : émission, lecture, expiration, purge, plafond (D163). Fonctions pures sur une horloge injectée ;
  - `src/daemon/artefacts/serveur.ts` : D162 et D164 ;
  - `MA` : démarrage et arrêt du second port, à côté de `MA:261` (insertion) ; `GET /api/artefacts/etat` ;
  - `SE:169-170` : `frame-src` (D166, même ligne, comptée) ;
  - `src/daemon/routes/artefacts.ts` : `POST /api/topics/:id/artefacts/lien` ;
  - `src/cli/commands/doctor.ts` : la ligne « port des artefacts » (insertion) ;
  - les tests :
    - `test/artefacts-jetons.test.ts` : expiration à 10 minutes, réutilisation dans la fenêtre, purge, plafond ;
    - `test/artefacts-serveur.test.ts` : en-têtes exacts, aucun `Set-Cookie`, 421 sur un hôte étranger, 404 sur un jeton inconnu ou expiré, 405 sur `POST`, 404 sur `/api/state`, journal sans cookie ni jeton (vérifiés sur des valeurs synthétiques), port occupé, refus de 4871 et du port du daemon ;
    - `test/artefacts-routes.test.ts` : lien sur un fichier hors worktree (422), binaire, plus de 1 Mo, type refusé, `.md` refusé, `Cache-Control: no-store`, URL sans id de sujet.
- **Vérification** : `npm run gate`

### 30.5 La liste des artefacts

- **Fichiers** : `src/daemon/routes/artefacts.ts` : `GET /api/topics/:id/artefacts` (D161) ; `src/shared/artefacts.ts` (types) ; tests dans `test/artefacts-routes.test.ts`, sur un dépôt git synthétique : types filtrés, tri par heure, fichier ajouté ou modifié, sujet inconnu, worktree absent.
- **Vérification** : `npm run gate`

### 30.6 L'onglet Artefacts

- **Fichiers** :
  - `PC:13-35` : l'onglet et son data-node (insertions) ;
  - `web/src/ecrans/OngletArtefacts.tsx` (nouveau, D167) ;
  - `web/src/data/artefacts.ts` (nouveau) ;
  - `OF:220` : « Ouvrir dans Artefacts » (D168, insertion) ;
  - `web/src/styles/artefacts.css` ;
  - les tests dans `test/web/artefacts.test.tsx` :
    - liste vide, Markdown rendu sans iframe, HTML dans un cadre aux attributs exacts ;
    - Recharger, Ouvrir à part ;
    - fermeture au deuxième `load` ;
    - port indisponible ;
    - onglet absent pour un agent distant.
- **Vérification** : `npm run gate`, puis `npm run gate:e2e`, puisque le panneau change.

### 30.7 L'e2e de la frontière, et la fiche de recette

- **Fichiers** :
  - `e2e/artefacts.spec.ts` : son propre daemon, au port de l'e2e + 1 comme les specs à agents (lancés en série, chacun arrête le sien). Il ouvre l'onglet, un `.md`, un `.svg` et le `.html` de D169, puis vérifie chaque verdict. Un serveur « extérieur » local compte les requêtes qu'il reçoit ;
  - `test/tauri-capacites.test.ts` (D170) ;
  - `docs/recette-chantier-30-artefacts.md` : la recette réelle, dans Chrome, Safari et l'app, avec les vérifications de D170.
- **Vérification** : `npm run gate` et `npm run gate:e2e`

## 6. Pièges

- **Le cookie va aussi au second port.** Il ignore le port. Le second port ne l'enregistre ni ne le lit, et ne l'écrit jamais dans un journal.
- **`Sec-Fetch-Site` absent n'est pas un refus** (D165). Les tests de 30.3 couvrent le CLI et les agents, qui passent en bearer.
- **Aucun écran du cockpit ne doit tomber sous D165.** Chaque `fetch` du cockpit vise sa propre origine, donc `same-origin`. L'e2e complet de 30.3 le vérifie, et le mode dev (`devOrigin`) aussi : une page servie par Vite sur un autre port envoie `same-site`. **À traiter en 30.3** : `devOrigin` doit rester accepté, sans quoi `npm run dev` casse.
- **Les ports.** Les artefacts écoutent sur 4880. L'e2e utilise 4871 à 4873, ses artefacts 4881 à 4883 : aucun ne tombe sur un port de l'e2e ni sur le pont Tauri.
- **`localhost` contre `127.0.0.1`.** Le lien suit l'hôte de la page, et `frame-ancestors` comme `frame-src` acceptent les deux.
- **Le contenu est celui lu à l'émission** (empreinte), pas le fichier à jour : Recharger.
- **Un artefact peut boucler.** Le cadre est isolé, pas limité. Fermer l'onglet l'arrête.
- **Jamais le vrai claude, codex ni gh** en test ou en e2e : `test/fixtures/bin-stream`. Les artefacts sont synthétiques.
- **Le daemon de travail de Julien** : des agents y tournent. Aucun redémarrage ni changement d'installation sans son accord.

## 7. Fini quand

- Les points 30.1 à 30.7 sont commités, un par point, avec `npm run gate` vert sur chacun et `npm run gate:e2e` vert en 30.3, 30.6 et 30.7.
- La recette de Julien est faite sous Node 22 et 24, dans Chrome, Safari et l'app, et sa fiche est remplie, D170 compris.
- L'écart de D165 a été signalé au lab.
- Julien a mergé la PR.
