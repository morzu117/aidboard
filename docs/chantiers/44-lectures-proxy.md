# Chantier 44 : les lectures d'A-I-D par le proxy de #20

| Champ | Valeur |
|---|---|
| État | **Révision 0, 10 novembre 2026.** Spec rév. 1 (morzu-vps), d'après le document de schéma publié du proxy (swarph-cli `docs/proxy-protocol.md`, PR 702), les réponses du lab à L8–L11 (DM 94174), la décision de Julien sur #1539 (b) et le relevé du Mac (DM 94859). Réponses du lab à L12–L14 (DM 94888) ; L15 retirée. |
| Emplacement final | `docs/chantiers/44-lectures-proxy.md` sur `main` |
| Base | `feat/35bis-envoi-reel` (eca9903) : le 44 réutilise le client du proxy du 35b.2 (D263). |
| Organisation | Comme au 35 bis. morzu-vps gère le chantier ; Codex CLI écrit le code et les tests de chaque point ; morzu-vps relit, lance le gate, commite et ouvre la PR. |
| Validation | Le lab valide le 44, qui conditionne la bascule du Mac. Merge : CI verte, validation du lab, oui de Julien. |
| Bloqué par | 44.6 attend le proxy du Mac installé en lecture seule (#1539 (b)). |

## 1. Pourquoi

Après la bascule, la cellule n'a plus **aucun** jeton, lectures comprises (contrat §9 ; lab, DM 93998). Tout ce qu'A-I-D lit aujourd'hui par `swarph … --as <cell>` en sous-processus cessera de marcher sur le Mac dès que le proxy y sera installé. Avec #1539 (b), le proxy du Mac servira d'abord **aux lectures seulement** : le 44 est le chantier qui rend la bascule possible.

## 2. État actuel

| Lecture A-I-D | Où | Commande aujourd'hui | Verbe du proxy |
|---|---|---|---|
| Projets (24) | `src/daemon/mesh/board.ts` | `board projects list` | `board.projects.list` `{}` |
| Cartes d'un projet (24) | idem | `board cards list --project <id>` | `board.cards.list` `{project}` (entier ; A-I-D a déjà l'id) |
| Fiche d'une carte (24) | idem | `board cards show <id>` | `board.card.get` `{id}` |
| Graphe (24, 36) | idem | `board cards graph <id>` | `board.cards.graph` `{id}` |
| Fil (24, 38) | idem | `board cards thread <id> --limit N` | `board.cards.thread` `{id, limit}` |
| Obligations (24, 35, 36) | idem | `board obligations list --card <id>` | `board.obligations.list` `{card_id}` |
| Cells (37) | `src/daemon/mesh/lectures.ts` | `mesh peers` | `mesh.peers` `{}` |
| Réglages (37) | idem | `rights --json` | `rights` `{}` |
| Memory, liste et page (37) | idem | `memory list`, `memory get` | `memory.list` `{type?, tag?, limit?}`, `memory.get` `{slug}` |
| Memory, liens (37) | idem | `memory links` | **aucun** (L9) |
| Federation (37) | idem | `codegraph` | local, sans jeton : **inchangé** |
| Swairm (39) | `src/daemon/swairm/ask.ts` | `swairm ask` (le CLI local de swairm, sans mesh ni jeton) | **inchangé** |
| DM reçus (12) | `src/daemon/mesh/service.ts`, `inbox.ts` | A-I-D lance `swarph monitor` et suit `inbox.log` | le monitor passe sous l'utilisateur du proxy (L11) |

Sur le Mac (DM 94859) : swarph-cli 0.72.40, le daemon lancé par l'app de bureau, un monitor non supervisé, une config `mesh` réduite à `cell` et `gateway`.

## 3. Cible et hors-périmètre

**Cible :** avec `mesh.proxySocket` réglé, toutes les lectures du Board, des onglets swarph et de la Boîte marchent sans jeton, par le proxy, avec les mêmes écrans. Ce qui n'a pas de verbe le dit clairement.

