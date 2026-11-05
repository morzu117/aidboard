# Recette de la coque et de la navigation (chantier 25)

Grille du point 25.11 du plan `docs/chantiers/25-coque-navigation.md`. Deux niveaux :

- **couverture automatique** — ce que `npm run gate` et `npm run gate:e2e` vérifient déjà, sur le
  daemon des e2e : faux swarph (`test/fixtures/fake-swarph.sh`), faux Tailscale, faux serveur en
  mode commande `true`. Jamais le vrai swarph, jamais le vrai mesh, aucun réseau, aucun token.
- **recette réelle** — sur le vrai cockpit de Julien, sous Node 22 puis sous Node 24. Aucune case
  de cette partie ne peut être cochée depuis une session automatisée.

Rappels qui valent pour toute la recette :

- le daemon de travail (port 4870) fait tourner des agents : la recette se fait sur une instance à
  part, lancée depuis le worktree de la branche ; rien n'est redémarré ni réinstallé sur le daemon de
  travail sans l'accord de Julien ;
- **Déconnecter arrête le monitor de la cell** : toutes les sessions de `morzu-mac`, Claude compris,
  ne sont plus réveillées par les DM jusqu'à la reconnexion. L'étape 25.11.4 ne se fait que si Julien
  l'accepte sur le moment ; sinon elle reste couverte par `e2e/mesh.spec.ts` ;
- ne jamais lancer `swarph mesh inbox` : il consomme la boîte ; `tailscale.manage` reste `false`.

## Couverture automatique (état à la PR)

| Point | Vérifié par |
|---|---|
| Rangement : sections (D103), prochaine chose (D108), tuile de projet (D105) ; une attente range en À décider, même celle d'un shell | `test/web/rangement.test.ts` |
| Bandeau commun : ton avec libellé, rôle `status` ou `alert` (D110) | `test/web/bandeau.test.tsx` |
| Réglages, section Mesh : état, âge de la lecture, Connecter, confirmation de Déconnecter au texte de D100, ancre `#mesh` ; `checkedAt` et l'éphémère `mesh.checked` (D99 bis, rév. 2) | `test/web/reglages-mesh.test.tsx`, `test/mesh-service.test.ts` |
| Barre du haut : la pastille mène à Réglages, ne bascule plus ; « Connecter à swarph » sans mesh ; âge du board sur son seul écran (D101) | `test/web/barre.test.tsx`, `test/web/board.test.tsx`, `test/web/boite.test.tsx` |
| Page `/swarph` : les étapes sans mesh, le renvoi au réglage avec | `test/web/swarph.test.tsx` |
| Barre gauche par état, préférence `rangement` (D104), « Ranger par mes groupes » ; les data-node de la case ne sont pas ceux de la barre | `test/nav-routes.test.ts`, `test/web/nav-etat.test.tsx` |
| Bloc VPS : agrégat des agents par serveur, suivi coupé et reprise échouée, une carte par serveur et son action (D106) | `test/server-status-agents.test.ts`, `test/web/nav-vps.test.tsx` |
| Accueil en sections, Trancher déplie la décision, Relire, Suivre, Reprendre, « local », compteur ; sans swarph, l'encart mène à `/swarph` (D107, D108) | `test/web/accueil.test.tsx` |
| Ce qui a bougé en phrases ; un type ou un cas inconnu n'est pas affiché (D109) | `test/web/fil-activite.test.tsx` |
| Bandeaux : Board indisponible au-dessus du message (dernière lecture réussie, Réessayer) ; Suivi coupé, Session perdue, Machine injoignable sur la discussion (D110) | `test/web/board.test.tsx`, `test/web/carte-board.test.tsx`, `test/web/discussion.test.tsx` |
| De bout en bout : sections de la barre et de l'accueil, bascule des groupes aller-retour, pastille vers Réglages sans bascule, `/swarph` avec mesh, bloc VPS sur le faux serveur et Diagnostiquer | `e2e/coque.spec.ts` ; Connecter et Déconnecter avec confirmation, la Boîte et les DM : `e2e/mesh.spec.ts` |

