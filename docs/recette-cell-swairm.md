# Recette de la cell Swairm (chantier 14)

Grille du point 14.6 du plan `docs/chantiers/14-cell-swairm.md`. Deux niveaux :

- **couverture automatique** — ce que `npm run gate` et `npm run gate:e2e` vérifient déjà sur
  le même chemin, avec le faux CLI `test/fixtures/fake-swairm.sh` (D48). Jamais le vrai
  Swairm, aucun réseau, aucun board lu, aucun jeton GitHub.
- **recette manuelle** — le vrai CLI Swairm, à dérouler par Julien sur le Mac. Aucune case de
  cette partie ne peut être cochée depuis une session automatisée : elle exige que
  `swairm cell` existe.

**État : recette réelle déroulée partiellement le 2026-10-26**, sur release A-I-D 0.4.0 et
`swairm` 0.0.0 (board-schema=1, commit 754697c). Voir « Ce que la recette a révélé ».

## Dépendance externe

Selon le brief du 2026-10-25 (`docs/brief-swairm-cell-cli.md`), `swairm cell` n'existait pas
encore au moment de l'écriture de ce document. Elle est livrée depuis le 2026-10-25 côté
Swairm (`754697c`) et déployée dans `~/.swairm/deploy` ; `swairm --version` répond
`swairm 0.0.0 board-schema=1 commit=754697c`.

## Prérequis humains

