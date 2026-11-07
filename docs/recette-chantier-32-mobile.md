# Recette de l'app mobile (chantier 32)

Grille du point 32.11 du plan `docs/chantiers/32-mobile.md`. Deux niveaux :

- **couverture automatique** : `e2e/mobile.spec.ts`, sous Chromium, utilise un daemon isolé,
  un faux agent stream et le frontal HTTPS de `e2e/serve-local.ts`. L'appairage est partagé avec
  l'e2e du 31. Le nom synthétique est `aid-e2e.ts.net`, l'adresse documentaire `192.0.2.10`.
  Aucun vrai Tailscale Serve ni agent externe n'est lancé ;
- **recette réelle** : iPhone installé et Android Chrome, derrière le vrai Serve, avec un daemon
  sous Node 22 puis Node 24. Ces cases restent à remplir par la personne qui fait la recette.

Ne consigner aucun nom d'hôte réel, adresse réelle, login, lien d'appairage, cookie ni secret.
Ne noter que les versions, les formes et les résultats. Les exemples utilisent uniquement
`aid-e2e.ts.net` et `192.0.2.x`. Le filtre de valeurs réduit les fuites sans tout détecter :
un secret écrit en clair dans une phrase peut passer. Ne jamais en saisir pour cette recette.

## Couverture automatique (état à la PR)

| Point | Vérifié par |
|---|---|
| Manifeste JSON, type MIME, standalone, icônes accessibles | `e2e/mobile.spec.ts` |
| Question : choix puis Confirmer, disparition, réponse reçue par le faux pilote sur le Mac | `e2e/mobile.spec.ts` |
| Permission : « sur le Mac », aucun bouton dans la décision | `e2e/mobile.spec.ts` |
| Tour marqué relu au téléphone retiré de la boîte du Mac | `e2e/mobile.spec.ts` |
| Recharge hors ligne, dernier état et âge, aucune écriture active | `e2e/mobile.spec.ts` |
| Révocation, Accès coupé, IndexedDB vide et marque aid.mode effacée | `e2e/mobile.spec.ts` |
| À traiter, Sujets, Suivre et Livraison sans débordement à 320 px ; boutons visibles ≥ 44 px | `e2e/mobile.spec.ts` |
| Liste fermée, masquage et signal, inchangés par ce point | `test/host-liste.test.ts`, `test/host-masque.test.ts`, `test/host-signal.test.ts` |

Les parcours sont à 390 × 844, le contrôle de largeur à 320 × 640. Le frontal local suppose
que Serve garde Host et remplace les en-têtes d'identité : voir la mesure du 31.
Chromium ne valide ni l'installation iOS, ni ses cookies et safe-areas, ni le lanceur Android.

## Prérequis sur le Mac

- [ ] Instance de recette isolée, head : _à noter_, port distinct du daemon de travail.
- [ ] Mesure Serve du 31 validée ; activation de Serve décidée par la personne responsable.
  Ne pas modifier le daemon de travail pour cette recette.
- [ ] Node 22 : version _à noter_ ; `aid doctor` confirme le port des appareils et le mode host.
- [ ] iPhone : modèle, version iOS _à noter_ ; Android : modèle, version Chrome _à noter_.
- [ ] Un agent en mode Default peut poser une question puis une permission.
  Un agent Codex ne pose que des permissions : utiliser un agent capable de questions.

## Recette réelle

- [ ] 32.R.1 iPhone, Safari : appairer, ouvrir le cockpit, constater le rappel
  « Ajouter à l'écran d'accueil ». Le fermer ; vérifier qu'il ne gêne plus la navigation.
  Installer depuis le menu de partage.
  - Constat : _à remplir_
- [ ] 32.R.2 Ouvrir l'app depuis l'écran d'accueil : affichage standalone, rappel absent.
  Le stockage de l'app installée est distinct de Safari : refaire l'appairage dans l'app si
  nécessaire, avec un nouveau QR. Ne pas supposer que l'accès Safari s'y transfère.
  - Constat : _à remplir_
- [ ] 32.R.3 Dans l'inspecteur web, vérifier la présence du cookie `__Host-aid_appareil`,
  Secure, HttpOnly, SameSite=Strict, chemin /. Fermer complètement l'app installée puis la
  rouvrir : l'accès tient sans nouvel appairage avant expiration. Ne relever aucune valeur.
  - Constat : _à remplir_
