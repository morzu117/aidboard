# Recette Board A-I-D (chantier 42)

Grille du point 42.6 de `docs/chantiers/42-board-primitives.md`, révisions
42.2 à 42.5 comprises. Les cases restent à remplir sur le Mac et, pour les
écritures, avec Julien et son téléphone. Tous les identifiants ci-dessous
sont des exemples : `peer-a`, `exemple/depot`, `https://example.com`.
Ne joindre aucune donnée réelle de machine, domaine, compte ou authentification.

## Couverture automatique

`e2e/board-aid.spec.ts` utilise un daemon et une base temporaires, un board
synthétique et un faux proxy Unix. Le relais tourne localement, le téléphone
est simulé dans Chromium avec une passkey virtuelle. Aucune écriture réelle
sur le gateway : les requêtes restent dans le faux proxy.

Le parcours contrôle la pastille et le bloc A-I-D, l'ouverture du sujet, la
copie exacte depuis « Sujets sans carte », le titre prérempli et la ligne
après création. Une transition en revue doit produire une seule proposition ;
l'aperçu reprend D293, aucun déplacement ne part avant le oui, et le proxy
reçoit ensuite un seul `board.cards.move` avec l'étape et sa version attendues.
La carte non assignée ne produit aucune proposition et sa fiche explique
pourquoi. Un refus 403 affiche « Droit manquant », sans bouton `confirm-flow`.
Les tests de frontière host restent inchangés.

## Préparation

- [ ] Noter le commit et les versions de Node, A-I-D et du proxy, sans données
  personnelles. Répéter sous Node 22 et Node 24. Constat : _à remplir_.
- [ ] Sur le Mac, utiliser un workspace de recette avec un remote GitHub
  reconnu et des sujets locaux isolés. Exemple de ligne :

  ```text
  AID: exemple/depot#sujet-relie
  ```

  Préparer un sujet vivant sans carte, un sujet terminé sans carte et une
  carte sans lien. Toute création de carte ou modification manuelle de son
  corps **écrit sur le gateway** et demande une carte de recette autorisée.
  Constat : _à remplir_.
- [ ] Avec Julien, réserver une carte réelle de recette assignée à sa cell,
  en `build`, avec une `stage_version`, et le droit `execute` sur le projet.
  L'assignation et le changement préalable d'étape **écrivent sur le gateway**.
  Configurer le proxy d'écriture et appairer un téléphone avec une passkey
  active ; vérifier l'armement des confirmations. Ne pas recopier les valeurs
  réelles dans cette fiche. Constat : _à remplir_.

## Lecture sur le Mac

- [ ] 42.R.1 Ouvrir Board : la carte reliée porte « A-I-D · actif ». Sa fiche
  montre le workspace, la branche, la phase, l'état et les compteurs d'agents
  (en marche, en attente, terminés, et erreurs séparées). Si une PR existe,
  vérifier son numéro et son lien GitHub. « Ouvrir le sujet » ouvre le sujet
  local attendu. Aucune écriture sur le gateway. Constat : _à remplir_.
- [ ] 42.R.2 Sur l'Accueil, « Sujets sans carte » est replié. Déplier et vérifier
  le nombre de sujets `draft`, `active`, `review`, l'absence des `merged` et
  `archived`, et leur compteur. Copier la ligne dans un éditeur : elle est
  exactement `AID: exemple/depot#sujet-sans-carte` pour cet exemple.
  Un workspace sans remote reconnu indique l'impossibilité de lien et ne
  propose aucune ligne. Aucune écriture sur le gateway. Constat : _à remplir_.
- [ ] 42.R.3 Depuis la fiche de la carte sans lien, ouvrir « Nouveau sujet » :
  le titre de la carte est prérempli en texte brut, limité à 200 caractères.
  Choisir « aucun agent », créer le sujet et vérifier la ligne `AID:` à copier
  puis « Ouvrir le sujet ». Cette création écrit localement seulement.
  Coller ensuite la ligne dans le corps de la carte **écrit sur le gateway** ;
  réserver ce collage à une carte de recette autorisée avec Julien.
  Constat : _à remplir_.
- [ ] 42.R.4 Pour des cartes déjà préparées avec un lien en double, vérifier
  qu'aucune n'est retenue ; pour un sujet absent, vérifier « Sujet d'A-I-D
  absent de cette machine ». Préparer ou retirer ces lignes **écrit sur le
  gateway**, avec Julien ; leur lecture sur le Mac n'écrit rien.
  Constat : _à remplir_.
- [ ] 42.R.5 Sur une carte non assignée à la cell, vérifier « Déplacement non
  proposé : carte non assignée à peer-a » (identité adaptée localement).
  Une étape hors `build`, `review`, `ready` explique aussi l'absence de
  proposition. Faire passer le sujet local en revue : aucune proposition
  pour ces cartes. Aucun déplacement ni écriture gateway.
  Constat : _à remplir_.

