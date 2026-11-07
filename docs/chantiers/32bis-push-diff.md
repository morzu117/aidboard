# Chantier 32 bis : les notifications push et la lecture d'un diff

| Champ | Valeur |
|---|---|
| État | **Révision 0, 7 novembre 2026.** Julien a validé la spec, avec toutes ses recommandations, et a choisi l'URL du dépôt comme `sub` VAPID. Le lab a relu la frontière (DM 91947, carte #1449, post 91946) : ses quatre conditions obligatoires et ses recommandations sont reprises ici, en P1 à P4. |
| Emplacement final | `docs/chantiers/32bis-push-diff.md` sur `main`, dans le premier commit du chantier |
| Base | **e52e5b7** (`origin/main`, PR #126). |
| Spec | `specs/mobile-32bis.md`, révision 2 (dossier de travail, hors dépôt ; copie sur morzu-vps dans `~/work/aid-specs/`). Spec du 32 : questions 5 et 6. |
| Organisation | Comme au 32. morzu-vps gère le chantier. Un agent Codex CLI écrit le code et les tests de chaque point, sur un brief tiré de ce plan. morzu-vps relit chaque diff, lance le gate, commite et ouvre la PR. |
| Validation | La recette de Julien, sur un iPhone et un Android, avec **un vrai push vers Apple et vers Google**. Le lab revoit la frontière à la fin. Le merge suit la règle de Julien : la CI verte et la validation du lab. |

## 1. Pourquoi

Le 32 a fait du téléphone un poste pour décider, relire et suivre. Deux manques restent :
- on n'est prévenu d'une décision que si l'app est ouverte ;
- on relit un tour sans voir le code.

Le 32 bis apporte les notifications push et la lecture du diff d'un fichier. Les deux sont **désactivés par défaut** et s'activent sur le Mac.

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| Liste fermée | `src/daemon/host/serveur.ts:236-393`, `test/host-liste.test.ts` | Les routes des appareils, dont `/api/appareils/sujets/:id/livraison` (32.7), `.../reponse` et `.../tour` (32.5, 32.6). |
| Livraison | `src/daemon/git/inspect.ts:388` (`gitLivraison`) | `git diff --numstat/--name-status/--raw --no-renames mergeBase head` : les comptes par fichier, sans contenu. Un renommage y apparaît comme une suppression plus un ajout. |
| Lire un fichier | `fileAtRevision` (`inspect.ts:474`) ; D32 (chantier 11) | Les diffs s'ouvrent dans l'éditeur externe. Aucune vue de diff dans l'interface. |
| Filtre de valeurs | `src/daemon/host/filtre.ts` (32.3) | `filtrerTexte` coupe à 140 caractères ; il masque les longs jetons mixtes, les hex de 24 caractères ou plus, les préfixes connus et `$HOME`. Il ne masque ni une valeur après `password:`, ni un bloc PEM. |
| Mode host | `src/daemon/routes/host.ts:35-80`, `config.modeHost` | Le panneau du Mac : actif ou non, le port, le tailnet. Aucun réglage du push ni du code. |
| Appareils | `migrations/020_appareils.sql`, `src/daemon/host/appareils.ts` | Le registre, la révocation, « Couper tous les accès ». |
| Service worker | `web/public/sw.js` | La coque en cache (32.2). Pas de `push`, pas de `notificationclick`. |
| Notifications | `web/src/ecrans/ParcoursAppareil.tsx` (32.10) | L'écran en lecture et le badge ; il ne demande jamais la permission. |
| Migrations | `migrations/021_tours_marques.sql` | La dernière. Ce chantier ajoute la 022. |

## 3. Cible et hors-périmètre

**Cible** : la spec, révision 2, parties A et B, plus les conditions du lab (P1 à P4) et ses recommandations.

**Hors-périmètre** :
- répondre à une permission (§7) ;
- merger depuis le téléphone (chantier 43) ;
- le contenu d'une notification au-delà d'un nombre ;
- des notifications pour les tours à relire ;
- le diff d'un fichier qui n'est pas dans la livraison ;
- l'édition de code.

## 4. Décisions

| # | Décision | Source |
|---|---|---|
| **D196** | **L'interrupteur « Notifications push » sur le Mac**, désactivé par défaut, dans le panneau du mode host (`config.modeHost.push`). Coupé, le daemon n'envoie rien, les routes d'abonnement répondent 403 `push_coupe`, et le couper efface tous les abonnements. | Spec A4 |
| **D197** | **Les clés VAPID.** Une paire P-256 est générée à la première activation, dans le dossier d'état, en `0600`. La clé publique est servie par `GET /api/appareils/push/cle`. Le JWT ES256 porte `aud` = l'origine de l'endpoint, `exp` à 12 h au plus et `sub: https://github.com/morzu117/aidboard`. Sa signature est au format **r‖s (ieee-p1363)**, pas en DER. | Spec A7 ; lab P4 ; Julien |
| **D198** | **Le chiffrement** `aes128gcm` (RFC 8291) sur `node:crypto`, sans dépendance. Il est testé contre les vecteurs de la RFC 8291, et le jeton VAPID contre la RFC 8292 avec une vérification de signature. Le **remplissage fixe est obligatoire** : tous les messages ont la même taille. | Spec A1 ; lab P4, recommandé |
| **D199** | **L'hôte d'un endpoint, vérifié exactement** (lab P1) : `new URL(endpoint)` ; `protocol === 'https:'` ; ni `username` ni `password` ; un port vide ou `443` ; un hôte égal à une entrée de la liste, ou qui finit par `.` + une entrée. La liste : `web.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`. L'envoi vérifie TLS, ne suit aucune redirection, a un délai court et ne relit ni ne journalise le corps de la réponse. | Spec A5 ; lab P1 |
| **D200** | **L'abonnement** : la migration 022, table `push_abonnements`, une ligne par appareil, `ON DELETE CASCADE`. `POST /api/appareils/moi/push` reçoit `{ endpoint, keys: { p256dh, auth } }`, avec un corps strict : AJV, `additionalProperties: false`, et les longueurs base64url vérifiées. `DELETE /api/appareils/moi/push` le retire. Une réponse 404 ou 410 du service le retire aussi. L'endpoint n'est jamais journalisé, jamais dans l'état, jamais renvoyé. La révocation, « Couper tous les accès » et l'échéance de l'accès effacent l'abonnement. | Spec A5, A6 ; lab, recommandé |
| **D201** | **Le contenu** : la charge chiffrée est `{ "n": N }`, et rien d'autre. L'en-tête `Topic` est une constante sans sens, pour remplacer la notification précédente. Le `TTL` est court (300 s). `Urgency: high`. | Spec A2 ; lab P4 |
| **D202** | **Le déclencheur** : un agent passe en attente d'une question ou d'une permission. Les envois sont regroupés par fenêtre de 30 s ; aucun envoi quand N retombe à 0 ; aucun pour un tour à relire. L'événement `push.envoye { appareilId, statut }` est journalisé, sans endpoint. | Spec A3 |
| **D203** | **Le service worker** : sur `push`, il affiche **toujours** une notification, même si le déchiffrement ou la lecture de la charge échoue. Dans ce cas, le texte est générique : « Une décision t'attend ». C'est une exigence d'iOS. Sur `notificationclick`, il ouvre `/` ou focalise l'app. | Spec A2 ; lab, recommandé |
| **D204** | **L'écran Notifications** : « Activer les notifications » sur un geste, puis `subscribe` avec la clé VAPID, puis `POST`. Il propose aussi « Couper les notifications ». Sur un iPhone où l'app n'est pas installée, il renvoie au rappel d'installation. Si le Mac a coupé le push, il le dit. Sur le Mac, « Appareils connectés » montre qui reçoit les notifications. | Spec A6, A8 |
| **D205** | **L'interrupteur « Montrer le code aux appareils »** sur le Mac, désactivé par défaut (`config.modeHost.code`). Coupé, la route du diff répond 403 `code_coupe`. | Spec B5 |
| **D206** | **La route du diff** : `GET /api/appareils/sujets/:id/fichiers/:index/diff?tete=<sha>`. Le fichier est désigné par son index dans la liste calculée par `gitLivraison`, jamais par un chemin. Si la tête a bougé, la route répond 409 `perimee`. Le diff est produit par `git diff --no-ext-diff --no-textconv --no-color --no-renames mergeBase head -- <chemin>`, car le worktree est écrit par l'agent (lab P3). Il est plafonné à 2 000 lignes ou 200 Ko, puis coupé avec « Suite sur le Mac ». Un fichier binaire donne « Fichier binaire ». La réponse porte `Cache-Control: no-store`. | Spec B1, B2, B4 ; lab P3 |
| **D207** | **Les fichiers refusés en entier** (lab P2a), selon le nom de base, casse ignorée : `.env*`, `*.pem`, `*.key`, `id_*` sauf `*.pub`, `*.p12`, `*.pfx`, `*.ppk`, `*.kdbx`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.pgpass`, `*.tfvars`, `*.tfstate*`, `kubeconfig*`, `credentials*`, `secrets*`. La règle s'applique à l'ancien **et** au nouveau chemin. « Marqués sensibles par le dépôt » est retiré : rien ne le définit aujourd'hui. Un fichier refusé affiche « Fichier sensible : sur le Mac ». | Spec B3 ; lab P2a |
| **D208** | **Le filtre des diffs** : `filtrerCode(ligne)`, construit sur le filtre de valeurs, sans la limite de 140 caractères par ligne. Il ajoute deux règles : (b) un bloc PEM est masqué en entier, de `-----BEGIN` à `-----END`, même s'il s'étend sur plusieurs lignes ; (c) une valeur placée après une clé de nom sensible est masquée, par exemple `password: …`, `"api_key": "…"` ou `TOKEN=…`. Les noms sensibles : `password`, `passwd`, `pwd`, `secret`, `token`, `api[_-]?key`, `auth`, `credential`, `private[_-]?key`, `dsn`, `conn(ection)?[_-]?string`. | Spec B3 ; lab P2b, P2c, recommandé |
| **D209** | **Rien ne reste sur le téléphone** : le diff n'est ni dans le cache du service worker, ni dans IndexedDB. Hors ligne, l'écran dit « Diff indisponible hors ligne ». | Spec B4 |

## 5. Points

### 32b.1 Le plan
Ce document.

### 32b.2 Le chiffrement et le jeton VAPID (D197, D198)
- `src/daemon/push/chiffre.ts` : `aes128gcm`, avec le remplissage fixe.
- `src/daemon/push/vapid.ts` : la génération, le stockage en `0600`, le JWT ES256 en r‖s.
- Les tests : les vecteurs de la RFC 8291, la signature vérifiée par `crypto.verify` en `ieee-p1363`, `aud` et `exp`.
- *Révision 32b.2.* Remplissage fixe à 128 octets de clair (`TAILLE_CLAIR`) ; la fonction de bas niveau accepte un remplissage nul pour reproduire le vecteur de la RFC 8291, à l'octet près. `exp` vaut 12 h moins 60 s. Un fichier de clés aux droits plus larges que `0600` est refusé, jamais corrigé en silence. Gate 2038.

### 32b.3 L'envoi et la liste fermée (D199, D201)
- `src/daemon/push/envoi.ts` : `verifierEndpoint(url)` et `envoyer(abonnement, n)`.
- Les tests de l'hôte, au moins :
  - `http:` ;
  - `user@` et `user:pass@` ;
  - un port autre que 443, et `:443` accepté ;
  - `web.push.apple.com.evil.example` ;
  - `evilweb.push.apple.com` ;
  - `fcm.googleapis.com.` (avec le point final) ;
  - une IP ;
  - un IDN ;
  - `*.notify.windows.com`, refusé.
- Les tests de l'envoi :
  - aucune redirection suivie ;
  - 404 et 410 retirent l'abonnement ;
  - le délai ;
  - le corps de la réponse jamais journalisé.
- *Révision 32b.3.* `fetch` global avec `redirect: 'manual'` et `AbortSignal.timeout(10 s)` ; le transport est injectable pour les tests, et la vérification de l'hôte s'applique toujours avant lui. Le corps de la réponse est annulé sans être lu. Une erreur du transport n'est jamais propagée, car elle pourrait contenir l'endpoint.

### 32b.4 L'interrupteur, l'abonnement et la révocation (D196, D200)
- La migration 022 ; `config.modeHost.push` ; les routes du Mac (`PUT` sur le réglage) et celles de l'appareil (`POST`, `DELETE` et `GET .../push/cle`).
- La liste fermée de `test/host-liste.test.ts` est mise à jour. C'est un test de frontière : le point l'autorise explicitement.
- La cascade est testée sur la révocation, sur « Couper tous les accès » et sur l'échéance.
- *Révision 32b.4.* Les clés étrangères sont actives, mais la révocation pose `revoque_a` sans supprimer la ligne. `abonnementsActifs` efface donc, à chaque lecture, les abonnements des appareils révoqués ou échus, et ne rend que les autres. Les clés VAPID sont dans le dossier d'état (`paths.home`). Les refus du port des appareils sont `{ raison }` (`push_coupe`, `endpoint`, `cles`) ; `PUT /api/host/push`, sur le Mac, garde `{ error }`. `host-liste` : les trois routes ajoutées, rien de retiré. Gate 2079.

### 32b.5 Le déclencheur et le regroupement (D202)
- Il est abonné au store d'événements.
- Les tests, avec une horloge injectée :
  - les questions et permissions groupées par 30 s ;
  - aucun envoi à 0 ;
  - aucun envoi pour un tour ;
  - aucun envoi quand l'interrupteur est coupé.

### 32b.6 Le service worker et l'écran Notifications (D203, D204)
- `sw.js` : `push`, avec un repli générique, et `notificationclick`.
- L'écran : activer et couper les notifications, avec les cas d'iOS non installé et du push coupé sur le Mac.
- Sur le Mac, « Appareils connectés » marque les appareils abonnés.

### 32b.7 La route du diff (D205, D206, D207)
- `src/daemon/host/diff.ts`, la route et l'interrupteur `code`.
- Les tests :
  - l'index hors bornes ;
  - la tête périmée (409) ;
  - le fichier binaire ;
  - le plafond ;
  - un fichier refusé par son ancien ou par son nouveau chemin ;
  - `--no-ext-diff` et `--no-textconv`, avec un `.gitattributes` piégé dans le worktree ;
  - le 403 `code_coupe` ;
  - `no-store`.

### 32b.8 Le filtre des diffs (D208)
- `filtrerCode`.
- Les tests :
  - le bloc PEM, sur une ligne et sur plusieurs ;
  - `password: [REDACTED:DSN_CREDENTIAL]` ;
  - le JSON, le YAML et l'env ;
  - aucune coupure à 140 caractères ;
  - les faux positifs acceptés, documentés.

### 32b.9 La vue du diff (D209)
- « Lire un fichier » depuis Relire un tour et depuis Livrer.
- Sur la vue :
  - les lignes ajoutées et retirées, sans défilement horizontal de la page ; une ligne longue défile dans son bloc ;
  - « Fichier sensible », « Fichier binaire » et « Suite sur le Mac » ;
  - hors ligne, « Diff indisponible ».

### 32b.10 L'e2e et la fiche de recette
- `e2e/mobile-push-diff.spec.ts`, sur Chromium :
  - l'abonnement, avec un faux service de push local. Il est autorisé **seulement** par une option de test du daemon, jamais par la configuration ;
  - le diff, avec un fichier sensible refusé ;
  - les deux interrupteurs coupés.
- `docs/recette-chantier-32bis-push-diff.md` :
  - un vrai push vers Apple (iPhone, app installée) et vers Google (Android) ;
  - le texte de la notification ;
  - le toucher qui ouvre « À traiter » ;
  - la révocation, après laquelle plus aucun push n'arrive ;
  - le diff d'un fichier, et un fichier sensible ;
  - les deux interrupteurs.

## 6. Pièges

- **Le faux service de push des tests** ne doit jamais ouvrir la liste fermée en production. Un hôte de test n'est accepté que par une injection dans le code des tests, jamais par une variable d'environnement ou par la configuration.
- **La signature ES256** : `crypto.sign` rend du DER par défaut. Il faut `dsaEncoding: 'ieee-p1363'`.
- **iOS** : sans app installée, pas de `PushManager`. Un push sans notification affichée fait retirer l'abonnement par iOS (D203).
- **Le worktree est écrit par l'agent** : `.gitattributes`, `diff.external` ou un textconv pourraient exécuter du code. D'où `--no-ext-diff --no-textconv` (D206). Il faut aussi vérifier que `git -c` n'est pas sensible à une configuration locale piégée sur ces points.
- **Résidu accepté (lab)** : Apple et Google voient l'IP du Mac et l'heure de chaque décision. Le remplissage fixe masque le nombre, pas le moment.
- **Résidu** : le filtre des diffs a des faux positifs (`•••` dans du code légitime) et des faux négatifs (un secret court sans clé nommée). C'est pourquoi le code est désactivé par défaut.

## 7. Fini quand

- Les points 32b.1 à 32b.10 sont commités, un par point, avec `npm run gate` vert sur chacun, et `npm run e2e` vert en 32b.6, 32b.9 et 32b.10.
- La CI de la PR est verte.
- Le lab valide la frontière.
- La recette de Julien, avec un vrai push vers Apple et Google, est faite ou planifiée.
