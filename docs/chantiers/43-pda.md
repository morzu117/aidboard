# Chantier 43 : le PDA A-I-D, des confirmations hors du tailnet

| Champ | Valeur |
|---|---|
| État | **Révision 1, 8 novembre 2026.** Le lab a relu le plan (DM 92443), et ses trois points obligatoires sont écrits en D211 et D218. Julien a validé la spec et tranché Q1 à Q5. Le lab a relu la frontière à trois reprises (DM 92254, 92437, 92440), et son PASS est donné sous trois conditions, reprises ici en D213, D217 et D211. |
| Emplacement final | `docs/chantiers/43-pda.md` sur `main`, dans le premier commit du chantier |
| Base | **6d9d67e** (`origin/main`, PR #127). |
| Spec | `specs/pda-43.md`, révision 4 (dossier de travail, hors dépôt ; copie sur morzu-vps dans `~/work/aid-specs/`). |
| Organisation | Comme au 32 bis. morzu-vps gère le chantier. Un agent Codex CLI écrit le code et les tests de chaque point, sur un brief tiré de ce plan. morzu-vps relit chaque diff, lance le gate, commite et ouvre la PR. |
| Validation | La recette de Julien : le relais déployé sur un de ses VPS, puis une confirmation donnée depuis un téléphone **hors du tailnet**, et un second appareil. Le lab revoit la frontière à la fin. Le merge suit la règle de Julien : la CI verte et la validation du lab. |

## 1. Pourquoi

Le programme réserve certaines actions à une confirmation sur le téléphone : le réglage des validations et son plancher, puis le merge depuis le téléphone. Elle doit pouvoir se donner **hors du tailnet**, sans qu'A-I-D soit exposé et sans qu'A-I-D soit ouvert sur le téléphone.

Le 43 construit le canal et le PDA. Le chantier 34 y branchera les actions réelles : la demande, l'attente et la file côté A-I-D. Ici, une seule action passe par le canal : la **demande d'essai** envoyée depuis le panneau du Mac.

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| App du téléphone | `web/`, servie par `src/daemon/host/serveur.ts` sur le port des appareils ; `web/public/sw.js` | L'app du 32, installée depuis l'origine HTTPS du tailnet (31). Sa coque est en cache. Une CSP `cspAppareils` est en place (`serveur.ts:239`). |
| Appareils | `src/daemon/host/appareils.ts`, `appairage.ts`, migration 020 | Le registre, l'appairage par code court, un accès de 8 h (`DUREE_ACCES_MS`), la révocation et « Couper tous les accès ». |
| Clés du daemon | `src/daemon/push/vapid.ts` | `chargerOuCreerCles` et `creerFournisseurCles` : une clé P-256 créée en `wx` et `0600`, ouverte avec `O_NOFOLLOW`, avec un mode vérifié. C'est le modèle de D211. |
| Sortie hors du tailnet | `src/daemon/push/envoi.ts` | `fetch` avec `redirect: 'manual'`, un délai de 10 s, un corps de réponse jamais lu, et une liste fermée d'hôtes. C'est le modèle de D215. |
| Mode host | `config.modeHost` (`actif`, `port`, `push`, `code`), `src/daemon/routes/host.ts` | Les interrupteurs du Mac. Il n'y a encore aucun réglage du PDA. |
| Push | `src/daemon/push/declencheur.ts` | Le nombre de décisions en attente, envoyé au téléphone. |
| Migrations | `migrations/022_push_abonnements.sql` | La dernière. Ce chantier ajoute la 023. |

## 3. Cible et hors-périmètre

**Cible** : la spec, révision 4, avec les trois conditions du PASS du lab et ses recommandations.

**Hors-périmètre** :
- brancher le merge, le réglage ou le plancher sur le canal (chantier 34) ;
- répondre à une permission d'agent (§7) ;
- le déploiement du relais : la recette le fait, avec un nom de domaine qu'aucun fichier du dépôt ne contient ;
- exposer l'origine du 31 hors du tailnet, que ce soit par Funnel ou par un autre nom public (interdit, lab DM 92440).

## 4. Décisions

### D210

**L'interrupteur « PDA » sur le Mac**, désactivé par défaut (`config.modeHost.pda`), et `PUT /api/host/pda` est réservé à l'admin, sur le port du Mac. L'URL du relais est `config.modeHost.relais`, une chaîne `https://hôte` sans chemin, ni utilisateur, ni port autre que 443. Coupé, le daemon ne dépose ni ne tire rien. À l'allumage, les demandes laissées par l'état précédent sont expirées.

*Source : Spec Q7 ; lab.*

### D211

**La clé de signature du daemon** : une paire P-256 (ES256), rangée comme la clé VAPID (`wx`, `0600`, `O_NOFOLLOW`, mode vérifié), dans un fichier distinct, chargée une seule fois et partagée. Sa clé publique est servie aux appareils par un **script** : `GET /pda-cle.js` sur le port des appareils, mis en cache par le service worker et importé par l'app. Elle n'est jamais rangée dans IndexedDB. **Séparation des usages** (lab, DM 92443) : la même clé signe deux sortes d'octets, toujours précédés d'un contexte. Une demande lue par l'app signe `"aid-pda-demande-v1\n" ‖ corps`. Une requête vers le relais signe `"aid-pda-relais-v1\n" ‖ méthode ‖ "\n" ‖ chemin ‖ "\n" ‖ hachage du corps ‖ "\n" ‖ heure`. Une signature faite pour un usage ne vaut donc jamais pour l'autre. Sur le Mac, « Faire tourner la clé » en crée une nouvelle : c'est le chemin de révocation de l'app elle-même, et les apps en cache refusent alors les nouvelles demandes jusqu'à leur passage par le tailnet.

*Source : Lab, condition 3.*

### D212

**Le format d'une demande** : `{ v: 1, id, action, sujet, numero, echeance, emise }`, sérialisé en JSON canonique (clés triées, UTF-8, sans espaces).
- `id` : 16 octets aléatoires, en base64url.
- `action` : un code fermé ; seul `essai` existe au 43.
- `sujet` : 80 caractères au plus.
- `numero` : 4 chiffres tirés au hasard.
- `echeance` : `emise` + 5 min.

L'enveloppe transportée est `{ corps: <octets en base64url>, sig: <r‖s en base64url> }`. La signature ES256 porte sur les octets du corps.

*Source : Spec ; lab, conditions 1 et P3.*

### D213

**Ce qui vient du relais n'est jamais interprété avant la vérification** (lab, condition 1).
- L'app borne la taille de la réponse (16 Kio), puis vérifie la signature du daemon sur les octets bruts du corps, avec la clé épinglée de D211. Elle ne parse le corps qu'ensuite, et rejette toute demande échue.
- Le sujet et l'action sont affichés par `textContent`, jamais par `innerHTML` ni par `dangerouslySetInnerHTML`.
- La CSP du port des appareils devient `default-src 'none'; script-src 'self'; connect-src 'self' <hôte du relais>; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, plus ce que l'app utilise déjà pour les styles, les images et le manifeste. Aucun script inline.
- Les requêtes vers le relais partent avec `credentials: 'omit'` et `redirect: 'error'`.

*Source : Lab, condition 1.*

### D214

**Les appareils PDA** : la migration 023 crée la table `pda_appareils`. Elle est distincte de l'accès de 8 h du 31, car un PDA doit durer, comme le second appareil enregistré à l'avance. Ses colonnes :
- `id` ;
- `nom` ;
- `cred_id` ;
- `cle_publique` : la SPKI DER donnée par `getPublicKey()`, avec `getPublicKeyAlgorithm() === -7`. Le daemon l'importe par `createPublicKey({ format: 'der', type: 'spki' })`, et refuse tout ce qui n'est pas EC P-256. Si `getPublicKey()` renvoie `null`, l'enregistrement échoue avec un message, sans recourir à l'attestation. Aucun CBOR n'est lu (lab, DM 92447) ;
- `cle_relais` (JWK ES256) ;
- `cree_a`, `revoque_a`.

**L'enregistrement** : depuis un appareil appairé et dans son accès de 8 h, dans le tailnet, l'app crée une passkey sur l'origine de l'app, avec `userVerification: 'required'`, `attestation: 'none'` et ES256 seul. Elle crée aussi une clé de relais WebCrypto, non extractible. Elle envoie les deux clés publiques au daemon par `POST /api/appareils/moi/pda`. L'appareil reste « en attente » jusqu'à ce que le Mac l'active, après avoir comparé l'empreinte courte affichée des deux côtés. **L'empreinte** couvre les deux clés publiques à la fois : c'est le SHA-256 du JSON canonique `{ credId, passkey, relais }`, dont les 40 premiers bits sont écrits en base32, soit 8 caractères, groupés par 4 (lab, DM 92443).

**La révocation** sur le Mac fait foi : le daemon retire l'appareil de son registre.

*Source : Spec Q3 ; lab, points 2 et 5 de la DM 92437.*

### D215

**Le daemon vers le relais** : une sortie seule, sur le modèle de `envoi.ts`.
- L'hôte vient de la configuration seulement, en https, sans aucune redirection suivie.
- Le délai est de 10 s, et les réponses sont bornées à 64 Kio.
- Les opérations :
  - `PUT /demandes/:id` dépose une enveloppe ;
  - `GET /reponses?apres=` tire les réponses par sondage, toutes les 15 s tant qu'une demande est ouverte, et toutes les 5 min sinon ;
  - `PUT /autorises` publie la liste des clés de relais, signée par le daemon ;
  - `DELETE /demandes/:id` retire une demande close.
- Le daemon s'authentifie auprès du relais en signant chaque requête avec sa clé de D211 : la méthode, le chemin, le hachage du corps et l'heure, avec une marge de 60 s.
- Une erreur ne remonte jamais : elle est journalisée sans contenu.

*Source : Lab P1.*

### D216

**Le relais** : `src/relais/`, un serveur `node:http` sans dépendance, lancé par `aid relais --port <n>`, avec un état **en mémoire seulement**. Un redémarrage vaut expiration, et le refus est fermé.
- Il ne sert **aucun code** : ni page, ni script, ni fichier statique. Les seules routes sont celles de D215, plus `GET /demandes` et `POST /reponses/:id` pour l'app.
- Le CORS n'accepte que l'origine de l'app, prise dans sa configuration. Il n'y a pas de `Access-Control-Allow-Credentials`.
- L'app signe chaque requête avec sa clé de relais, que le relais vérifie contre la liste signée par le daemon.
- Les corps sont bornés à 16 Kio, et il y a au plus 32 demandes ouvertes.
- Une limite de débit par adresse s'applique aux routes de l'app : un dépassement donne 429, sans corps.
- Une demande est purgée à son échéance. Une réponse est purgée après avoir été tirée, ou au bout de 10 min.
- Le journal ne garde que les identifiants, jamais le sujet.

*Source : Spec ; lab, recommandés.*

### D217

**La réponse signée par l'appareil** : `navigator.credentials.get` avec `userVerification: 'required'`, `allowCredentials` restreint à son `cred_id`, et `challenge` = SHA-256 du JSON canonique `{ id, hDemande, numero, valeur, echeance, appareil }`. `hDemande` est le SHA-256 des octets du corps, et `valeur` vaut `oui` ou `non`. Pour `oui`, le numéro est **retapé** par la personne, ce qui évite un toucher par erreur (Q5). Pour `non`, il n'est pas demandé. L'app poste au relais `{ appareil, authenticatorData, clientDataJSON, signature, valeur, numero }`.

*Source : Spec Q5 ; lab, condition 2.*

### D218

**La vérification par le daemon, fermée par défaut et dans cet ordre** (lab, point 4 de la DM 92437) :
1. Taille et schéma bornés, AJV en `additionalProperties: false`.
2. L'appareil est actif dans le registre local, et sa clé COSE vient du registre, pas de ce que présente le relais. Le `rawId` de l'assertion est égal au `cred_id` de cet appareil.
3. ES256 seul.
4. `clientDataJSON` : `type === 'webauthn.get'`, `origin` égale à celle de la configuration, `crossOrigin` absent ou `false`. Le `rpIdHash` de `authenticatorData` est le SHA-256 du rpId de la configuration.
5. Les bits UP **et** UV sont posés.
6. Pour `oui`, le `numero` posté est égal à celui de **la** demande du daemon.
7. Le `challenge` de `clientDataJSON`, décodé en base64url, est égal **octet par octet** au défi recalculé par le daemon à partir de **sa** demande, avec la `valeur` et le `numero` postés. Un relais qui change `non` en `oui` casse donc le défi.
8. **La signature** : `signature` est vérifiée sur `authenticatorData ‖ SHA-256(clientDataJSON)`, avec la clé COSE du registre (ECDSA P-256, SHA-256, DER).
9. L'échéance est lue sur l'horloge du daemon.
10. L'identifiant est marqué consommé **avant** l'exécution de l'action.

Tout échec est refusé et journalisé (`pda.refus { appareil?, raison }`), sans contenu. Le compteur de signature n'est pas exigé, car les passkeys synchronisées le laissent à 0. Points 2, 4, 6, 7 et 8 complétés après la relecture du plan (lab, DM 92443).

*Source : Lab, point 4 et condition 2.*

### D219

**La file** : une demande vaut pour tous les appareils PDA actifs. La première réponse valide l'emporte, et un « non » valide l'annule. Une réponse arrivée après la clôture est journalisée (`pda.tardive`), sans autre effet. Sans réponse à l'échéance, la demande est close en `expiree`, et l'action n'a pas lieu. Le réveil passe par le push du 32 bis, si celui-ci est actif : le nombre de décisions compte aussi les demandes PDA ouvertes.

*Source : Spec Q6 ; lab.*

### D220

**L'invite du PDA**, un écran « Confirmer » de l'app : l'action en une ligne, le nom du sujet, le numéro à retaper, et deux boutons, « Confirmer » et « Refuser ». Elle n'affiche rien d'autre : ni code, ni chemin, ni texte d'agent. Hors du tailnet, l'app s'ouvre depuis le cache et ne montre que cet écran et l'état « hors du tailnet ».

*Source : Spec Q4 ; lab P4.*

### D221

**Le panneau du Mac** : l'interrupteur, l'URL du relais, la liste des appareils PDA (en attente, actif, révoqué) avec l'empreinte courte à comparer, « Activer », « Révoquer », « Faire tourner la clé » et « Envoyer une demande d'essai ». Le résultat de l'essai (`confirmee`, `refusee` ou `expiree`) s'y affiche.

*Source : Spec ; D210, D211.*

## 5. Points

### 43.1 Le plan
Ce document.

### 43.2 La clé du daemon et le format des demandes (D211, D212)
- `src/daemon/pda/cle.ts` charge une seule fois la clé de signature, et sait la faire tourner.
- `src/daemon/pda/demande.ts` fournit le JSON canonique, `signerDemande`, `verifierEnveloppe` (partagé avec le web dans `src/shared/pda.ts`) et `defiReponse`.
- Tests :
  - le JSON canonique est stable quel que soit l'ordre des clés ;
  - la signature est faite en r‖s, et vérifiée par `crypto.verify` en ieee-p1363 ;
  - une enveloppe dont un seul octet change est refusée ;
  - un fichier de clé aux permissions trop larges est refusé.
- *Révision 43.2.* La relecture a trouvé un défaut : `verifierEnveloppe` levait une exception sur un corps invalide mais correctement signé. Elle renvoie maintenant `null` dans tous les cas d'échec, et un test le vérifie. Gate 2227.

### 43.3 La vérification d'une assertion WebAuthn (D217, D218)
- `src/daemon/pda/webauthn.ts` lit une clé COSE ES256, puis vérifie une assertion dans l'ordre de D218. C'est écrit sur `node:crypto`, sans dépendance.
- Tests sur des assertions fabriquées avec une clé de test : chaque condition de D218 a son cas de refus, plus le cas valide. Les bits UP et UV absents, une autre origine, un autre rpId, un autre défi et une échéance passée sont refusés.
- *Révision 43.3.* La clé publique de l'appareil est rangée en SPKI DER, telle que la donne `getPublicKey()`, et non en COSE : aucun décodeur CBOR n'entre dans le daemon (écart soumis au lab, DM 92445). Pour `non`, le numéro du défi vaut `''`. La partie A sépare les usages de la clé (D211, révision 1), avec les contextes `CONTEXTE_DEMANDE` et `CONTEXTE_RELAIS`. Gate 2230.

### 43.4 Le registre des appareils PDA et l'enregistrement (D214)
- La migration 023 crée `pda_appareils` et `pda_demandes` (`id`, `action`, `sujet`, `h_demande`, `numero`, `echeance`, `etat`, `consomme_a`).
- `POST /api/appareils/moi/pda` exige un appareil appairé dans son accès, avec la garde commune et un corps strict. L'appareil est créé « en attente ».
- Sur le port du Mac, en admin : `GET /api/host/pda/appareils`, `POST .../:id/activer` et `POST .../:id/revoquer`. L'empreinte courte est la même des deux côtés.
- `host-liste` gagne la route de l'appareil.
- *Révision 43.4.* Couper le PDA n'efface pas son registre, puisqu'un PDA doit durer. La révocation de l'accès de 8 h du 31 ne révoque pas un PDA. La relecture a trouvé une course : deux enregistrements concurrents avec le même cred_id donnaient une 500. Ils donnent maintenant une 409 `connu`. `config.test` et `mesh-schema.test` ont été adaptés au champ `pda` et à la version 23 du schéma. Les événements `pda.active` et `pda.revoque` passent par le journal Fastify. Gate 2237.

### 43.5 Le relais (D216)
- `src/relais/`, avec la sous-commande `aid relais`.
- Tests sur un vrai port local :
  - aucune route ne sert de contenu, et tout autre chemin répond 404 sans corps ;
  - le CORS refuse une autre origine ;
  - une requête sans signature, ou signée par une clé hors de la liste, est refusée ;
  - les bornes de taille et de nombre tiennent ;
  - les purges se font ;
  - le journal ne contient jamais le sujet.
- *Révision 43.5.* La relecture a trouvé que l'anti-rejeu, indexé par le texte de la signature, se contournait par la malléabilité d'ECDSA : (r, n − s) est aussi valide. Il est désormais indexé par le SHA-256 des octets signés, et une signature en s haut est refusée. Le daemon (43.6) et l'app (43.8) doivent donc signer en s bas : `signatureBasse` et `estBasse` sont dans `src/shared/pda.ts`. Une limite : au-delà de 4 096 adresses suivies dans la minute, une nouvelle adresse reçoit 429, et le refus est fermé. Gate 2254.

### 43.6 Le daemon vers le relais, et la file (D210, D215, D219)
- `src/daemon/pda/relais.ts` porte le client signé : un transport injectable dans les tests, aucun réglage qui le redirige.
- `src/daemon/pda/file.ts` gère `creerDemande(action, sujet)`, le sondage, la vérification de D218, la consommation, puis la clôture.
- `config.modeHost.pda`, `config.modeHost.relais` et `PUT /api/host/pda` ; l'allumage expire les demandes restantes.
- Tests : le relais est injecté et hostile. Il rejoue, permute, retarde ou modifie une réponse, et chaque fois l'action n'a pas lieu. Un « non » annule. L'échéance est lue sur l'horloge du daemon.
- *Révision 43.6.* La relecture a trouvé trois défauts de disponibilité, qui échouaient fermé mais sans bruit. (1) Le daemon tire toujours avec `apres=0`, puisque le relais purge ce qui est tiré : un relais redémarré, ou qui annonce un curseur énorme, ne bloque plus le canal. (2) La liste autorisée est republiée avant chaque dépôt, et à chaque tour si elle a plus de 5 min. (3) Un dépôt qui échoue fait passer la demande en `expiree`, et l'essai répond 502 `relais injoignable`. Le déclencheur du push gagne `compterPda` et `signaler`. Les deux échecs de charge (`agents-pilotage` au 43.5, `livraison` ici) passent au rejeu. Gate 2294.

### 43.7 La CSP et la clé épinglée (D211, D213)
- `GET /pda-cle.js` est servi par le daemon et mis en cache par le service worker.
- La CSP du port des appareils passe à `script-src 'self'`, avec `connect-src` réduit à l'hôte du relais.
- Tests : l'en-tête CSP exact, avec et sans relais configuré ; aucun script inline dans `index.html` ; `sw.js` met `pda-cle.js` en cache.
- *Révision 43.7.* Le service worker garde sa stratégie, le réseau d'abord et le cache en secours. Il met désormais `/pda-cle.js` en cache dès l'installation, sous `aid-shell-v2`, et supprime les anciens caches à l'activation. `validerRelais` renvoie `url.origin`, qui est la forme écrite dans la configuration et dans la CSP. Avec la nouvelle CSP, l'e2e reste vert (115). Gate 2300.

### 43.8 L'app : l'enregistrement et l'invite (D213, D214, D217, D220)
- Dans l'écran « Appareils PDA », sur le téléphone, « Enregistrer cet appareil » crée la passkey et la clé de relais, puis affiche l'empreinte courte.
- L'écran « Confirmer » lit `GET /demandes` du relais, avec `credentials: 'omit'`. Il vérifie la taille, puis la signature, puis l'échéance, et affiche par `textContent`. Le numéro est retapé, puis `credentials.get` est appelé.
- Tests web : une enveloppe à la signature fausse n'est jamais affichée ; un sujet `<img src=x onerror=…>` s'affiche comme du texte ; « Confirmer » reste inactif tant que le numéro n'est pas retapé.
- *Révision 43.8.* `/pda-cle.js` exporte aussi `RELAIS`, l'origine du relais, ou `null` si le PDA est coupé. `main.tsx` rend `AppPda` directement sur `/pda*`, sans `detecterMode` ni aucune route `/api/`. Hors ligne, la navigation retombe sur la coque en cache (`/`), comme au 32. La charge du push ne distingue pas le PDA : le lien « Confirmations » est donc ajouté à l'accueil de l'appareil. Un test Node montre qu'une réponse fabriquée par le code de l'app, signée par une fausse passkey en DER, est acceptée par `verifierAssertion`. Gate 2315, e2e 115.

### 43.9 Le panneau du Mac (D221)
- L'interrupteur, l'URL du relais, les appareils PDA, la rotation de la clé et la demande d'essai.
- Tests web : confirmation avant de couper ou de faire tourner la clé ; affichage du résultat de l'essai.
- *Révision 43.9.* `GET /api/host/pda/cle` et `POST /api/host/pda/cle/tourner` sont réservés à l'admin et renvoient la clé publique raw. Le panneau la montre avec « Copier » et rappelle `aid relais --cle-daemon`. `GET /api/host` gagne `pda: { actif, relais }`. Le numéro n'apparaît nulle part sur le Mac, et un test le vérifie. Gate 2320, e2e 115.

### 43.10 L'e2e et la fiche de recette
- L'e2e lance un relais local sur `127.0.0.1` et le daemon pointé dessus, avec un authentificateur WebAuthn virtuel de Playwright (CDP `WebAuthn.addVirtualAuthenticator`, avec UV). Il couvre :
  - l'enregistrement, puis l'activation sur le Mac ;
  - l'essai confirmé, puis l'essai refusé ;
  - un appareil révoqué, dont la réponse est refusée ;
  - la rotation de la clé, après laquelle l'app refuse la demande ;
  - un authentificateur virtuel avec `isUserVerified: false`, dont la réponse est refusée (bit UV).
- L'authentificateur virtuel ne prouve rien sur les vraies passkeys d'iOS et d'Android, ni pour le compteur ni pour UV : c'est la recette qui le porte.
- `docs/recette-chantier-43-pda.md` :
  - le relais sur un VPS de Julien ;
  - une confirmation en 4G, hors du tailnet ;
  - le second appareil ;
  - le cache perdu ;
  - la rotation de la clé.
- *Révision 43.10.* Le daemon de l'e2e joint le relais factice `relais.aid-e2e.example` par un module de test (`e2e/pda-fetch.mjs`, chargé par `NODE_OPTIONS=--import`), qu'aucun fichier de `src/` ne connaît. WebAuthn passe par un authentificateur virtuel CDP (UV). Chromium arrête lui-même l'assertion sans UV : le cas vérifie donc que la demande n'est jamais confirmée, puis qu'elle expire réellement (environ 5 min). La rotation (une demande illisible avec l'ancienne clé, puis lue après un rechargement) et l'ouverture hors ligne passent. Gate 2320, e2e 116.

## 6. Pièges

- **Ne pas ouvrir de transport réglable** autre que `config.modeHost.relais`. Pas d'URL de relais dans une route, ni dans un appareil.
- **L'origine de l'app est le rpId.** Une passkey créée sur une autre origine ne vaut rien ici. Ne jamais créer une passkey depuis une page du relais : il n'en sert d'ailleurs aucune.
- **Les passkeys synchronisées** (iCloud, Google) ont un compteur à 0 : D218 ne l'exige pas. Le prix : un authentificateur cloné ne se détecte pas. La parade est UV et la révocation sur le Mac.
- **L'empreinte sur 40 bits n'est pas une barrière cryptographique** : une collision coûte environ 2^40 hachages, ce qui se fait hors ligne. Elle protège d'une erreur. La vraie barrière, c'est que l'enregistrement se fait dans le tailnet, depuis un appareil dans son accès de 8 h (lab, DM 92447).
- **iOS** peut évincer le stockage d'une PWA si la place manque. La clé publique épinglée est dans le cache du code, pas dans IndexedDB. Un cache perdu donne un refus fermé.
- **L'horloge** : le relais n'est jamais cru sur l'heure. Le daemon accepte une marge de 60 s sur les requêtes signées, mais aucune sur l'échéance.
- **Le chantier 34** branchera les actions réelles. Au 43, `action` n'accepte que `essai` : un autre code est refusé.

## 7. Fini quand

- Les points 43.2 à 43.10 sont commités, et le gate est vert à chacun.
- L'e2e est vert, avec le relais local et l'authentificateur virtuel.
- La recette de Julien est faite hors du tailnet, sur deux appareils.
- La CI est verte et le lab a validé, à la même tête.