## Avec Julien : écriture et téléphone

- [ ] 42.R.6 Relever d'abord le sujet relié en développement : aucune proposition
  au premier relevé. Passer le sujet local en phase `review` (ou ouvrir sa PR),
  relire après le cache de cinq secondes et ouvrir la Boîte : une seule entrée
  « Déplacer la carte #101 vers review ». Recharger : toujours une seule.
  Ouvrir l'aperçu : « Déplace la carte #101 de build vers review. Aucune
  obligation ni message. » Aucun déplacement gateway à ce stade ; l'ouverture
  éventuelle de la PR publie sur GitHub. Constat : _à remplir_.
- [ ] 42.R.7 **Ce pas écrit sur le gateway après le oui du téléphone.** Vérifier
  la carte réelle, son assignation à la cell de Julien, son droit `execute`,
  l'étape attendue et sa version. Cliquer « Envoyer » : rien ne part avant la
  confirmation. Sur le téléphone, vérifier la demande, retaper le numéro
  affiché sur le Mac puis confirmer avec la passkey. Constater un seul
  déplacement `build` vers `review`, une entrée `stage_history` et le rappel
  recalculé. Aucune obligation frappée, aucun DM ni message de fil. La
  proposition disparaît, y compris après rechargement. Constat : _à remplir_.
- [ ] 42.R.8 **Ce pas tente une écriture sur le gateway**, sur une carte de
  recette dont le droit `execute` manque : après confirmation du téléphone,
  vérifier « Droit manquant », sans texte amont. Aucun
  bouton `confirm-flow`, aucun enchaînement de cette commande. La carte garde
  son étape. Aucun détail amont ne doit être affiché. Constat : _à remplir_.
- [ ] 42.R.8bis **Ce pas tente une écriture sur le gateway.** Provoquer un
  409 de précondition après la relecture locale, sur une carte de recette
  autorisée. Avec swarph-cli 0.75.0, le libellé reste générique jusqu’à la
  carte #1575 du lab : « La carte a changé ou une porte a refusé le
  déplacement. Relis la carte. » Constat : _à remplir_.
- [ ] 42.R.9 Sur une nouvelle proposition, « Ignorer » ne déplace rien. Recharger
  puis redémarrer A-I-D : aucun nouvel événement local ne doit reproposer le
  même déplacement ; aucun au premier relevé après redémarrage. Un sujet
  fusionné peut proposer `ready`, jamais `done`. Confirmer `ready` **écrit sur
  le gateway** et demande les mêmes vérifications et le même oui du téléphone
  que R.7 ; Ignorer n'écrit pas sur le gateway. Constat : _à remplir_.
- [ ] 42.R.10 Nettoyer les sujets et worktrees locaux selon les règles du poste.
  Retirer les lignes ou cartes temporaires **écrit sur le gateway**, avec
  Julien. Arrêter l'instance de recette. Constat : _à remplir_.

## Limites et handoff

Le faux proxy ne valide ni les droits réels ni les effets du gateway. La
passkey virtuelle ne remplace pas la recette sur le téléphone de Julien.
La validation du lab exigée par D293 reste à obtenir avant le merge.
Aucune case ci-dessus ne constitue une validation déjà effectuée.

Index structurel (`codegraph`) et gbrain absents : lecture directe, sans rayon
d'impact établi par l'index ni handoff mémoire. Cette fiche et le rapport
servent de handoff local. Aucun code de production ni test de frontière
modifié, aucune dépendance ajoutée. Aucun commit ni push : le manager relit,
relance le gate hors environnement isolé et commite.

## Vérifications du point 42.6

Sous Node 22.23.3, toutes les commandes de vérification sont lancées avec
`env -u SWARPH_SELF -u MESH_GATEWAY_URL` :

- `npm run typecheck`, `npm run lint` et `npm run build` : succès.
- `npx vitest run test/aid-board.test.ts test/aid-propositions.test.ts test/web/aid-board.test.tsx test/web/aid-propositions.test.tsx` :
  **58/58**, quatre fichiers réussis.
- `npx playwright test e2e/board-aid.spec.ts e2e/board.spec.ts e2e/board-swairm.spec.ts e2e/boite-nouveau-sujet-reprendre.spec.ts` :
  **15/15** (AID 1, Board 8, Swairm 1, Boîte 5). Le fichier AID final,
  avec le binaire swarph factice explicite et le contrôle des verbes du proxy,
  est rejoué seul : **1/1**. Les sorties Playwright finales sont sous `/tmp`,
  hors du lint du dépôt.
- `TMPDIR=/var/tmp/aid-tmp-42.6 npm run gate` : typecheck, lint et build passent ;
  Vitest donne **3 233 réussis, 28 ignorés, 2 échecs** ; **266 fichiers réussis,
  4 ignorés, 2 en échec**, code de sortie **1**.
