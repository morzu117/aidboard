# Chantier 32 : L'app mobile

| Champ | Valeur |
|---|---|
| État | **Révision 0, 7 novembre 2026.** Spec validée par Julien (« ok sur tout »). Relecture légère du lab faite sur la frontière (DM 91867, carte #1449) : quatre conditions, C1 à C4, reprises ici. Julien a retenu le filtre de valeurs pour C1. |
| Emplacement final | `docs/chantiers/32-mobile.md` sur `main`, dans le premier commit du chantier |
| Base | **ca2e178** (`origin/main`, PR #125). Les `fichier:ligne` ont été lus sur cette base. |
| Spec | `specs/mobile-v1.md`, révision 2 (dossier de travail, hors dépôt ; copie sur morzu-vps dans `~/work/aid-specs/`). Fiche V4 `mobile.md` (DM 91344). Les maquettes `ecrans/Mobile*.html` n'ont pas encore été reçues : elles ajusteront la mise en page, pas les décisions. |
| Programme | `programme.md`, ligne 32 ; §5 bis ; §7 |
| Organisation | morzu-vps gère le chantier. Le code et les tests de chaque point sont écrits par un agent Codex CLI, dans son propre worktree, sur un brief tiré de ce plan. morzu-vps relit chaque diff, lance le gate et l'e2e, et commite. Tout diff qui touche aussi un test de frontière (liste fermée, clés exactes de l'état masqué, signal) est signalé au lab. |
| Validation | Julien (programme §5 bis), par la recette sur un iPhone et un Android. Le lab revoit la frontière à la fin (points 32.3 à 32.6). |

## 1. Pourquoi

Le 31 a ouvert le cockpit au téléphone, en lecture, dans un navigateur. Le 32 en fait une app installée, mise en page pour le téléphone, avec ses trois onglets : À traiter, Sujets, Board. On y suit ses sujets, on y relit les tours, et on y tranche les questions des agents. Les permissions et le merge restent sur le Mac.

## 2. État actuel

Abréviations : `HS` = `src/daemon/host/serveur.ts`, `MQ` = `src/daemon/host/masque.ts`, `SH` = `src/shared/host.ts`, `AA` = `web/src/AppAppareil.tsx`, `AP` = `web/src/data/appareil.ts`, `CL` = `web/src/data/client.ts`, `SW` = `web/public/sw.js`, `BV` = `web/src/ui/boiteVue.ts`, `LV` = `web/src/ui/livraisonVue.ts`, `AG` = `src/daemon/routes/agents.ts`, `CC` = `src/daemon/conversation/claude.ts`.

| Zone | Où | Ce qui existe |
|---|---|---|
| Liste fermée | `HS:224-358`, `test/host-liste.test.ts:32-44` | Appareils, appairage, `GET /api/state` masqué, `/ws/signal`, board en lecture, la coque. Aucune écriture hors gestion des appareils. |
| État masqué | `MQ:14-84`, `SH:52+`, `test/host-masque.test.ts:122,128` | Sujets, runs, actions (sans nom), agents (`attend`, `statusReason` réduit), mesh, métadonnées de la boîte. Ni `pending`, ni `statusMessage`. |
| Gardes | `HS:172-203` | Host (421), Origin, `Sec-Fetch-Site`, `x-aid-cockpit: 1`, cookie d'appareil (401 avec `raison`). |
| Répondre | `AG:107-112`, `CC:456-475` | `POST /api/agents/:id/answer {pendingId, answer}`. Une question vient de l'outil de question de l'agent (`kind: 'question'`), avec ses options, plus `ASK_TEXT_ANSWER` (`CC:82`, réponse en texte). |
| Modes d'agent | `src/shared/agentSettings.ts:81-88` | `default`, `acceptEdits`, `auto`, `plan` ; `Agent.permissionMode` dans l'état (`src/daemon/state/snapshot.ts:108`). |
| Tour à relire | `BV:23-25,58` | Ton `relire` ou `erreur` ; résumé = première ligne de `statusMessage`, 140 caractères (`resumeTour`). **Pas d'état « relu ».** |
| Merge | `LV:193-214`, `web/src/ecrans/Livraison.tsx` | `blocageMerge` et `citations` côté client ; `GET /api/topics/:id/git/livraison` (comptes par fichier, pas de contenu). |
| Interface d'un appareil | `AA:9-78`, `web/src/styles/appareil.css:1-2` | Barre réduite, aucune media query. Bannière « Mac injoignable » seulement après un premier état. |
| Démarrage à froid | `AP:124-135` | Mac injoignable → `{kind:'mac'}` : l'app installée monterait l'interface du Mac. |
| Service worker | `SW:16-18` | Réseau d'abord ; met en cache **toute** réponse de navigation, une 502 comprise ; saute `/api/`, `/ws/`, `/auth`, `/appairage/`. |
| PWA | `web/index.html` | Pas de manifeste, pas d'icônes hors `favicon.svg`, pas de `theme-color`. |
| Migrations | `migrations/020_appareils.sql` | La dernière ; ce chantier ajoute la 021. |

## 3. Cible et hors-périmètre

**Cible** : `specs/mobile-v1.md`, révision 2, questions 1 à 9, « La frontière » (C1 à C4) et « Pièges connus ».

**Hors-périmètre** :
- les notifications push et la lecture d'un diff (32 bis, relu par le lab) ;
- le merge depuis le téléphone (34, 43) ; répondre à une permission (§7) ;
- les critères et les findings d'un merge ;
- les cartes offertes, les demandes de pairs, les canaux, les accusés (35, 36) ;
- le texte du plan d'un sujet : seule sa phase sort ;
- conduire un agent, créer un sujet, ouvrir un terminal.

## 4. Décisions

| # | Décision | Raison |
|---|---|---|
| **D184** | **La coque d'un appareil, en cache seulement.** `SW` ne met en cache qu'une réponse de navigation 200, et la coque statique ; jamais `/api/`, `/ws/`, `/appairage/`. Un 401 du port des appareils pour `revoque` ou `expire` porte `Clear-Site-Data: "cache", "storage"`. | Lab C4 ; défaut du 31 (la 502 de Serve en cache). |
| **D185** | **Le mode retenu au démarrage.** L'appareil garde dans `localStorage` une seule marque, `aid.mode = appareil`, posée quand `GET /api/appareils/moi` répond 200, effacée sur un 401. Au démarrage à froid sans réponse, la marque présente choisit l'interface d'un appareil et l'écran « Mac injoignable ». | Défaut du 31 (`AP:132`). Aucun jeton : le cookie reste `HttpOnly`. |
| **D186** | **Le filtre de valeurs.** `src/daemon/host/filtre.ts`, `filtrerTexte(s): string`. Il remplace par `[masqué]` : chemins absolus et `~/…`, URL, noms `*.ts.net`, adresses IPv4 et IPv6, suites base64 ou hexadécimales de 24 caractères ou plus, préfixes de jeton connus (`sk-`, `ghp_`, `gho_`, `github_pat_`, `xox`, `AKIA`, `eyJ`). Puis il coupe à 140 caractères. Il s'applique à tout texte d'agent qui entre dans l'état masqué, et à rien d'autre. | Lab C1, choix de Julien. Le filtre réduit le risque sans l'annuler (spec). |
| **D187** | **La question en attente, masquée.** Pour un agent dont `pending.kind === 'question'`, l'état masqué ajoute `question: { pendingId, texte, options: string[] }`, texte et options passés par D186, **sans** `ASK_TEXT_ANSWER`. Pour une permission, rien de plus que `statusReason: 'permission'`. Jamais la commande, l'outil, `byRule`. | Spec Q3 ; lab C1, C2. |
| **D188** | **Le résumé de fin de tour et l'état relu.** L'état masqué ajoute, pour un agent au ton `relire` ou `erreur`, `tour: { id, resume, relu, aReprendre }`. `resume` est `resumeTour` passé par D186. `id` identifie le tour (la séquence du dernier message de l'agent). | Spec Q4. |
| **D189** | **« Relu » et « À reprendre sur le Mac ».** Migration `021_tours_relus.sql` : `(agent_id, tour_id, etat ∈ relu|a_reprendre, par, a)`, où `par` vaut `mac` ou l'id de l'appareil. Un nouveau tour rend l'ancienne ligne sans effet. Routes : `PUT /api/agents/:id/tour` (Mac) et `POST /api/appareils/agents/:id/tour` (appareil), corps `{ tourId, etat }`. Un `tourId` qui n'est pas le tour courant rend 409. La boîte du Mac montre la marque et qui l'a posée. | Spec Q4. |
| **D190** | **Trancher une question depuis un appareil.** `POST /api/appareils/agents/:id/reponse { pendingId, option: number }`. Le serveur vérifie, dans cet ordre : appareil valide ; agent connu ; `permissionMode` ∈ {`default`, `plan`} (sinon 403 `mode`) ; une demande en attente de `kind === 'question'` (sinon 403 `nature`) ; `pendingId` identique (sinon 409 `perimee`) ; `option` entier dans les options offertes, hors `ASK_TEXT_ANSWER` (sinon 400). La réponse transmise est `options[option].answer`. Le premier gagne : compare-and-set atomique sur le `pendingId` ; le second reçoit 409 `deja_tranchee`. | Lab C2, C3, recommandation ; §7. |
| **D191** | **Le journal des écritures d'un appareil.** Chaque écriture acceptée (D189, D190) émet un événement `appareil.ecriture { appareilId, nom, route, agentId }`, visible dans le fil d'activité du Mac. Rien du texte de la réponse. | Spec, « La frontière ». |
| **D192** | **La livraison vue d'un appareil.** `GET /api/appareils/sujets/:id/livraison` rend `{ head, fichiers: { nom, ajouts, retraits }[], controles, revue: { surLaTete }, blocage?, citations }`. `nom` est le chemin relatif au dépôt, passé par D186 pour les segments seulement. Les blocages sont calculés **côté serveur** par la même fonction que le Mac (`blocageMerge`, déplacée dans `src/shared/`). Les actions d'un tour sont désignées par leur identifiant fixe d'A-I-D (`topic.merge`, …), jamais par un outil d'agent. | Spec Q4, Q7 ; lab, recommandation. |
| **D193** | **L'app installée.** `web/public/manifest.webmanifest` (`display: standalone`, `start_url: /`, `scope: /`, couleurs d'A-I-D), icônes 192 et 512 px et `apple-touch-icon`, `theme-color`. Sur iPhone hors installation, un rappel « Ajouter à l'écran d'accueil ». | Spec Q2. |
| **D194** | **Le dernier état connu.** L'état masqué est gardé dans IndexedDB (`aid-appareil`, une entrée, datée). L'écran « Mac injoignable » le montre avec son âge ; aucune écriture n'est offerte. Un 401 l'efface, comme D184. | Spec Q8. |
| **D195** | **La coque mobile.** Trois onglets en bas : À traiter, Sujets, Board (sans swarph, deux onglets). Cibles de 44 px au moins, aucune largeur fixe, pas de défilement horizontal à 320 px. Les écrans de la fiche Mobile, réduits à ce que D187 à D194 permettent ; « Informations » et « Notifications » en lecture, sur l'état masqué. Badge de l'icône par `navigator.setAppBadge` quand l'app est ouverte, si le navigateur le permet. | Spec Q1, Q5 ; fiche Mobile. |

## 5. Points

Chaque point de code est un brief à Codex. Un point est fini quand son diff est relu, `npm run gate` vert, et commité par morzu-vps.

### 32.1 Le plan
Ce document. Pas de code.

### 32.2 Les deux défauts du 31 (D184, D185)
- `SW` : cache de la coque seulement, réponses 200.
- `HS` : `Clear-Site-Data` sur le 401 `revoque` et `expire`.
- `AP` : la marque `aid.mode`, et le choix au démarrage à froid.
- Tests : `SW` (une 502 n'écrase pas la coque), le 401 et son en-tête, `detecterMode` à froid avec et sans marque.

### 32.3 Le filtre de valeurs (D186)
- `src/daemon/host/filtre.ts`, pur, sans dépendance.
- Tests : un cas par motif, des faux positifs courants (une phrase française, un numéro de PR, une date), la coupe à 140 caractères, l'idempotence.

### 32.4 La question et le tour dans l'état masqué (D187, D188)
- `MQ`, `SH` : `question` et `tour`, tout texte passé par D186.
- Tests : les clés exactes mises à jour ; une permission ne donne ni texte ni option ; `ASK_TEXT_ANSWER` absent ; un chemin, une URL et un jeton dans la question n'en sortent pas.
- **Frontière : signalé au lab.**

### 32.5 Relu et À reprendre (D189, D191)
- Migration 021, projecteur, routes du Mac et de l'appareil, événement `appareil.ecriture`.
- La boîte du Mac montre la marque.
- Tests : 409 sur un tour périmé, l'effacement par un nouveau tour, la liste fermée (`test/host-liste.test.ts`) avec la nouvelle route.
- **Frontière : signalé au lab.**

### 32.6 Trancher une question (D190, D191)
- La route, ses six vérifications dans l'ordre, le compare-and-set.
- Tests : un test par refus (`mode` pour `acceptEdits` et `auto`, `nature`, `perimee`, option hors bornes, option texte), deux réponses concurrentes, appareil révoqué entre deux, la liste fermée.
- **Frontière : signalé au lab.**

### 32.7 La livraison vue d'un appareil (D192)
- `blocageMerge` et `citations` déplacés dans `src/shared/`, le Mac inchangé à l'écran.
- La route, la liste fermée.
- Tests : les clés exactes, un chemin absolu absent, les blocages identiques au Mac sur les cas de `LV`.

### 32.8 L'app installée et le dernier état (D193, D194)
- Manifeste, icônes, `theme-color`, rappel iPhone.
- IndexedDB, l'écran « Mac injoignable » avec l'âge, l'effacement sur 401.

### 32.9 La coque et À traiter (D195)
- Les trois onglets, la mise en page mobile.
- À traiter : décisions (trancher une question, avec « Confirmer »), tours à relire, en cours ; « Une autorisation t'attend, sur le Mac » sans bouton.
- « Rien à traiter, sans swarph ».

### 32.10 Les autres écrans (D195)
Sujets (filtre par état, nom en gras s'il t'attend), Suivre un sujet (prochaine décision, phase, dernier tour), Relire un tour, Autoriser un merge (en lecture, « se confirme sur le Mac »), Board et Lire une carte (repris du 31), Informations, Notifications, Appareils connectés, Ajouter ce téléphone.

### 32.11 L'e2e et la fiche de recette
- `e2e/mobile.spec.ts`, Chromium à 390 × 844 et à 320 px, sur le frontal de `e2e/serve-local.ts` :
  - installer : le manifeste se lit ;
  - trancher une question, et constater qu'une permission n'a pas de bouton ;
  - marquer relu, vu sur le Mac ;
  - Mac coupé : le dernier état et son âge ;
  - révoquer : « Accès coupé », et le stockage vidé ;
  - aucun défilement horizontal à 320 px.
- `docs/recette-chantier-32-mobile.md` : iPhone installé (cookie `__Host-`, `Sec-Fetch-Site`, stockage distinct de Safari), Android, Node 22 et 24.

## 6. Pièges

- **iOS :** le stockage d'une app installée est séparé de celui de Safari ; un appareil appairé dans Safari peut devoir l'être à nouveau dans l'app. L'écran le dit.
- **Le filtre ne voit pas tout :** un secret écrit en clair dans une phrase passe. Accepté par Julien ; le dire dans la recette.
- **Les réponses concurrentes :** Mac et téléphone en même temps. Le compare-and-set de D190 couvre aussi la route du Mac.
- **Les agents Codex de l'utilisateur :** `codex.ts` n'émet que des permissions, pas de questions ; un agent Codex n'est donc jamais tranchable depuis un appareil.
- **Codex constructeur :** un brief ne demande jamais de modifier un test de frontière sans le dire ; morzu-vps le vérifie au diff.

## 7. Fini quand

- Les points 32.1 à 32.11 sont commités, un par point, `npm run gate` vert sur chacun, `npm run e2e` vert en 32.9, 32.10 et 32.11.
- Le lab a revu la frontière (32.3 à 32.6).
- La CI de la PR est verte ; morzu-vps merge.
- La recette de Julien est faite sur un iPhone et un Android, et sa fiche remplie.
