# Recette du board swarph en lecture seule (chantier 24)

Grille du point 24.10 du plan `docs/chantiers/24-board-lecture-seule.md`. Deux niveaux :

- **couverture automatique** — ce que `npm run gate` et `npm run gate:e2e` vérifient déjà sur
  le même chemin, avec le faux binaire `test/fixtures/fake-swarph.sh` et les fixtures
  synthétiques de `test/fixtures/board/` (projet 42 `projet-test`, cartes 101 et 102, pairs
  `peer-a` et `peer-b`). Jamais le vrai swarph, jamais le vrai mesh, aucun réseau, aucun token.
- **recette réelle** — le vrai board, à dérouler par Julien sur le Mac. Aucune case de cette
  partie ne peut être cochée depuis une session automatisée. Les conditions de la porte 0.b
  (#1459, note 89780) s'appliquent à cette partie, pas au build.

Rappels qui valent pour toute la recette :

- ne jamais lancer `swarph mesh inbox` : il consomme la boîte ;
- ne rien coller de privé (token, contenu d'un dépôt privé) dans un DM ou un canal : tout DM du
  mesh est lisible par tous les pairs ;
- A-I-D lance seulement les six lectures de la liste fermée (D93), toujours `--json --as <cell>`,
  jamais `--no-redact`, `--token-file`, `inbox` ni `--consume`.

## Couverture automatique (état à la PR)

| Point | Vérifié par |
|---|---|
| Parsing défensif, `trusted_author_column`, `withdrawn` + `requested` fermée, `truncated`, `capped` | `test/board-parse.test.ts` |
| Vecteurs d'arguments exacts, identifiant refusé avant exécution, classement des erreurs (`unknown` jamais `unreachable`), sortie > 4 Mo refusée, cache de 5 s, `fresh`, lectures simultanées fusionnées, lecture non bloquée par un `connect()` | `test/board-reader.test.ts` |
| Routes `/api/board` : 200 et résultat discriminé, 404 sans mesh, 400 sur identifiant invalide, stderr jamais renvoyé, token de run refusé, `inbox.log` intact | `test/board-routes.test.ts` |
| `aid doctor` sous 0.72.40 : un ⚠ « la vue board demande 0.72.40 » | `test/doctor-swarph-version.test.ts` |
| Magasin web : focus, 60 s, rien onglet caché ou daemon perdu, réponse en retard ignorée | `test/web/board-store.test.ts` |
| Écran Board et fiche : colonnes dans l'ordre reçu, texte brut, messages et actions, petite largeur, lien GitHub seul cliquable | `test/web/board.test.tsx`, `test/web/carte-board.test.tsx` |
| De bout en bout : board, fiche, 403, gateway injoignable puis rétabli, code 2, `inbox.log` identique, journal sans lecture interdite, sans mesh ni lien ni route | `e2e/board.spec.ts` |

## Prérequis sur le Mac

État constaté le 2026-11-05 : `swarph --version` répond `swarph-cli 0.72.40`, monitor
`cell-aid` lancé en `--deliver pull`, Tailscale connecté.

- [ ] 24.10.1 `swarph --version` donne au moins 0.72.40 ; `aid doctor` n'affiche pas
  « la vue board demande 0.72.40 »
- [ ] Le monitor `cell-aid` tourne (`swarph monitor start --as cell-aid --deliver pull`)
- [ ] Tailscale est connecté, `cell-lab` est dans les pairs
- [ ] `~/.aid/config.yaml` a `mesh.cell: cell-aid` et le gateway ; `tailscale.manage` reste `false`
- [ ] A-I-D tourne sur la branche `feat/24-board-lecture-seule` (head : _à noter_)

## Recette réelle

- [ ] 24.10.2 Le lien « Board » est dans la barre. Le projet 18 s'affiche, colonnes dans l'ordre
  des `stage` reçus. La carte #1432 s'ouvre avec son fil et son graphe (`state` en entier,
  « Manque »). La carte #1457 s'ouvre aussi.
  - Constat : _à remplir_
- [ ] 24.10.3 La carte #559, ouverte par l'URL (`/board/cartes/559`), affiche « Tu ne peux pas
  lire cette carte ». Relever aussi ce que donne le bloc Obligations de cette fiche
  (`obligations list --card 559`) : rien, ou un refus. Le lab veut le voir.
  - Constat : _à remplir_
- [ ] 24.10.4 Tailscale arrêté : Relire affiche « Le gateway ne répond pas ». Tailscale relancé :
  tout revient, par Relire ou à la relecture suivante (60 s).
  - Constat : _à remplir_
- [ ] 24.10.5 Sur une carte qui a un vrai DM : relever `wc -l
  ~/swarph_state/cell-aid/mesh-sidecar/inbox.log` et l'état lu des DM, ouvrir la fiche (lecture
  de `cards thread`), relever à nouveau. Les deux relevés doivent être identiques.
  - Avant : _à remplir_
  - Après : _à remplir_

## Côté lab

- [ ] La même recette dans le bac à sable du lab contre le vrai mesh, **après** la revue de
  sécurité (porte 0.b du programme)
  - Constat : _à remplir par le lab_

## Ce qui n'est pas couvert

- Le téléphone : la petite largeur est prête, mais le téléphone n'atteint pas le cockpit avant
  le chantier 31. Rien ici ne promet l'accès mobile.
- Aucune écriture : pas de commentaire, pas de « Prendre », pas de consigne. C'est voulu.
