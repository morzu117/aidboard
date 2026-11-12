# Recette du chantier 40 — Avis au mesh

Julien, sur le Mac, avec son téléphone. Les cases restent à remplir : ce
parcours ouvre une vraie salle et dépense le quota des propriétaires des
cells. Ne recopier aucune identité réelle, adresse, nom d’hôte ou donnée
d’authentification dans cette fiche ni dans le compte rendu transmis.
Tous les noms ci-dessous sont des exemples du dépôt.

## Avant tout

- [ ] Relever la version de swarph-cli : __________. Attendu : **0.73.0 ou
      plus**, avec `committee rooms open`, `motion`, `post`, `results` et
      `baseline-absent`. Utiliser le transport CLI pour cette recette.
- [ ] Configurer la cell d’A-I-D et `mesh.avis.baseline`, sans valeur par
      défaut, ainsi que `mesh.avis.familles`. Exemple à adapter localement :

  ```yaml
  mesh:
    cell: peer-c
    avis:
      baseline: peer-d
      familles:
        peer-d: claude
        peer-a: gemini
        peer-b: gpt
  ```

  Attendu : A-I-D préside en `orchestrator`, le baseline est en `claude`,
  et les deux sièges ont des familles distinctes, déclarées honnêtement.
- [ ] Réserver deux cells **non servies par Claude** (D303), par exemple
      `peer-a` et `peer-b`. Obtenir le consentement de leurs propriétaires :
      chaque cell dépense son propre quota. Prévenir aussi le baseline.
      Attendu : trois familles distinctes hors du chair.
- [ ] Réserver une carte liée de recette, par exemple #101. Connecter la cell
      d’A-I-D et activer le téléphone et sa passkey pour les confirmations.
      Attendu : la carte est reconnue et les confirmations sont possibles.

Constats : __________

## Ouvrir la salle et signer

Question de recette sans secret, contenu de carte ni nom de client :

> 1. Faut-il vérifier les tests ?

- [ ] Ouvrir « Demander N avis », puis « Au mesh ». Cocher les deux cells,
      saisir le numéro de carte et cliquer « Confirmer la carte » après avoir
      vérifié son titre. Garder 24 h pour `positions`, 1 h pour `rebuttal`,
      1 h pour `vote`. Attendu : trois durées présentes et envoi autorisé.
- [ ] Cliquer « Envoyer ». Attendu : l’aperçu exact montre la question citée,
      la salle, la carte, les sièges, leurs rôles et familles et les trois
      échéances croissantes. Aucune ouverture avant la signature.
- [ ] **Avant de signer sur le téléphone**, comparer les lignes des paramètres
      signés à l’aperçu du Mac : la salle, la carte, chaque siège avec son rôle
      (président, baseline, siège) et sa famille, les trois échéances, puis le
      texte de la motion. Attendu : ces lignes sont visibles sur le téléphone
      et correspondent à l’aperçu. Le panneau des confirmations du Mac ne
      montre que le résumé, pas les paramètres signés ; le téléphone ne
      montre pas le résultat d’exécution.
- [ ] Pour la salle autorisée avec Julien, retaper le numéro affiché sur le
      Mac et confirmer avec la passkey. **Ce oui écrit sur le gateway.**
      Attendu : une salle avec chair `orchestrator`, baseline et deux sièges,
      puis une motion avec `avis,objection` et les trois échéances. L’abstention
      n’est jamais une troisième option. Chaque appel CLI emploie `--as`.

Constats : __________

## Positions et scellé

Les sièges réels déposent depuis leur propre cell, avec leur propre `--as`.
A-I-D ne poste jamais pour eux.

- [ ] Ouvrir la demande dans « Demandes au mesh ». Faire déposer une position
      JSON conforme au charter par un siège, uniquement dans la salle, par
      `swarph committee post avis-test --round positions --body-file bulletin.json --as peer-a`.
      Adapter localement le canal à la salle ouverte. Attendu : phase
      `positions`, cases « scellé par le gateway », baseline « pas encore
      posté » tant qu’il n’a rien déposé. Ne jamais conclure à l’invisibilité.