- [ ] 32.R.4 Observer les requêtes de l'app installée : forme de `Sec-Fetch-Site` sur la lecture
  et l'écriture de même origine ; aucune erreur 403 due à cet en-tête. Noter s'il est absent.
  Confirmer qu'une origine étrangère ne permet pas d'écriture.
  - Constat : _à remplir_
- [ ] 32.R.5 Safe-areas : portrait puis paysage, avec encoche et indicateur d'accueil.
  En-tête, onglets et boutons restent visibles et accessibles ; pas de débordement horizontal.
  - Constat : _à remplir_
- [ ] 32.R.6 Android Chrome : installer depuis le menu proposé, rouvrir depuis le lanceur.
  Appairer si nécessaire. Provoquer une attente : badge si le navigateur et le lanceur le
  permettent, disparition après traitement. Si non pris en charge, le noter.
  - Constat : _à remplir_
- [ ] 32.R.7 Question en Default : choisir une option, puis Confirmer. La question disparaît,
  le Mac reçoit la réponse. Poser ensuite une permission : « sur le Mac », aucun bouton
  pour l'accorder au téléphone. La résoudre sur le Mac.
  - Constat : _à remplir_
- [ ] 32.R.8 Poser une question pendant que l'agent est en « Tout accepter » (y compris après
  un changement de mode dans la CLI). Le téléphone refuse la réponse ; rien n'arrive à l'agent.
  Constater le refus dans le fil du Mac, sans texte de réponse.
  - Constat : _à remplir_
- [ ] 32.R.9 Finir un tour : Marquer relu au téléphone. Il sort de « À relire » sur le Mac.
  Un nouveau tour doit redevenir à relire.
  - Constat : _à remplir_
- [ ] 32.R.10 Mettre le Mac en veille après avoir lu un état. Recharger l'app :
  « Mac injoignable », dernier état connu et âge qui progresse ; aucune écriture possible.
  Réveiller le Mac : l'état frais revient.
  - Constat : _à remplir_
- [ ] 32.R.11 Révoquer depuis le Mac, app ouverte : « Accès coupé ». Dans l'inspecteur,
  la base IndexedDB `aid-appareil` est absente ou sans entrée et `aid.mode` a disparu.
  Recharger : l'accès ne revient pas. Ne copier ni cookie ni contenu de stockage.
  - Constat : _à remplir_
- [ ] 32.R.12 Refaire appairage, question, permission, relecture, veille et révocation avec
  le daemon sous Node 24 (version : _à noter_), sur iPhone et Android.
  - Constat : _à remplir_
- [ ] 32.R.13 Arrêter l'instance de recette ; si Serve a été activé pour celle-ci,
  `tailscale serve reset`, puis `tailscale serve status` vide.
  - Constat : _à remplir_

## À valider

- [ ] Parcours iPhone installé, cookie durable, stockage distinct et safe-areas.
- [ ] Parcours Android installé et prise en charge du badge documentée.
- [ ] Refus en Tout accepter, permissions réservées au Mac, révocation effective.
- [ ] Résultats consignés sous Node 22 et 24.

## Ce qui n'est pas couvert

- Installation réelle et politique de stockage iOS par Playwright Chromium.
- Badge sur les lanceurs qui ne le prennent pas en charge.
- Push, lecture de diff et merge au téléphone, hors périmètre du chantier.

## Vérifications du point 32.11

- Chromium : les sept tests de `e2e/mobile.spec.ts` passent. La suite Playwright complète,
  relancée seule avec des résultats séparés, passe aussi : 111 tests.
- Les 24 tests de frontière passent ; leurs fichiers restent inchangés.
- Typecheck, ESLint, Prettier et build passent sous Node 22.
- Gate complet : 2027 tests passent, deux sont ignorés, deux échouent. Ces deux échecs sont
  reproduits sur une archive de HEAD sans le diff : `test/install.test.ts` attend « inconnu »
  et reçoit « repo » ; `test/update-check.test.ts` attend `null` hors dépôt et trouve le
  répertoire temporaire protégé. Aucun test n'est contourné.
- Le gate e2e s'arrête aux tests de paquet : cache npm protégé, puis, avec un cache npm
  temporaire, cache node-gyp protégé (`ENOENT` lors de sa création). À rejouer hors sandbox.
- Index structurel et gbrain absents dans cet environnement : lecture directe, sans rayon
  d'impact établi par l'index ni handoff en mémoire.
