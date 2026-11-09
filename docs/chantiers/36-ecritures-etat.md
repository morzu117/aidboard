# Chantier 36 : les écritures qui changent un état, par le proxy de #20

| Champ | Valeur |
|---|---|
| État | **Révision 1, 9 novembre 2026** : réponses du lab à L5–L7 (DM 93986), lues dans le gateway déployé (657e7e9) et la PR proxy 702. Révision 0 : Spec rév. 2 (E5 et E6, morzu-vps), d'après le contrat du proxy de #20, draft 2 avec le §10, et les réponses du lab (DM 93681). Julien a retenu : confirmation du téléphone, le 35 bis avant le 36. |
| Emplacement final | `docs/chantiers/36-ecritures-etat.md` sur `main`, dans le premier commit du chantier |
| Base | **`feat/35bis-envoi-reel`** (cd07f1b) : le 36 réutilise `ProxyClient` (D263) et l'écran d'envoi (D267). Il se rebase sur `main` quand le 35 bis est mergé. |
| Organisation | Comme au 35 bis. |
| Validation | Le lab valide le 36. Merge : CI verte, validation du lab, oui de Julien, **après** le 35 bis. |
| Bloqué par | 36.4 attend le document de schéma des arguments et les réponses L5 à L7. 36.5 attend le build mergé du proxy. 36.2 et 36.3 n'attendent rien. |

## 1. Pourquoi

Le 35 bis fait parler A-I-D. Le 36 lui fait changer l'état d'une obligation : la prendre, la refuser ou la clore. Ce sont des écritures qui comptent pour les autres cellules : une obligation close à tort, ou sur un état périmé, fausse le board. Le contrat exige donc un attendu pour chacune, et A-I-D le porte jusqu'à l'écriture, comme au 34 (D224).

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| La lecture des obligations | `src/daemon/mesh/board.ts` | `obligations(cardId)`, `obligations list --card <id> --json --as <cell>`. |
| La fiche d'une carte | `web/src/ecrans/CarteBoard.tsx` | Les obligations de la carte, en lecture. |
| Le client du proxy | `src/daemon/mesh/proxy.ts` (35b.2) | La liste fermée des verbes, à étendre. |
| La porte | `src/daemon/confirmations/` | `preparer` / `executer` (D225). |

Une obligation lue porte, entre autres : `id`, `card_id`, `holder` (une cellule ou `null`), `status` (`open`, `closed`, `fallback_fired`, `withdrawn`), `state`, `taken_at`, `accept` (texte), `accept_format`, `conditions` (liste), `unclosable_reason`.

Les verbes du contrat (§4) : `board.obligations.take` et `.decline` avec `expect_status` ; `.close` avec `expect_status` **et** `expect_accept_sha256`. Une garde absente est un `bad_args`. `board.cards.move` est refusé tant que le gateway déployé ne rend pas `stage_version`, et la cible `done` tant que les agents d'A-I-D n'ont pas leur uid.

La clôture côté CLI (0.72.47) : `--outcome` parmi `pass`, `fail`, `cannot_evaluate`, `skipped` (`skipped` seulement sur une étape facultative), et une preuve, `--evidence` (texte non blanc) et/ou `--evidence-json` (une preuve par condition), selon ce que demande l'`accept` de la ligne.

## 3. Cible et hors-périmètre

**Cible :** sur la fiche d'une carte, à côté d'une obligation, « Prendre », « Refuser » ou « Clore », chacun sous confirmation du téléphone, avec l'attendu tiré de la lecture affichée.

**Hors périmètre :**
- le déplacement de carte (E6) : une simple mention ;
- `amend` et `withdraw` (non relayés par le contrat) ;
- la création d'obligations (`cards ask`).

## 4. Décisions

### D269. Le hash d'accept

