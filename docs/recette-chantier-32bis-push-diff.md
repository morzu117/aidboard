# Recette push et diff (chantier 32 bis)

Grille du point 32b.10 de `docs/chantiers/32bis-push-diff.md`. Deux niveaux :

- **couverture automatique** : `e2e/mobile-push-diff.spec.ts`, Chromium, 390 × 844,
  daemon isolé, faux agent stream et frontal HTTPS local de `e2e/serve-local.ts` ;
- **recette réelle** : iPhone installé et Android Chrome, avec un vrai push via Apple
  puis Google. Les cases restent à remplir par la personne qui fait la recette.

Ne consigner aucun nom d'hôte réel, adresse réelle, login, lien d'appairage, cookie,
endpoint ni secret. Les exemples utilisent `aid-e2e.ts.net` et `192.0.2.x`.
Les secrets de recette sont uniquement des valeurs factices placées exprès.

## Couverture automatique (état à la PR)

| Point | Vérifié par |
| --- | --- |
| Deux interrupteurs coupés par défaut, activation sur le Mac | `e2e/mobile-push-diff.spec.ts` |
| Écran Notifications, abonnement enregistré, question visible et un événement `push.envoye` en échec | `e2e/mobile-push-diff.spec.ts` |
| Push coupé sur le Mac : message au téléphone, abonnements effacés | `e2e/mobile-push-diff.spec.ts` |
| Livraison réelle : fichier normal, valeur après `password:` masquée, `.env` refusé | `e2e/mobile-push-diff.spec.ts` |
| Code coupé sur le Mac : refus visible au téléphone | `e2e/mobile-push-diff.spec.ts` |
| Réabonnement puis révocation : aucun abonnement actif | `e2e/mobile-push-diff.spec.ts` |
| Frontières inchangées | `test/host-liste.test.ts`, `test/host-masque.test.ts`, `test/host-signal.test.ts` |

Le daemon est un processus séparé lancé par le CLI : aucun transport de code ne peut
lui être injecté par ce harnais. Seul le PushManager du navigateur est simulé, avec
un sous-domaine synthétique inaccessible de la liste autorisée. Le daemon utilise
son transport normal et journalise l'échec. Aucune variable, configuration ni
option de production n'élargit la liste fermée. Cet e2e ne capture donc ni les
en-têtes D201 ni la taille chiffrée du transport ; les tests unitaires d'envoi et
de chiffrement les couvrent. Chromium headless ne valide aucun vrai push.

## Prérequis sur le Mac

- [ ] Instance de recette isolée, head : _à noter_, port distinct du daemon de travail.
- [ ] Serve validé selon la recette du 32, appareils appairés, accès non expirés.
- [ ] Node 22 : version _à noter_ ; refaire sous Node 24 : version _à noter_.
- [ ] iPhone : modèle et version iOS _à noter_, **iOS 16.4 ou plus**, app installée
  sur l'écran d'accueil et ouverte depuis son icône. Refaire l'appairage dans
  l'app installée si nécessaire : son stockage est distinct de Safari.
- [ ] Android : modèle et versions Android/Chrome _à noter_.
- [ ] Agent capable de poser une question, et dépôt factice contenant un fichier
  normal, un secret factice après `password:`, un `.env`, un binaire et un gros
  fichier dépassant 2 000 lignes ou 200 Ko. Aucun vrai secret.

## Recette réelle

- [ ] 32b.R.1 Installation neuve : avant toute activation, constater sur le Mac
  « Notifications push » et « Montrer le code aux appareils » coupés. Sur le
  téléphone, constater les messages « coupées sur le Mac » et « coupée sur le Mac ».
  - Constat : _à remplir_
- [ ] 32b.R.2 iPhone installé : activer « Notifications push » sur le Mac, ouvrir
  Notifications sur le téléphone, toucher « Activer les notifications » et autoriser.
  Constater l'abonnement sur le téléphone et dans Appareils connectés sur le Mac.
  - Constat : _à remplir_
- [ ] 32b.R.3 iPhone : mettre l'app en arrière-plan, provoquer une question sur le
  Mac. Recevoir un **vrai push via Apple**. Le texte est exactement « Une décision
  t'attend » ou « N décisions t'attendent », N remplacé par le nombre attendu.
  Aucun titre de sujet, chemin, code, secret ni contenu de question n'apparaît.
  Toucher la notification : l'app ouvre À traiter, où la question est visible.
  - Constat du texte, de la réception et de l'ouverture : _à remplir_