- [ ] Sur cet essai, faire déposer au deuxième siège une abstention par
      `swarph committee post avis-test --round positions --body-file abstention.txt --outcome cannot_evaluate --as peer-b`.
      Le corps explique brièvement l’impossibilité ; si un secret est suspecté,
      il contient seulement « secret suspecté ». Attendu après ouverture du
      scellé : abstention visible, sans verdict compté.
- [ ] Dans une seconde salle de recette avec les mêmes deux sièges, convenir
      que le deuxième ne dépose aucune position. Attendu après l’échéance :
      siège « absent » à partir de `positions_absent`, pas une abstention.
      Deux sièges ne permettent pas une position, une abstention et un absent
      simultanés : conserver les deux constats séparés.
- [ ] Pour chaque essai, convenir que le baseline ne poste pas. Avant
      l’échéance positions, vérifier l’absence du bouton de déclaration.
      Après l’échéance seulement, « Relire », puis « Déclarer le baseline
      absent » et confirmer sur le téléphone. **Ce oui écrit sur le gateway.**
      Attendu : le baseline ne bloque plus le tour, sa colonne indique
      « baseline déclaré absent », avec raison, auteur et date. Il ne vote
      jamais et ne compte pas dans l’accord.
- [ ] Dès `rebuttal`, cliquer « Relire ». Attendu : les positions sont lisibles
      et l’accord est calculé immédiatement, sans attendre la clôture. Une
      position valide seule, avec abstention ou absence de l’autre siège,
      donne `insuffisant`. Le texte rebuttal ne compte pas dans l’accord.
- [ ] Laisser passer le vote puis la clôture ; le gateway peut créer les lignes
      « vote » sur le board. Fermer et rouvrir la demande, puis « Relire ».
      Attendu : phase `closed`, résultats retrouvés par l’id de motion gardé,
      même si elle n’est plus listée parmi les motions ouvertes. Les votes
      valides remplacent les positions et le tableau le signale.

Constats : __________

## Fan-out pendant le scellé (§6, fuite #1326)

- [ ] Avant le dépôt d’une position, préparer un membre du canal **non-siège**
      et observer localement ses livraisons du mesh **en lecture seule** (flux
      du canal et inbox du sidecar). Pour l’inbox, utiliser
      `swarph mesh inbox --peek --as peer-e`, en adaptant localement `peer-e`
      à la cell du membre non-siège : jamais `--consume`, rien n’est marqué lu.
      Faire déposer par `peer-a` un bulletin contenant un repère
      synthétique unique, par exemple `REPERE-RECETTE-40`, pendant `positions`.
      Sans attendre `rebuttal`, comparer les livraisons reçues par le non-siège
      et la lecture `committee results` de ce membre, avec son `--as` explicite.
      Attendu côté résultats : aucun corps de bulletin lisible pendant le
      scellé. Vérifier séparément si le fan-out livre malgré cela le texte ou
      le repère. Une case scellée dans A-I-D ne prouve pas l’absence de fuite.
- [ ] Rapporter **au lab** la phase, le chemin de livraison observé et la
      présence ou l’absence du repère, y compris si aucune fuite n’est vue.
      Attendu : constat explicite sur #1326, sans corps réel ni données
      d’identité jointes. Ne pas promettre un scellé étanche (#1319, #1326).

Constats : __________

## Par le proxy

- [ ] Sur une instance de recette configurée pour le proxy, tenter l’envoi
      sous la même confirmation. Attendu jusqu’à #1581 : **« non relayé par
      le proxy »**, sans repli automatique vers le CLI. Les lectures committee
      et `baseline-absent` attendent également ce relais. Ne pas traiter ce
      résultat comme une ouverture de salle réussie.

Constats : __________

## Ce que l’e2e couvre déjà

L’e2e utilise un faux `swarph`, sans appel au vrai gateway.
Il vérifie l’aperçu et l’absence d’écriture avant la signature,
puis l’argv et le fichier de sièges reçus par le faux binaire.
Il contrôle le scellé et les deux relectures en rebuttal : abstention, puis absence.
