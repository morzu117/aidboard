# Recette du panneau d'artefacts (chantier 30)

Grille du point 30.7 du plan `docs/chantiers/30-artefacts.md`. Deux niveaux :

- **couverture automatique** : ce que `npm run gate` et `npm run gate:e2e` vérifient déjà. Ce sont
  les tests du daemon, les tests de l'écran, `test/tauri-capacites.test.ts` et
  `e2e/artefacts.spec.ts`. Ce spec tourne sur un daemon à part (port de l'e2e + 1, ses artefacts
  10 plus haut), devant un serveur « extérieur » local qui compte les requêtes reçues. Artefacts
  synthétiques seulement, aucun réseau. **Chromium seulement** : Playwright n'a ni Safari ni
  WKWebView ici ;
- **recette réelle** : sur le Mac de Julien, dans Chrome, dans Safari et dans l'app, sous Node 22
  puis sous Node 24. Aucune case de cette partie ne peut être cochée depuis une session automatisée.

Rappels qui valent pour toute la recette :

- le daemon de travail (port 4870) fait tourner des agents. La recette se fait sur une instance à
  part, lancée depuis le worktree de la branche, sur un autre port (ses artefacts écoutent 10 plus
  haut). Rien n'est lancé, redémarré ni réinstallé sur le daemon de travail sans l'accord de Julien ;
- les artefacts de la recette sont ceux de `e2e/artefacts.spec.ts` (`verdict.html`,
  `vers-api.html`, `vers-dehors.html`, `rafraichir.html`, un `.svg`, un `.md`), écrits à la main dans
  le worktree d'un sujet de recette. Le serveur « extérieur » est un `python3 -m http.server` local,
  dont la console montre les requêtes reçues. Aucun artefact venu d'ailleurs ;
- aucun cookie, jeton ni lien d'artefact ne se colle dans la fiche, dans un fil ou dans un DM.

## Couverture automatique (état à la PR)

| Point | Vérifié par |
|---|---|
| Sec-Fetch-Site sur `/api/` et `/ws/`, Origin: null, frame-ancestors 'none' du cockpit (D165, D166) | `test/securite.test.ts` |
| Jetons : 32 octets, 10 minutes, réutilisables, purge, plafond (D163) | `test/artefacts-jetons.test.ts` |
| Le second port : CSP exacte, nosniff, no-referrer, no-store, aucun Set-Cookie ; 421 sur un autre Host ; 404, 405 ; aucune route de l'API ; port occupé ; jamais 4870 ni 4871 ; journal sans cookie ni jeton (D162, D164) | `test/artefacts-serveur.test.ts` |
| Le lien et la liste sur le vrai daemon : contenu lu à l'émission, localhost, gardes de Fichiers, frame-src du cockpit, types, statuts, tri, 404, 409 (D161, D163, D166) | `test/artefacts-routes.test.ts` |
| `artefacts.port` et son défaut ; la ligne de `aid doctor` (D162) | `test/config.test.ts`, `test/doctor.test.ts` |
| L'onglet : liste vide, Markdown sans cadre, attributs du cadre, Recharger, Ouvrir à part, fermeture au second load, port indisponible, agent distant ; le renvoi depuis Fichiers (D167, D168) | `test/web/artefacts.test.tsx` |
| Aucune capacité Tauri `remote`, aucune webview ajoutée (D170) | `test/tauri-capacites.test.ts` |
| De bout en bout, sous Chromium (D169) : voir ci-dessous | `e2e/artefacts.spec.ts` |

Ce que l'e2e a mesuré sous Chromium (30.7) :

- dans le cadre, `verdict.html` publie : `document.cookie` illisible (SecurityError) ou vide,
  `localStorage` SecurityError, `fetch` vers le daemon et vers l'extérieur TypeError, XHR et
  WebSocket sans effet, `__TAURI_INTERNALS__` absent. Le serveur extérieur ne reçoit rien ;
- **dans le cadre, aucune navigation ne sort**. `location.href` vers l'API du daemon ou vers
  l'extérieur, et `<meta http-equiv=refresh>`, finissent sur une page d'erreur sans que la requête
  parte : la page du cockpit pose `frame-src` vers le seul port des artefacts (D166), et Chromium
  l'applique à chaque navigation du cadre. C'est mieux que ce que le plan attendait (D169) ;
- la fermeture au second load (D167) joue pour le refresh, qui part après le premier load. Elle ne
  joue pas pour un script qui navigue pendant le chargement : un seul load, le cadre reste ouvert
  sur la page d'erreur. Sans effet sous Chromium, puisque rien n'est sorti ; épinglé par le test ;
- **à part** (« Ouvrir à part », la page seule, sans le cockpit autour), la limite connue est
  réelle : `location.href` et le refresh atteignent le serveur extérieur. La CSP `sandbox` garde
  l'origine opaque : `localStorage` SecurityError, `fetch` TypeError ;