- [ ] 32b.R.4 iPhone : couper les notifications sur le Mac, constater le message
  au téléphone et zéro abonnement sur le Mac. Attendre au moins 300 s pour
  distinguer un ancien push en transit, puis provoquer une nouvelle question :
  aucun nouveau push. Réactiver et réabonner, vérifier une réception, puis
  révoquer l'appareil : zéro abonnement actif, Accès coupé et aucun push pour
  une nouvelle question après la même attente.
  - Constat coupure puis révocation : _à remplir_
- [ ] 32b.R.5 Android Chrome : refaire 32b.R.2 à 32b.R.4, avec un **vrai push via
  Google** : permission sur geste, abonnement, texte limité au nombre, toucher
  ouvrant À traiter, coupure sur le Mac puis absence de push, réabonnement puis
  révocation et absence de push. Noter séparément chaque résultat.
  - Constat activation, réception, texte, toucher, coupure, révocation : _à remplir_
- [ ] 32b.R.6 Regroupement, sur chaque plateforme réappairée et abonnée : partir
  sans décision en attente, provoquer trois questions distinctes sur le Mac en
  moins de 30 s, les laisser en attente. Sur une fenêtre d'au moins 35 s depuis
  la première, constater au plus deux notifications, dont le nombre final est 3.
  - Constat iPhone puis Android, nombre et délais : _à remplir_
- [ ] 32b.R.7 Activer « Montrer le code aux appareils » sur le Mac. Sur chaque
  téléphone, depuis Livrer puis Relire un tour, ouvrir un fichier normal de la
  livraison : ajouts et retraits lisibles, aucun débordement horizontal de la page.
  - Constat iPhone puis Android : _à remplir_
- [ ] 32b.R.8 Ouvrir le fichier contenant `password: secret-factice-recette` :
  la valeur ressort masquée (`[masqué]`), jamais en clair. Ouvrir le `.env` :
  « Fichier sensible », aucun contenu. Ouvrir le binaire : « Fichier binaire ».
  - Constat pour chaque cas et plateforme : _à remplir_
- [ ] 32b.R.9 Ouvrir le gros fichier : contenu plafonné, « Suite sur le Mac ».
  Lire un diff, mettre le téléphone hors ligne et rouvrir la vue :
  « Diff indisponible hors ligne », aucun diff conservé affiché. Rétablir le réseau.
  - Constat iPhone puis Android : _à remplir_
- [ ] 32b.R.10 Couper « Montrer le code aux appareils » sur le Mac, rouvrir un
  fichier normal au téléphone : « La lecture du code est coupée sur le Mac ».
  - Constat iPhone puis Android : _à remplir_
- [ ] 32b.R.11 Constater et noter le résidu accepté : **Apple et Google voient
  l'IP du Mac et l'heure des envois**. Le remplissage fixe masque le nombre dans
  la taille du message, pas le moment de l'envoi. Ne relever aucune IP réelle.
  - Résidu constaté et accepté : _à remplir_
- [ ] 32b.R.12 Refaire les parcours sous Node 24, arrêter l'instance isolée et
  retirer son éventuelle configuration Serve selon la recette du 32.
  - Versions et constat : _à remplir_

## À valider

- [ ] Vrai push Apple sur iPhone installé, texte et toucher validés.
- [ ] Vrai push Google sur Android Chrome, texte et toucher validés.
- [ ] Regroupement, coupure, révocation et défauts vérifiés sur les deux plateformes.
- [ ] Tous les cas de diff vérifiés, y compris hors ligne.
- [ ] Résidu IP/horaires noté, résultats sous Node 22 et 24 consignés.

## Ce qui n'est pas couvert

- Livraison réelle d'un push Apple ou Google et installation iOS par Chromium headless.
- Absence absolue de faux négatifs du filtre : un secret court sans clé sensible
  peut passer. N'utiliser que des données factices pendant la recette.

## Vérifications du point 32b.10

- Les quatre nouveaux parcours Chromium passent ; les 103 tests unitaires ciblés
  push, diff et frontière passent. Les trois fichiers de frontière sont inchangés.
- La suite Playwright complète passe : 115 tests, dont les 111 e2e existants.
- Typecheck, ESLint, Prettier et build passent sous Node 22.
- Gate complet avec `TMPDIR=/var/tmp/aid-tmp-32b.10` : 2 205 tests passent,
  deux sont ignorés et deux échouent. Ces échecs sont reproduits sur une archive
  de HEAD sans les nouveaux fichiers : `test/install.test.ts` attend `inconnu`
  mais reçoit `repo` ; `test/update-check.test.ts` attend `null` mais reçoit
  `/var/tmp/aid-tmp-32b.10`, à cause du `.git` protégé de l'environnement.
  Ils sont donc préexistants à ce point ; aucun test n'est contourné.
- Index structurel et gbrain absents : lecture directe, sans rayon d'impact
  établi par l'index ni handoff en mémoire. Aucun commit ni push, selon le brief.
