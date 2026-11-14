# Recette Board unifié (chantier 41 a)

Grille du point 41.5 de `docs/chantiers/41-board-unifie.md`, révisions comprises.
Les cases sont à remplir par la personne qui fait la recette sur une vraie
machine et un téléphone appairé. Tous les noms ci-dessous sont des exemples.
Ne consigner aucun hôte, adresse, login, jeton, cookie ou nom de client réels.

## Couverture automatique

`e2e/board-swairm.spec.ts` lance un daemon séparé, avec un AID_HOME temporaire,
un faux `swairm status --json` au format `swairm-status/1` et un faux `swarph`
qui accepte la recherche `--search 'Swairm: '` sans projet. Aucun vrai CLI
Swairm ou swarph n'est appelé et aucun réseau externe n'est utilisé.

Le parcours vérifie la pastille, le bloc de la fiche, le lien en double, la
section repliée puis dépliée, les compteurs, l'exclusion des sujets terminés
et le contenu exact des deux copies. Le faux Swairm passe ensuite d'`in_progress`
à `merged` entre deux lectures réelles : la Boîte propose une seule note et
ouvre le formulaire prérempli. Aucun envoi n'est demandé. Fermer conserve la
proposition ; Ignorer la ferme, y compris après rechargement.
Les tests de frontière `host-liste`, `host-masque` et `host-signal` restent inchangés.

## Préparation sur la machine de recette

- [ ] Utiliser une instance et des cartes de recette isolées. Noter le commit,
  la version de Node et les versions des CLI, sans donnée personnelle.
  Faire la recette sous Node 22 puis Node 24. Constat : _à remplir_.
- [ ] Régler `swairm.bin` dans la configuration locale vers le binaire installé
  sur la machine, puis redémarrer A-I-D. Exemple de configuration uniquement :

  ```yaml
  swairm:
    bin: /opt/exemple/bin/swairm
  ```

  Vérifier localement que `swairm status --json` rend `swairm-status/1`, avec
  un projet et des sujets de recette. Ne pas joindre sa sortie brute.
  Constat : _à remplir_.
- [ ] Régler le mesh pour l'identité de recette `peer-a` et vérifier la lecture
  du board. Pour la dernière étape, disposer du proxy d'écriture configuré,
  hors mode lecture seule, et d'un téléphone appairé avec confirmation active.
  Constat : _à remplir_.