**Hors périmètre :**
- les écritures (35 bis, 36) : sur le Mac, elles restent coupées par la configuration du proxy (#1539 (b)) ;
- la confirmation par acte dans le proxy (#1539 (a)) ;
- l'installation du proxy et du monitor sur le Mac (Julien, d'après les modèles launchd du build) ;
- la mise à jour de l'app du Mac.

## 4. Décisions

### D277. Un seul transport à la fois

- Si `mesh.proxySocket` est réglé, **toutes** les lectures passent par le proxy, sans repli sur le CLI. Sinon, elles restent sur le CLI, comme aujourd'hui. Il n'y a pas de mélange, ni de bascule à chaud : le transport est choisi au démarrage, à partir de la config.
- `BoardReader` et `SwarphReader` gardent leur interface, leur cache de 5 s et leur fusion des demandes. Seul le transport change : un petit port `Lecteur` (CLI ou proxy) derrière `load`.
- `codegraph` reste local dans les deux modes.

### D278. Les verbes de lecture

- Une liste fermée `VERBES_LECTURE`, **séparée** de celle des écritures (D263) : `board.projects.list`, `board.cards.list`, `board.card.get`, `board.cards.graph`, `board.cards.thread`, `board.obligations.list`, `mesh.peers`, `rights`, `memory.list`, `memory.get`. Un verbe hors liste est refusé avant toute connexion.
- Les `args` suivent le schéma publié : entiers positifs, `limit` entre 1 et 1000, `name` et `slug` selon leurs regex. Aucune valeur n'est convertie.
- Le test D268 s'étend : le module des lectures n'appelle que des verbes de `VERBES_LECTURE` ; seule la porte appelle un verbe d'écriture.

### D279. Les formes brutes

- Le `body` est la réponse **brute** du gateway, pas la projection `--json` du CLI (L10). Pour le board, le CLI imprime déjà le corps du gateway tel quel ; pour `mesh.peers` (PR 693), `rights` et Memory (l'enveloppe `{result}` que le CLI dépaquette), les formes diffèrent (L13, L14).
- Chaque parseur accepte les deux formes, avec une fixture par forme. Les fixtures du proxy viennent du document de schéma et des réponses du lab, jamais d'une sortie du CLI.

### D280. Les erreurs de lecture

Vers les `BoardErrorKind` existants (`src/shared/board.ts`) :

| Résultat du proxy | `kind` |
|---|---|
| `proxy_unavailable`, `connexion` | `unreachable` |
| `upstream_unreachable` | `unreachable` |
| `upstream_error` avec 401 | `credential` |
| `upstream_error` avec 403 | `forbidden` |
| `upstream_error` avec 404 | `not-found` |
| `upstream_error`, autre statut | `unknown` |
| `delai` | `timeout` |
| `upstream_ambiguous`, `interrompu` | `unreachable` : une lecture n'est jamais « incertaine » |
| `verb_not_allowed`, `bad_args`, `peer_not_allowed` | `unknown`, journalisé comme défaut d'A-I-D ou de config |
| `format` | `format` |

`detail` n'est jamais remonté. Un body trop gros est déjà refusé par le proxy (1 Mio) : il arrive en `upstream_error`.

### D281. Les DM reçus

- Un réglage `mesh.inboxLog` (un chemin). S'il est réglé, A-I-D **cesse d'appeler** `swarph monitor start|stop|status` et suit ce fichier (L11 : sur le Mac, `/private/var/log/swarph-proxy/<cell>/monitor/inbox.log`, en 0640, groupe `cell-<cell>`).
- L'état du monitor affiché devient « géré par le proxy ». Connecter ou déconnecter ne touche plus qu'au suivi du fichier. Un fichier absent ou illisible se dit tel quel.
- `mesh.proxySocket` sans `mesh.inboxLog` : le daemon refuse la config au démarrage, avec un message clair (sinon la Boîte serait vide sans raison).

### D282. Ce qui n'a pas de verbe

- **Memory, les liens** (L9) : en mode proxy, la page affiche « Les liens ne sont pas disponibles par le proxy. », sans appel.
- **Swairm** : `swairm ask` est le CLI local de swairm, sans mesh ni jeton (L15 retirée, DM 94888) : inchangé, comme `codegraph`.

## 5. Points

### 44.1 Le plan

Ce document, sur `feat/44-lectures-proxy`.

### 44.2 Le transport (D277, D278, D280)

Le port `Lecteur`, `VERBES_LECTURE`, le choix au démarrage, la traduction des erreurs, et les tests contre le faux proxy du 35b.2 : chaque lecture en mode proxy appelle le bon verbe avec les bons `args` ; aucun appel au CLI en mode proxy ; aucun appel au proxy en mode CLI ; le cache et la fusion inchangés ; chaque ligne de D280.

### 44.3 Les formes brutes (D279)

D'après L12–L14 (DM 94888) : `POST /messages` rend toujours `id`, `closed_obligations` et `open_obligations` (une clé absente est `format`) ; Memory rend `{result: …}`, et la liste peut être un tableau ou `{pages: […]}` ; le fil et `rights` sont identiques au CLI ; `mesh peers` diffère par le filtrage de la PR 693. Une fixture par lecture et par forme ; les parseurs acceptent les deux.

### 44.4 Les DM (D281)

`mesh.inboxLog`, `MeshService` sans monitor en mode proxy, l'état « géré par le proxy », le refus de config.

### 44.5 L'UI (D282)

Le message des liens de Memory, et l'état du monitor dans Réglages.

### 44.6 Le vrai proxy et la recette

Un test contre le vrai `swarph proxy serve`, en lecture seule, avec une fausse gateway (L4). La fiche de recette du Mac, après l'installation du proxy en lecture seule par Julien : Board, fiche d'une carte, Cells, Memory, Boîte, et la preuve qu'aucune écriture ne part (le proxy les refuse).

## 6. Pièges

- **Pas de repli.** Un proxy en panne ne doit jamais renvoyer au CLI avec un jeton : sur le Mac, il n'y en aura plus.
- **Les formes brutes ne sont pas celles du CLI.** Un parseur testé seulement contre le CLI cassera le jour de la bascule.
- **Le monitor ne doit pas tourner deux fois.** En mode proxy, A-I-D ne lance jamais `swarph monitor` ; sinon deux monitors liraient la même boîte.

## 7. Fini quand

- 44.2 à 44.6 sont commités, avec `npm run gate` et `npm run e2e` verts.
- Le lab a validé, la CI est verte, Julien a dit oui.