- Échecs reproduits sur la base courante `bda5e9c`, les deux nouveaux fichiers
  temporairement retirés puis restaurés : `test/install.test.ts:37`,
  `expected 'repo' to be 'inconnu'` ; `test/update-check.test.ts:13`,
  `expected '/var/tmp/aid-tmp-42.6' to be null`. Rejeu des deux fichiers :
  **9 réussis, 2 échecs**, code **1**, mêmes messages. Ils sont donc présents
  avant le diff 42.6 dans cet environnement isolé ; le manager relance hors
  de cet environnement. Aucun contournement ni test modifié.
- Le premier lint a rencontré les ressources JavaScript de traces Playwright
  générées dans `test-results/`. Ces artefacts ont été retirés, puis le lint
  complet et celui du gate passent, sans changement de configuration.
- Deux fichiers créés, **zéro ligne existante modifiée**. Un test e2e couvre
  les six scénarios demandés. Aucun défaut produit révélé, aucun écart
  fonctionnel au point 42.6. La recette réelle et Node 24 restent à effectuer.

## Handoff du point 42.7

Les corrections retirent tout texte amont des réponses de déplacement, y
compris du corps 2xx en mémoire. Seuls les étapes et refus connus sont
conservés ; `warn` devient `avertissement: true`. Les libellés sont locaux.
La branche dépend de l'action et l'éligibilité D293 est relue sans cache à
la demande et au oui, y compris pour une demande manuelle.

Fichiers modifiés :

- Production : `src/shared/deplacements.ts`, `src/shared/etats.ts`,
  `src/daemon/confirmations/etats.ts`, `src/daemon/mesh/proxy.ts`.
- Tests : `test/carte-deplacer.test.ts`, `test/mesh-etat.test.ts`,
  `test/daemon/proxy.test.ts`, `test/web/aid-propositions.test.tsx`,
  `e2e/board-aid.spec.ts`.
- Documentation : cette fiche. Aucun fichier créé.

78 lignes existantes remplacées ou supprimées (somme des suppressions de
`git diff --numstat`, hors fichiers nouveaux). Sept cas supplémentaires :
quatre cas de refus structurés, assignee changé au oui, demande manuelle
non assignée, et frontière du parseur (neuf étapes, huit refus, valeurs
inconnues, corps 2xx). Les tests existants vérifient désormais l'absence de
`secret-amont` dans la réponse, la base et le journal, l'avertissement
booléen, le texte de flow non confirmé sans bouton et l'absence du détail
dans l'e2e. Aucun test de frontière host modifié.

Sous Node 22.23.3, commandes lancées avec
`env -u SWARPH_SELF -u MESH_GATEWAY_URL` :

- `npm run typecheck` et `npm run lint` : code 0 ; également réussis dans
  le gate final, avec le build.
- `npx vitest run test/carte-deplacer.test.ts test/mesh-etat.test.ts test/aid-propositions.test.ts test/mesh-proxy.test.ts test/daemon/proxy.test.ts test/web/aid-propositions.test.tsx` :
  160 réussis, six fichiers, code 0.
- `AID_SWARPH_PROXY_PYTHON=/var/tmp/aid-swarph-proxy-venv/bin/python npm run test:vrai-proxy` :
  26 réussis, deux fichiers, code 0.
- `npx playwright test e2e/board-aid.spec.ts --output=/tmp/42.7-playwright` :
  1 réussi, code 0. Le premier lancement sans build a échoué sur le module
  absent `dist/cli/aid.js` ; le build du gate a fourni le binaire.
- `TMPDIR=/var/tmp/aid-tmp-42.7 npm run gate` : 3 240 réussis,
  28 ignorés, deux échecs ; 266 fichiers réussis, quatre ignorés, deux en
  échec ; code 1. Aucun test exclu ni contourné.
- Les deux échecs sont présents sur `HEAD` (`8ce69a8`), tous les fichiers
  du diff temporairement restaurés à leur contenu de base, puis le diff
  rétabli intégralement. Rejeu avec les mêmes variables et TMPDIR :
  `npx vitest run test/install.test.ts test/update-check.test.ts`, neuf
  réussis, deux échecs, code 1. Messages identiques au gate final :
  `test/install.test.ts:37`, `expected 'repo' to be 'inconnu'` ;
  `test/update-check.test.ts:13`,
  `expected '/var/tmp/aid-tmp-42.7' to be null`.

Index structurel et gbrain absents : lecture directe, sans rayon d'impact
établi par l'index ni handoff mémoire. Cette section sert de handoff local.
Aucun écart fonctionnel au point 42.7. Les attentes du test proxy et de
l'e2e ont été adaptées au retrait demandé des textes amont. Aucune nouvelle
dépendance, aucun changement de manifeste, configuration ou CI. Aucun
commit ni push ; le manager relit et relance le gate hors environnement
isolé avant de committer.