Non couvert en e2e : « sans swarph » (le daemon des e2e a un mesh configuré) ; couvert par les tests
unitaires de la barre, de l'accueil et de `/swarph`.

## Prérequis sur le Mac

- [ ] L'instance de recette tourne sur la branche `feat/25-coque-navigation` (head : _à noter_),
  sous Node 22 (`node --version` : _à noter_)
- [ ] Le monitor `morzu-mac` tourne, Tailscale est connecté
- [ ] Au moins un serveur est configuré (le VPS), avec une discussion

## Recette réelle

- [ ] 25.11.1 Barre gauche : les sujets sont rangés en À décider, À relire, En cours, En pause ; En
  pause est repliée. Les tuiles de projet filtrent la liste et « Nouveau sujet » ; un second clic
  retire le filtre. Tous, Épinglés, Archivés mènent à l'accueil filtré.
  - Constat : _à remplir_
- [ ] 25.11.2 Réglages, « Ranger par mes groupes » : la barre reprend tes groupes du chantier 15, tels
  quels (noms, couleurs, ordre, replis). Décocher la remet par état. Le choix survit à un rechargement.
  - Constat : _à remplir_
- [ ] 25.11.3 Barre du haut : la pastille dit « monitor actif · N à traiter » et mène à Réglages,
  section Mesh, sans rien basculer. Sur `/board`, « board lu il y a N s » ; ailleurs, pas d'âge.
  - Constat : _à remplir_
- [ ] 25.11.4 (seulement avec l'accord de Julien sur le moment) Réglages, Déconnecter : la
  confirmation dit « Le monitor de la cell morzu-mac s'arrête… » avant d'agir ; Confirmer, puis
  Connecter, et la pastille revient à « monitor actif ».
  - Constat : _à remplir, ou « non fait »_
- [ ] 25.11.5 Bloc VPS : la carte du VPS dit Connecté, la latence, le nombre d'agents actifs et
  « session persistante ». Si un lien tombe pendant la recette, la carte passe en Suivi coupé et
  Reconnecter ouvre la discussion, qui porte le bandeau. Ne pas provoquer de coupure exprès.
  - Constat : _à remplir_
- [ ] 25.11.6 Accueil : les mêmes sections que la barre ; chaque ligne a sa prochaine chose et
  « local ». Une décision en attente : Trancher la déplie sous la ligne, la réponse part de là. Le
  menu Tri a disparu.
  - Constat : _à remplir_
- [ ] 25.11.7 Ce qui a bougé : des phrases (« Claude lancé », « Sujet fusionné », « Question de … »),
  aucun nom d'événement brut.
  - Constat : _à remplir_
- [ ] 25.11.8 Board indisponible : Tailscale arrêté, Relire sur `/board` ; le bandeau ambre
  « Board indisponible » donne l'heure de la dernière lecture réussie, au-dessus de « Le gateway ne
  répond pas ». Tailscale relancé, Réessayer : tout revient.
  - Constat : _à remplir_
- [ ] 25.11.9 Les mêmes points 25.11.1, 25.11.3, 25.11.6 sous Node 24 (`node --version` : _à noter_).
  - Constat : _à remplir_

## À valider par Julien

- [ ] D99 bis, rév. 2 : l'heure de lecture du monitor part en éphémère `mesh.checked` et n'est pas
  stockée ; `mesh.state` reste émis au seul changement (2 880 lignes par jour évitées).
- [ ] 25.7 : la carte par serveur est dans `web/src/ui/NavVps.tsx`, nouveau, plutôt que dans
  `NavServeurs.tsx` comme l'écrivait le plan ; `NavServeurs` reste celui du mode `groupes`, inchangé.

## Ce qui n'est pas couvert

- Les étiquettes VPS et mesh sur les lignes de sujet : aucun lien sujet → serveur ni sujet → carte
  n'existe encore. « local » est la seule étiquette.
- A-I-D ne connaît que l'état du monitor : ni nom de mesh, ni nombre de cells.
