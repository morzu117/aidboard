# Recette du mode host (chantier 31)

Grille du point 31.11 du plan `docs/chantiers/31-mode-host.md`. Deux niveaux :

- **couverture automatique** : ce que `npm run gate` et `npm run gate:e2e` vérifient déjà. Ce sont
  les tests du daemon, les tests de l'écran et `e2e/mode-host.spec.ts`. Ce spec tourne sur un daemon
  à part (port de l'e2e + 2, ses appareils 20 plus haut), mode host actif, avec une sortie `tailscale`
  synthétique. Devant le port des appareils, un frontal HTTPS local joue Serve pour le nom
  synthétique `aid-e2e.ts.net`, avec un certificat autosigné créé par `openssl`. Chromium résout ce
  nom, port 443 compris, vers le frontal (`--host-resolver-rules`). Aucun réseau, aucun vrai nom du
  tailnet. **Chromium seulement** : Playwright n'a ni Safari ni WebKit mobile ici ;
- **recette réelle** : sur le Mac de Julien et un téléphone, par le vrai Tailscale Serve, sous
  Node 22 puis sous Node 24. Aucune case de cette partie ne peut être cochée depuis une session
  automatisée.

Rappels qui valent pour toute la recette :

- le daemon de travail (port 4870) fait tourner des agents. La recette se fait sur une instance à
  part, lancée depuis le worktree de la branche, sur un autre port (son port des appareils est
  20 plus haut). Rien n'est lancé, redémarré ni réinstallé sur le daemon de travail sans l'accord de
  Julien ;
- la recette change la config Tailscale du Mac : un service Serve sur le port 443. **Sur la décision
  de Julien seulement**, comme la mesure de 31.2. À la fin, `tailscale serve reset`, puis
  `tailscale serve status` doit être vide ;
- aucun nom d'hôte du tailnet, aucune adresse IP du tailnet, aucun login, aucun cookie, jeton ni lien
  d'appairage ne se colle dans cette fiche, dans un fil ou dans un DM. On note **la forme**
  (« le nom `.ts.net` du Mac », « le login de Julien »), jamais la valeur ;
- **porte 0.b** : elle ne s'applique pas à une recette sans pair ni gateway swarph, comme celle-ci.
  Si un pair ou la gateway swarph y prend part (par exemple pour lire le board depuis le téléphone),
  elle s'applique entière ;
- **note du lab** : le board est lu avec le jeton de pair du Mac. Un appareil appairé lit donc le
  board aussi largement que le Mac (D178), en lecture seule.

## Couverture automatique (état à la PR)

| Point | Vérifié par |
|---|---|
| Lecture de `tailscale status` et `serve status`, Funnel, ports interdits, commande à copier (D173, D182) | `test/host-tailscale.test.ts` |
| Le registre des appareils : jeton de 32 octets, empreinte seule, 8 heures, révoquer, tout révoquer (D177) | `test/host-appareils.test.ts` |
| L'appairage : code, code court, deux réclamations, plafond, cookie de demande (D176) | `test/host-appairage.test.ts`, `test/host-appairage-routes.test.ts` |
| Le port des appareils : 421 hors du nom, Origin, Sec-Fetch-Site, CSP, aucun cookie hors de l'appairage, `aid_session` et `Authorization` sans effet (D171, D183) | `test/host-serveur.test.ts` |
| La liste fermée : chaque route du Mac rend 404 sur le port des appareils ; l'inverse (D174) | `test/host-liste.test.ts` |
| L'état masqué, champ par champ (D175) | `test/host-masque.test.ts` |
| `/ws/signal` : `changed` seul, 4401 à la révocation et à l'expiration ; toute autre socket refusée en 404 avant de s'ouvrir (D175, D183, 31.11) | `test/host-signal.test.ts` |
| `modeHost` dans la config, `PUT /api/host`, la ligne de `aid doctor` (D172) | `test/host-mode.test.ts`, `test/host-route.test.ts`, `test/config.test.ts`, `test/doctor.test.ts` |
| Machines › Ton cockpit : pilule, interrupteur, commande, QR, approbation, case « Appareil taggé », liste, Révoquer, Couper (D172, D176, D177, D181) | `test/web/host.test.tsx` |
| L'interface d'un appareil : détection, barre réduite, accueil sans bouton, `/ws/signal`, écrans pleins, Appareils connectés, `/appairer` (D180) | `test/web/appareil.test.tsx` |
| De bout en bout, sous Chromium : voir ci-dessous | `e2e/mode-host.spec.ts` |

Ce que l'e2e a mesuré sous Chromium (31.11) :

- **le parcours d'appairage** entre deux contextes, le Mac et l'appareil : le QR, la page
  `/appairer` sur `https://aid-e2e.ts.net`, le code retiré de l'adresse, le même code court des deux
  côtés, l'identité posée par le frontal marquée « non vérifiable », l'approbation, puis le mode
  appareil après rechargement ;
- **le cookie d'appareil** : `__Host-aid_appareil`, `Secure`, `HttpOnly`, `SameSite=Strict`, sur le
  seul nom de l'appareil. Le navigateur l'accepte derrière le frontal HTTPS (piège 2 du plan) ;
- **l'état vu de la page** : exactement `actions`, `agents`, `lastEventId`, `runs`, `topics`,
  `workspaces`. Ni le chemin du dépôt, ni un worktree, ni le dossier du daemon, ni le jeton ;
- **les refus** depuis la page : `POST /api/topics`, `PUT /api/host`, `POST /api/host/couper`,
  `GET /api/fs/dirs` rendent 404 ; `/ws/pty/…` et `/ws/events` ne s'ouvrent pas ; `/ws/signal`
  s'ouvre. **Constat** : avant la correction de 31.11, une socket vers une route non déclarée
  s'ouvrait un instant, puis `@fastify/websocket` la fermait, sans rien envoyer. Elle est maintenant
  refusée en 404 avant la poignée de main. Les tests en `inject` de 31.8 ne pouvaient pas le voir ;
- **la révocation depuis le Mac** coupe une page ouverte sans rechargement (« Accès coupé ») ; la
  requête suivante reçoit 401 ;
- **Couper tous les accès** coupe deux appareils ouverts ; le Mac reste, mode host actif ; un
  rechargement ne rouvre rien ;
- **le cookie `aid_session` et le jeton du Mac** n'ouvrent rien sur le port des appareils (401,
  écran « Pas d'accès ») ;
- **le plafond global** (D179, branche prudente) : à la sixième réclamation de la minute, toutes
  épreuves confondues, la page affiche « Trop d'essais : réessaie dans une minute. ». Le helper de
  l'e2e attend et rouvre le même lien.

Ce que le frontal de l'e2e suppose, et que seule la mesure de 31.2 tranche : il garde `Host`
(`aid-e2e.ts.net`), pose `Tailscale-User-Login` et remplace ceux du client. Si Serve réécrit `Host`
en `127.0.0.1:<port>`, toutes les requêtes d'un appareil reçoivent 421 (voir 31.R.3).

## Prérequis sur le Mac

- [ ] La mesure de 31.2 est faite (`docs/mesure-serve-31.md`) et D179 tranché. **Sinon, la faire
  d'abord**, sur la décision de Julien : elle dit si cette recette peut passer telle quelle (`Host`).
  - Constat : _à remplir_
- [ ] HTTPS est activé dans la console Tailscale (question 0 de la spec)
- [ ] `tailscale serve status` est vide avant de commencer (sinon, s'arrêter et le noter)
- [ ] L'instance de recette tourne sur la branche `feat/31-mode-host` (head : _à noter_), sous
  Node 22 (`node --version` : _à noter_), sur un port autre que 4870 (_à noter_) ; son port des
  appareils est 20 plus haut (_à noter_)
- [ ] `aid doctor` sur cette instance : la ligne « port des appareils » (_à noter_)
- [ ] Le téléphone est sur le même tailnet, sous le compte de Julien (modèle et navigateur :
  _à noter_)

## Recette réelle

- [ ] 31.R.1 Machines › Ton cockpit, mode host inactif : la pilule « Mode host inactif »,
  l'interrupteur. Activer : la pilule « Serve absent » et la commande à copier, qui vise le port des
  appareils de l'instance de recette.
  - Constat : _à remplir_
- [ ] 31.R.2 Lancer la commande copiée dans un terminal du Mac (sur la décision de Julien). Relire
  l'écran : « Mode host actif ». A-I-D n'a lancé aucune commande `tailscale serve` lui-même (journal
  de l'instance).
  - Constat : _à remplir_
- [ ] 31.R.3 Depuis le téléphone, sans appairage, `https://<nom du Mac>/` : l'écran « Pas d'accès ».
  Si la page reste blanche ou affiche « hôte refusé » (421), Serve réécrit `Host` : le noter, c'est
  l'ajustement prévu par D179 et la fiche de mesure.
  - Constat : _à remplir_
- [ ] 31.R.4 « Ajouter un appareil » : le QR, le temps restant. Le scanner avec l'appareil photo du
  téléphone : la page « Ajouter cet appareil » s'ouvre, l'adresse ne montre plus le code, rien n'est
  réclamé avant « Demander l'accès ».
  - Constat : _à remplir_
- [ ] 31.R.5 « Demander l'accès » : le même code court sur le téléphone et sur le Mac ; sur le Mac, le
  nom proposé, l'identité (le login de Julien, « non vérifiable »), l'avertissement « Si tu n'as pas
  lancé cette connexion, refuse ». Approuver : le téléphone ouvre le cockpit.
  - Constat : _à remplir_
- [ ] 31.R.6 Le mode appareil : la barre (Accueil, Board si le mesh est configuré, Appareils
  connectés), le nom et l'heure de fin. L'accueil liste les sujets et leurs agents ; aucun bouton,
  aucun terminal, aucun texte de question d'agent.
  - Constat : _à remplir_
- [ ] 31.R.7 Un agent qui change d'état sur le Mac : l'accueil du téléphone suit en moins de quelques
  secondes, sans recharger (`/ws/signal`). **Safari** : la CSP `connect-src 'self'` couvre-t-elle le
  `wss://` de même origine (piège 3) ? Si la socket est bloquée, l'inspecteur web le dit : le noter.
  - Constat : _à remplir_
- [ ] 31.R.8 Le Board, si le mesh est configuré : projets, cartes, une fiche ; « Relire » ne force
  pas de lecture fraîche (D178). Porte 0.b : si cette étape lit le vrai board, elle s'applique.
  - Constat : _à remplir_
- [ ] 31.R.9 Révoquer le téléphone depuis le Mac, page ouverte : « Accès coupé. Nouveau QR requis
  pour revenir. », sans recharger. Recharger : le même écran.
  - Constat : _à remplir_
- [ ] 31.R.10 Réappairer, puis « Me déconnecter » depuis Appareils connectés : « Appareil
  déconnecté ». Réappairer, puis « Couper tous les accès » sur le Mac : « Accès coupé », et le Mac
  reste.
  - Constat : _à remplir_
- [ ] 31.R.11 L'expiration : un appareil appairé le matin, ouvert huit heures plus tard : « Accès
  expiré. Nouveau QR requis pour revenir. » (ou noter que l'étape n'a pas été faite).
  - Constat : _à remplir_
- [ ] 31.R.12 Le Mac en veille, page ouverte sur le téléphone : « Mac injoignable. Nouvel essai… »,
  puis le retour à son réveil.
  - Constat : _à remplir_
- [ ] 31.R.13 Deux appareils sur le même QR (le téléphone et un second navigateur) : la demande est
  annulée, le Mac dit « Deux appareils ont essayé ce code ».
  - Constat : _à remplir_
- [ ] 31.R.14 Un nœud taggé, s'il y en a un sur le tailnet : sa demande arrive sans identité ; Approuver
  attend la case « Appareil taggé ». S'il n'y en a pas, le noter.
  - Constat : _à remplir_
- [ ] 31.R.15 Éteindre le mode host : le port des appareils n'écoute plus ; le téléphone voit « Mac
  injoignable ». `aid doctor` le dit.
  - Constat : _à remplir_
- [ ] 31.R.16 Les points 31.R.4 à 31.R.7 et 31.R.9 sous Node 24 (`node --version` : _à noter_).
  - Constat : _à remplir_
- [ ] 31.R.17 À la fin, **obligatoire** : `tailscale serve reset`, puis `tailscale serve status`
  vide (_heure_). L'instance de recette arrêtée.

## À valider par Julien

- [ ] **D179, branche prudente** tant que la mesure de 31.2 n'est pas faite : l'identité est
  seulement affichée, « non vérifiable », et le plafond d'appairage est global (5 réclamations par
  minute en tout).
- [ ] La case « Appareil taggé » n'apparaît que sans identité. Faut-il l'exiger aussi quand une
  identité non vérifiable est présente ? (question ouverte depuis 31.6)
- [ ] La page `/appairer` ne réclame que sur « Demander l'accès » (révision 31.10) : un aperçu de lien
  qui ouvrirait la page ne réclame rien, et ne peut donc pas faire annuler la demande.
- [ ] L'interface choisit le mode appareil par `GET /api/appareils/moi`, avant le premier rendu
  (révision 31.10) : sur le Mac, l'ouverture attend cette réponse.
- [ ] Une socket hors de `/ws/signal` est refusée en 404 avant la poignée de main (révision 31.11).

## Ce qui n'est pas couvert

- La mise en page mobile : chantier 32.
- Safari et WebKit mobile en e2e : seulement en recette (31.R.7).
- Firefox : ni dans l'e2e ni dans la recette.
- Le vrai Tailscale Serve en e2e : le frontal local le joue, sur les suppositions de la mesure
  de 31.2.
- Un appareil sous Android, si Julien n'en a pas.