- à part, une navigation vers `GET /api/state` du daemon reçoit **401** : `Sec-Fetch-Site:
  cross-site`, et pas de cookie (SameSite=Strict, l'initiateur est une origine opaque). Si le cookie
  passait, D165 répondrait 403. Jamais l'état.

## Prérequis sur le Mac

- [ ] L'instance de recette tourne sur la branche `feat/30-artefacts` (head : _à noter_), sous
  Node 22 (`node --version` : _à noter_), sur un port autre que 4870 (_à noter_)
- [ ] `aid doctor` sur cette instance : la ligne « port des artefacts », ✓ (_à noter_)
- [ ] Un sujet de recette, les six artefacts écrits dans son worktree, le serveur extérieur local
  lancé (port : _à noter_)

## Recette réelle

- [ ] 30.7.1 Chrome : l'onglet Artefacts après Fichiers ; la liste (nom, type, statut, heure) ; le
  `.md` rendu dans la page, sans cadre ; le `.svg` dans le cadre.
  - Constat : _à remplir_
- [ ] 30.7.2 Chrome : `verdict.html`, son titre lu dans les outils de développement (sélecteur de
  contexte sur le cadre) : cookie, localStorage, fetch, XHR, WebSocket comme l'e2e. La console du
  serveur extérieur ne montre rien.
  - Constat : _à remplir_
- [ ] 30.7.3 Chrome : `vers-api.html`, `vers-dehors.html`, `rafraichir.html` dans le cadre. La
  console du serveur extérieur ne montre rien ; le refresh ferme le cadre (« L'artefact a quitté sa
  page : cadre fermé. Recharger pour le rouvrir. »).
  - Constat : _à remplir_
- [ ] 30.7.4 Safari : 30.7.1 à 30.7.3. **À noter en particulier** : WebKit applique-t-il `frame-src`
  aux navigations du cadre, comme Chromium ? Si la console du serveur extérieur montre
  `/navigation` ou `/refresh` venus du cadre, c'est la limite connue de D169, attendue par le plan :
  le noter, ce n'est pas un échec.
  - Constat : _à remplir_
- [ ] 30.7.5 Safari : « Ouvrir à part » sur `verdict.html` : `localStorage` lève SecurityError,
  `document.cookie` est vide ou illisible. Sur `vers-api.html` : la page dit « Non authentifié » ou
  refuse (401 ou 403), jamais l'état.
  - Constat : _à remplir_
- [ ] 30.7.6 L'app (WKWebView), D170 : sur une page « Ouvrir à part » de `verdict.html`,
  `localStorage` SecurityError et `document.cookie` vide (l'origine opaque sous WebKit, que le lab
  n'a pas pu évaluer).
  - Constat : _à remplir_
- [ ] 30.7.7 L'app, D170 : dans le cadre, `verdict.html` rapporte `tauri: "undefined"`
  (`window.__TAURI_INTERNALS__` absent).
  - Constat : _à remplir_
- [ ] 30.7.8 L'app, D165 : WKWebView envoie `Sec-Fetch-Site` sur les requêtes du cockpit (inspecteur
  web de l'app, onglet Réseau, une requête `/api/…` : `same-origin`). Le cockpit fonctionne
  normalement (aucun 403 « requête inter-site »).
  - Constat : _à remplir_
- [ ] 30.7.9 L'app, D170 : où s'ouvre « Ouvrir à part ». Le navigateur système est attendu ; une
  nouvelle fenêtre de webview est un défaut à corriger, à noter ici.
  - Constat : _à remplir_
- [ ] 30.7.10 Recharger : un fichier modifié après l'ouverture ne change pas tant qu'on ne recharge
  pas ; Recharger le montre et met « Lu à » à jour. Un lien collé dans un autre onglet après
  10 minutes : « Lien expiré ou inconnu ».
  - Constat : _à remplir_
- [ ] 30.7.11 Port occupé : une instance de recette lancée alors que son port d'artefacts est pris
  (`nc -l` sur ce port) démarre quand même ; l'onglet dit « Port des artefacts … indisponible » ;
  `aid doctor` le signale (⚠) ; le Markdown reste lisible.
  - Constat : _à remplir_
- [ ] 30.7.12 Fichiers : « Ouvrir dans Artefacts » sur un `.html` sélectionne l'onglet et ouvre le
  fichier ; absent sur un `.ts`.
  - Constat : _à remplir_
- [ ] 30.7.13 Les points 30.7.1, 30.7.2 et 30.7.6 sous Node 24 (`node --version` : _à noter_).
  - Constat : _à remplir_

## À valider par Julien

- [ ] L'état du second port passe par `GET /api/artefacts/etat` et par la liste, pas par
  `/api/state` (révision 30.4).
- [ ] La liste réunit le diff depuis la base et le statut git : un artefact commité par l'agent y
  reste (30.5).
- [ ] La phrase sous le cadre reste prudente (« Il peut encore naviguer dans son propre cadre »),
  bien que Chromium arrête ces navigations : WebKit n'est pas mesuré, et une navigation vers un
  autre lien du port des artefacts reste permise par `frame-src`.

## Ce qui n'est pas couvert

- Les artefacts d'un agent distant (pas d'onglet, D167).
- Un PDF, une image autre que SVG, un notebook.
- Firefox : ni dans l'e2e ni dans la recette.