- `hashAccept(accept: string | null): string` dans `src/shared/etats.ts` : le SHA-256, en hex minuscule, du texte UTF-8 du champ `accept` **tel que lu**, octet pour octet, sans trim ni normalisation ; la chaîne vide si `accept` est `null` (lab, L1, d'après mesh-gateway `5a567e1`, `server.py:17824`).
- Il doit marcher côté daemon et côté web (Web Crypto et `node:crypto` donnent le même résultat ; un test le fige sur des fixtures, dont un texte avec accents, un retour à la ligne final et `null`).

### D270. Le catalogue fermé

`src/shared/etats.ts`, sur le modèle de `ecritures.ts` :
- `ActionEtat` = `'obligation.prendre' | 'obligation.refuser' | 'obligation.clore'` ;
- `lireParamsEtat(action, brut)`, un schéma fermé par action :
  - toutes : `carte` (entier > 0), `obligation` (entier > 0), `attendu: { status }` ;
  - `obligation.clore` en plus : `attendu.acceptSha256` (64 hex minuscules), `issue` parmi `pass`, `fail`, `cannot_evaluate`, `skipped`, et une preuve : `preuve` (texte de 1 à 4 000 caractères, non blanc, sans caractère de contrôle autre que `\n` et `\t`) et/ou `preuves` (un objet `{ id de condition: texte }`, mêmes règles par texte, 20 conditions au plus) ;
- `resumeEtat(action, params)`, ≤ 160 caractères, **sans la preuve** : « Prendre l'obligation #81 (carte #1457) », « Clore l'obligation #81 (carte #1457) : pass ».
- Les preuves passent par `nettoyer` (D254), comme un texte du 35.

### D271. Les boutons, d'après la lecture

Les boutons sont un confort ; c'est le gateway qui décide (#1525). Sur une obligation lue :
- **Prendre** et **Refuser** : `status` vaut `open`, `taken_at` est `null`, et `holder` est la cellule, ou `holder` est `null` et la cellule figure dans `eligible` de l'étape de l'obligation, lu dans le graphe de la carte (L6, `server.py:15176`). Le graphe se lit par le CLI, comme au 24 : `parseStep` gagne `eligible` (une liste de cellules). Sans graphe lisible, aucun bouton pour une offre ;
- **Clore** : `status` vaut `open`, `holder` est la cellule, `unclosable_reason` est `null` ;
- aucun bouton sinon, ni pour une obligation détenue par une autre cellule.

### D272. L'action `mesh.etat` sous confirmation

- Une action de la porte, `mesh.etat`, en classe « par défaut », avec sa ligne de réglage « Changer un état » (migration à la suite du 35 bis).
- `params` signés : `{ action, params }` de D270.
- `preparer` :
  - valide le schéma, nettoie les preuves ;
  - **relit** les obligations de la carte (`fresh`) et retrouve l'obligation ;
  - refuse tôt, avec « L'obligation a changé depuis ta lecture. Relis la carte. », si son `status` diffère de `attendu.status`, ou, pour `clore`, si `hashAccept(accept)` diffère de `attendu.acceptSha256` ;
  - refuse sans proxy (D262).
- Au « oui », `preparer` est rappelé avec les `params` signés (D225) : la relecture est refaite, juste avant `executer`.
- `executer` appelle le verbe du proxy avec `expect_status` et, pour `close`, `expect_accept_sha256` (noms du contrat), puis lit la réponse.
- **`expect_status` vaut toujours `open`** pour les trois verbes (L5, `server.py:17843`) : une ligne prise garde `status = open`, et c'est `taken_at` qui marque la prise. `preparer` refuse donc tôt si le `status` relu n'est pas `open`, et, pour prendre ou refuser, si `taken_at` n'est plus `null`.
- Le résultat (champ `envoi`, comme au 35b.4) garde le code et le statut, **jamais** la preuve.

### D273. Le refus pour état périmé

- Le gateway répond 409 si l'état a changé entre la relecture et l'écriture (#1517). Le proxy le rend en `upstream_error` avec `status: 409`.
- A-I-D l'affiche « L'obligation a changé juste avant l'écriture. Rien n'a été modifié. Relis la carte. », relit la carte, et **ne réessaie jamais seul**.
- Les autres codes suivent la table de D267 ; un envoi incertain (`upstream_ambiguous`, `delai`, `interrompu`, `format`) invite à relire la carte, sans « Réessayer ».

### D274. La route

- `POST /api/swarph/etat/envoyer` avec `{ action, params }`, par la porte : 202 `{ confirmation }`, ou l'exécution directe si le réglage est coupé.
- 404 sans mesh, 409 `proxy_absent`, 400 pour un schéma refusé, 422 pour un refus de nettoyage, 409 `perime` pour un refus tôt de D272.
- Pas en mode host. Le journal note l'action, la carte, l'obligation, le `request_id` et le code : jamais la preuve.
- Le test « aucun chemin d'envoi » (D268) s'étend : `ProxyClient` reste importé par la seule porte, et aucune route d'écriture autre que `ecrire/apercu`, `ecrire/envoyer` et `etat/envoyer`.

### D275. L'UI

- Sur `CarteBoard`, à côté de chaque obligation, les boutons de D271.
- « Prendre » et « Refuser » ouvrent une petite confirmation locale (« Prendre l'obligation #81 ? »), puis la demande.
- « Clore » ouvre une boîte : l'issue (une liste fermée ; `skipped` seulement si l'étape de l'obligation a `mandatory: false` dans le graphe, L7, `server.py:20461-20475`), puis la preuve : un champ par condition si `conditions` n'est pas vide (le gateway exige alors `evidence_json`, `:13970` et `:14010`), sinon un seul champ.
- **Tant que le verbe `close` du proxy n'accepte ni `evidence_json` ni `skipped`** (PR 702, `proxy_routes.py:73-76`), une obligation à conditions n'a pas de bouton « Clore », et `skipped` n'est pas proposé. Le lab propose de les ajouter à la PR 702. Le texte de l'`accept` est affiché en texte brut au-dessus, pour savoir ce qu'on atteste.
- Après la demande : l'attente de confirmation, puis le libellé du résultat, puis la relecture de la carte.
- **Le déplacement** : une ligne « Déplacer : bientôt, quand le gateway donnera la version de la carte. », sans bouton.

## 5. Points

### 36.1 Le plan

Ce document, sur `feat/36-ecritures-etat`.

### 36.2 Le catalogue et le hash (D269, D270)

`src/shared/etats.ts` et ses tests : le hash figé sur fixtures (daemon et web) ; chaque refus de schéma ; le résumé sans la preuve ; le nettoyage des preuves. Ne dépend de rien.
- *Révision 36.2.* `hashAccept` est `async` (Web Crypto), sans implémentation propre. `preuves: {}` seul ne suffit pas pour clore. Le nettoyage reste dans la route (36.4), sur `textesAPurger(params)`. Aucune ligne existante modifiée. Gate 2789.

### 36.3 L'UI (D271, D275)

Les boutons d'après la lecture, la boîte de clôture, l'attente et les libellés, contre une route simulée. Ne dépend de rien.

### 36.4 L'action et la route (D272 à D274)

Après le document de schéma et les réponses L5 à L7. La relecture et le refus tôt, le 409 relu sans nouvelle tentative, le résultat sans preuve, le mode host, le journal.

### 36.5 Le vrai proxy, l'e2e et la fiche de recette

Après le build mergé. Un test contre le vrai `swarph proxy serve` avec une fausse gateway ; la fiche : prendre puis clore une obligation de test réelle, au téléphone ; un refus 409 provoqué en changeant l'obligation entre l'aperçu et le « oui ».

## 6. Questions au lab

Réponses du lab (DM 93986) :
- **L5.** `expect_status` compare `status`. Les trois verbes attendent `open`. Un 409 rend `current_status` (et `current_accept_sha256` si demandé).
- **L6.** Une offre se prend par tout pair éligible ; l'ensemble éligible est dans `GET /board/cards/{id}/graph`, champ `eligible` par étape. A-I-D le lit par le CLI ; il ne demande **pas** de verbe graph au proxy.
- **L7.** Le gateway accepte et exige `evidence_json` pour un accept à conditions ; `skipped` seulement sur une étape facultative (`mandatory` dans le graphe). **Le proxy (PR 702) n'accepte aujourd'hui ni l'un ni l'autre** : à ajouter, sinon D275 les retire.

## 7. Pièges

- **Le hash se calcule sur le texte tel que lu.** Aucun trim, aucune normalisation Unicode, aucun passage par un rendu.
- **Un 409 n'est pas une erreur à réessayer.** C'est l'information que quelqu'un d'autre a agi.
- **La preuve est un texte libre** : elle passe par le nettoyage et ne sort ni dans le journal ni dans le résultat.

## 8. Fini quand

- 36.2 à 36.5 sont commités, avec `npm run gate` et `npm run e2e` verts.
- La CI est verte, le lab a validé, la recette de Julien est faite, et le 35 bis est mergé avant.