- [x] Mode session livré côté Swairm, puis clone `~/.swairm/deploy` et son environnement mis
      à jour (fait le 2026-10-25 côté Swairm : `754697c`, `swairm --version` et `swairm doctor`
      verts, `swairm cell --project <owner/dépôt>` rend l'invite `swairm> ` et sort en 0 sur
      SIGTERM ; A-I-D le lance **sans** `--project`, la déduction par l'`origin` reste à voir
      ici. Défaut cosmétique relevé côté Swairm : l'en-tête affiche « lu il y a jamais »)
- [x] Un lien `swairm` sur le PATH du shell, qui lance le bon clone
- [x] `swairm.bin` posé **en chemin absolu** dans `~/.aid/config.yaml` : le PATH du daemon
      n'est pas celui du shell. Confirmé : `/Users/jhoubart/.local/bin/swairm`

  ```yaml
  swairm:
    bin: /Users/jhoubart/.local/bin/swairm
  ```

- [x] `swairm --version` répond, puis `aid doctor` : la ligne Swairm n'est pas en `warn` —
      couverture automatique : `test/doctor.test.ts`
- [x] Daemon redémarré pour charger sa config (`aid stop` puis `aid`) : la config est lue une
      seule fois au démarrage, et c'est elle qui décide à la fois de l'apparition du bouton
      (`server.ts`) et du lancement (`manager.ts`). Changer `swairm.bin` sans redémarrer ne change
      rien, ni dans un sens ni dans l'autre
- [x] Un sujet actif avec worktree, sur un projet doté d'un board (`morzu117/projet-d`).
      Dépôt sans board et dépôt sans origin pour les replis S2 : **non disponibles au moment
      de la recette**, 14.d non testée. Q1 et Q4 : voir « Ce que la recette a révélé »

## Couverture automatique

Le faux CLI affiche `FAKE_SWAIRM cwd=… argc=… args=…`, quelques variables (présentes ou
absentes, jamais leur valeur), l'invite `swairm> `, puis répond à `help`, `status`, `inbox`,
`events`, `quit`. Il journalise ses appels (`FAKE_SWAIRM_LOG`) et ses entrées
(`FAKE_SWAIRM_INPUT_LOG`).

| Ce qui est couvert                                                                            | Où                                             |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Configuration `swairm.bin`, clés inconnues refusées                                           | `test/config.test.ts`                          |
| Commande exacte `<bin> cell` sans `--project`, cwd, TERM, pas d'ajout mesh ni GitHub          | `test/pty-spawn.test.ts`                       |
| 201 / 400 / 409 désactivé / 409 doublon (y compris autre sujet) / 422 absent, réouverture     | `test/agents-routes.test.ts`                   |
| Arrêt `daemon_stop` sans résumé, manifeste ignoré sans spawn ni saisie                        | `test/reprise.test.ts`                         |
| Statut estimé : `working`, maintien, `idle` à 30 s, `needs_input`, motif résiduel, redessin   | `test/heuristique.test.ts`                     |
| Instantané `swairm?` présent seulement si configuré ; bouton et ordre ; erreur de doublon     | `test/state.test.ts`, `test/web/sujet.test.tsx` |
| Diagnostic du binaire : désactivé, absent, version illisible, version lisible                 | `test/doctor.test.ts`                          |
| Parcours complet : bouton, invite, saisie, rechargement, autre vue, resize, doublon, arrêt    | `e2e/cell-swairm.spec.ts`                      |

Ce que `e2e/cell-swairm.spec.ts` établit : le bouton vient de la seule configuration (ni
board ni mesh) ; la commande de l'agent est `[bin, 'cell']` dans le worktree du sujet ;
`GH_TOKEN`, `GITHUB_TOKEN`, `MESH_GATEWAY_URL` et `SWARPH_SELF` sont absents de la session ;
le rechargement de la page et une seconde vue retrouvent le même agent et le même écran ; le
resize change la taille du terminal et l'écran survit ; un second lancement est refusé avec
l'id de la cell ouverte, y compris depuis un autre sujet ; après l'arrêt, la cell se rouvre
et ne reçoit que ce que l'opérateur tape. Le non-redémarrage automatique du daemon est
prouvé par `test/reprise.test.ts` ; la recette vérifie le cycle réel.

## Poste : macOS — recette manuelle

- [x] 14.a Sans configuration : bouton absent ; avec configuration : bouton « Ouvrir la cell
      Swairm » visible à côté de la cell swarph. Binaire absent : 422 lisible, pas de
      terminal fantôme — couverture automatique : `test/web/sujet.test.tsx`,
      `test/agents-routes.test.ts`
- [x] 14.b Depuis le sujet : session `swairm cell`, cwd du worktree, bon projet déduit ;
      commande enregistrée sans `--project`. Aucun lancement de Claude — couverture
      automatique de la commande : `e2e/cell-swairm.spec.ts`
- [x] 14.c `help`, `status`, `inbox`, `events` restent dans la session ; un nouvel événement
      apparaît selon S1. Mesurer le démarrage (Q5), ne pas supposer une seconde.
- [ ] 14.d Sans board ou sans origin : liste des projets, pas de fermeture de session (S2) ;
      confirmer avec l'opérateur que ce repli est bien l'expérience souhaitée.
      **Non testable à la recette du 2026-10-26** : pas de dépôt sans board ni de dépôt sans
      origin disponible sur le poste au moment du passage. À redéfinir.
- [x] 14.e Statut estimé : invite stable et écran sans motif de demande résiduel dans les
      huit dernières lignes non vides ; après **30 s sans aucun octet**, statut inactif estimé
      (la transition arrive au tick suivant, jusqu'à 2 s plus tard) ; un événement réel
      remet la cell en `working`, puis retour au silence. Un heartbeat, une horloge ou un
      redessin périodique réinitialise le silence : consigner cela comme incompatibilité Q4,
      ne pas le masquer par un seuil modifié — couverture automatique :
      `test/heuristique.test.ts`
- [ ] 14.f Redimensionner de 80 à 200 colonnes, masquer puis rouvrir l'onglet, recharger la
      page ; vérifier l'aperçu et l'écran complet ; écran alternatif et souris si retenus
      (Q6) — couverture automatique du resize et de la reconnexion sur le faux CLI :
      `e2e/cell-swairm.spec.ts` (ne prouve pas la fidélité du vrai CLI).
      **Resize fait (84×31 puis 118×31), masquage/réouverture et rechargement de page non
      testés** : voir « Ce que la recette a révélé » pour la troncature observée sur `inbox`.
- [ ] 14.g Second clic, y compris depuis un autre sujet : 409 avec la cell existante ;
      coexistence d'une cell swarph et d'une cell Swairm ; arrêt puis réouverture réussie —
      couverture automatique : `e2e/cell-swairm.spec.ts`, `test/agents-routes.test.ts`
- [ ] 14.h `quit`, Ctrl-D, Ctrl-C à l'invite et pendant un suivi, arrêt depuis A-I-D :
      sortie propre, curseur et modes restaurés, aucun enfant orphelin ; SIGTERM conforme à S4
- [ ] 14.i Cycle du daemon (`aid stop` puis `aid`) : cell arrêtée avec `daemon_stop`, aucun
      texte de résumé reçu, aucune cell relancée automatiquement ; la réouverture manuelle
      retrouve les données S6 — couverture automatique : `test/reprise.test.ts`
- [ ] 14.j Aucun jeton GitHub ajouté par A-I-D ; ne pas confondre avec le jeton `AID_TOKEN`
      du run ; ne rien imprimer ni recopier de secret pour cette vérification — couverture
      automatique : `test/pty-spawn.test.ts`, `e2e/cell-swairm.spec.ts`

## Ce que la recette a révélé

**Recette déroulée partiellement le 2026-10-26**, sur release A-I-D 0.4.0 et `swairm` 0.0.0
(board-schema=1, commit 754697c), sujet `morzu117/projet-d` (worktree `restart-dev`).
14.a, 14.b, 14.c et 14.e passent. 14.d non testable (pas de dépôt de repli disponible).
14.f partiellement fait. 14.g à 14.j non déroulées (reportées).

- **14.b/14.c — projet déduit, commandes de base** : l'invite s'ouvre sur `morzu117/projet-d`
  sans avoir passé `--project`, la déduction par l'`origin` fonctionne. `help`, `status`,
  `inbox`, `events` répondent correctement avec un contenu cohérent. `clear` n'est pas une
  commande connue (`commande inconnue : clear (tape help)`) — comportement correct, documenté
  par `help`.
- **Q5 (temps de démarrage)** : quasi instantané entre le clic sur le bouton et l'apparition
  de l'invite `swairm> `.
- **14.e — statut estimé** : confirme le comportement déjà documenté en issue #66 (Q4) —
  l'invite `swairm> ` seule n'est pas reconnue comme « attend une réponse » ; le badge de
  l'agent passe à l'état inactif environ 30 s après le dernier octet, comme prévu par
  l'heuristique, puis repasse actif sur un vrai événement. Pas d'incompatibilité
  supplémentaire observée (pas de redessin périodique qui réinitialiserait le silence).
- **14.f — troncature de `inbox` au redimensionnement** : la ligne `decision/1` de `inbox` est
  coupée à la largeur exacte du terminal (coupure après « v1) » à 84 colonnes, après « s'es »
  à 118 colonnes, systématiquement ré-émise à l'identique sur un nouvel appel de `inbox` après
  resize — pas un wrap manquant côté A-I-D mais vraisemblablement un affichage tabulaire
  volontairement tronqué côté `swairm` (COLS connu via le PTY). **Non confirmé formellement** :
  le test de contrôle (`show swairm/capacitor-socle` pour voir si le message complet y
  apparaît) n'a pas été fait, ni le test masquage/réouverture d'onglet, ni le rechargement de
  page. À reprendre si ça redevient pertinent.
- **14.g à 14.j (second clic, sorties `quit`/Ctrl-D/Ctrl-C, cycle du daemon, absence de
  jeton GitHub)** : non déroulées à cette session — travail détourné vers d'autres irritants
  A-I-D (branche dédiée séparée). Restent couvertes uniquement par les tests automatisés sur
  faux binaire.

À savoir pour lancer les e2e sur ce poste (déjà consigné dans `docs/recette-v0.4-mesh.md`) :
le port 4871 est écouté par `AID.app` (`AID_E2E_PORT=4873` contourne), le gate exige Node 22
(`mise exec node@22 --`), et les variables `AID_*` héritées d'une session A-I-D sont à retirer
de l'environnement avant le gate.