- [ ] Préparer un sujet `exemple/depot#41`, titre « Un sujet », en cours, et une
  carte de recette (exemple : #101). Dans le corps de la carte, ajouter
  manuellement la ligne exacte suivante, seule sur sa ligne, sans espace ajouté :

  ```text
  Swairm: exemple/depot#41
  ```

  Préparer aussi un sujet vivant sans carte, un sujet `merged` sans carte
  et un sujet `abandoned` sans carte. Adapter les identifiants localement.
  Constat : _à remplir_.

## Recette réelle

- [ ] 41.R.1 Ouvrir Board sur la machine. La carte #101 porte « Swairm · en
  cours ». Ouvrir sa fiche : le bloc Swairm montre le projet, l'id, la colonne,
  les pas par état et leur total, la date `maj`, et, lorsque présents, « en
  pause » et le vol en cours (exemple : `peer-a`). Comparer avec le statut
  local sans recopier les données réelles dans cette fiche.
  Constat : _à remplir_.
- [ ] 41.R.2 Mettre temporairement la même ligne sur une seconde carte de
  recette (exemple : #102). Après expiration du cache de 5 s, recharger Board.
  Les deux cartes affichent « Lien en double : cartes #101, #102. » ; aucune
  carte n'est choisie pour ce sujet. Retirer la seconde ligne et recharger
  après expiration du cache : la pastille normale revient.
  Constat : _à remplir_.
- [ ] 41.R.3 Sur une nouvelle ouverture de Board, « Sujets Swairm sans carte »
  est replié ; son nombre compte seulement les sujets vivants sans carte et
  sans conflit. Déplier : le sujet vivant apparaît, les sujets `merged` et
  `abandoned` ne sont pas listés et leur compteur est visible. Chaque sujet
  vivant a « Copier la ligne » et « Copier la commande ».
  Constat : _à remplir_.
- [ ] 41.R.4 Copier chaque valeur et la coller dans un éditeur de texte.
  Exemple pour un sujet sans carte `exemple/depot#sans`, titre « Sujet sans carte » :

  ```text
  Swairm: exemple/depot#sans
  swarph board cards add --project <PROJET> --title 'Sujet sans carte' --body 'Swairm: exemple/depot#sans'
  ```

  Le titre et le corps sont cités en quotes simples POSIX (révision 41.3).
  `<PROJET>` reste à remplir. A-I-D ne crée aucune carte et n'exécute pas la
  commande copiée. Pour relier un sujet, ajouter soi-même la ligne à une carte.
  Constat : _à remplir_.
- [ ] 41.R.5 Relire Board pendant que le sujet relié #41 est en cours : son
  premier relevé ne propose aucune note. Faire passer ce sujet à `merged` par
  le parcours habituel de Swairm. Après 5 s, recharger Board (ou attendre sa
  relecture périodique), puis ouvrir la Boîte. Une seule entrée « Proposer une
  note sur la carte #101 » apparaît. Ouvrir : carte `101`, kind `fyi`, texte
  exact `Swairm : Un sujet — mergé.`. Aucun envoi ne part à cette ouverture.
  Fermer puis rouvrir : la proposition est conservée.
  Constat : _à remplir_.
- [ ] 41.R.6 Dans ce formulaire, demander l'aperçu et contrôler la destination
  et le texte. Cliquer « Envoyer » : la demande de confirmation apparaît sur
  le téléphone ; aucune note n'est encore écrite. Sur le téléphone, vérifier
  la carte et le contenu, saisir le numéro demandé puis confirmer avec la
  passkey. Une seule note `fyi` apparaît dans le fil de la carte, avec le texte
  `Swairm : Un sujet — mergé.` ; la proposition disparaît de la Boîte.
  Constat sur la machine et le téléphone : _à remplir_.
- [ ] 41.R.7 Avec un autre sujet de recette relié, relever d'abord un état en
  cours puis le passer à `plan_validated` ou `abandoned`. Dans la Boîte,
  cliquer « Ignorer » sur la nouvelle proposition : elle disparaît sans note
  ni demande au téléphone. Recharger et redémarrer A-I-D : l'état inchangé ne
  repropose aucune note. Constat : _à remplir_.
- [ ] 41.R.8 Retirer les lignes, cartes et sujets temporaires selon les règles
  locales, puis arrêter l'instance de recette. Constat : _à remplir_.

## Limites et bilan

L'e2e s'arrête au préremplissage et à Ignorer ; l'envoi réel, les CLI installés
et la confirmation par une vraie passkey restent à valider avec cette grille.
Aucune case ne constitue une recette déjà effectuée sur un vrai téléphone.

Index structurel et gbrain absents de l'environnement du point 41.5 : lecture
directe, sans rayon d'impact établi par l'index ni handoff mémoire. Cette fiche
et le rapport de livraison servent de handoff local. Aucun commit ni push,
conformément au brief ; le manager relit et commite.

## Vérifications du point 41.5

- Node 22.23.3 : `npm run typecheck`, `npm run lint` et `npm run build` passent.
  ESLint et Prettier sont aussi repassés sur les deux fichiers finaux.
- Avec `env -u SWARPH_SELF -u MESH_GATEWAY_URL`, les e2e passent : nouveau
  parcours **1/1**, Board **8/8**, Boîte **5/5**, soit **14/14**. Le nouveau
  parcours renforcé pour attendre les réponses d'absence passe à nouveau **1/1**.
- Les quatre fichiers de tests ciblés `swairm-board`, `swairm-propositions`,
  `web/swairm-board` et `web/swairm-propositions` passent : **47/47**.
- Gate complet `TMPDIR=/var/tmp/aid-tmp-41.5 npm run gate` : typecheck, lint et
  build passent ; Vitest donne **3 034 réussis, 27 ignorés, 2 échecs**
  (257 fichiers réussis, 4 ignorés, 2 en échec). Code de sortie : **1**.
  Échecs préexistants reproduits sans les deux nouveaux fichiers, sur la base
  du point 41.4 : `test/install.test.ts:37`, `expected 'repo' to be 'inconnu'` ;
  `test/update-check.test.ts:13`, `expected '/var/tmp/aid-tmp-41.5' to be null`.
  Le rejeu de ces deux fichiers donne **9 réussis, 2 échecs**, avec les mêmes
  messages. Ces limites de détection du dépôt dans l'environnement isolé
  étaient déjà consignées dans la recette du chantier 43 ; le manager relance
  le gate hors de cet environnement. Aucun test exclu ni assertion modifiée.
- Deux fichiers créés, **zéro ligne existante modifiée**. Aucun défaut des
  points 41.2 à 41.4 révélé, aucune correction produit, aucune dépendance ajoutée.
  Les daemons des e2e sont arrêtés ; aucun commit ni push.
