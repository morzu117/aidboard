# Chantier 44 : les lectures d'A-I-D par le proxy de #20

| Champ | Valeur |
|---|---|
| État | **Révision 0, 10 novembre 2026.** Spec rév. 1 (cell-gestion), d'après le document de schéma publié du proxy (swarph-cli `docs/proxy-protocol.md`, PR 702), les réponses du lab à L8–L11 (DM 94174), la décision de Julien sur #1539 (b) et le relevé du Mac (DM 94859). Réponses du lab à L12–L14 (DM 94888) ; L15 retirée. |
| Emplacement final | `docs/chantiers/44-lectures-proxy.md` sur `main` |
| Base | `feat/35bis-envoi-reel` (eca9903) : le 44 réutilise le client du proxy du 35b.2 (D263). |
| Organisation | Comme au 35 bis. cell-gestion gère le chantier ; Codex CLI écrit le code et les tests de chaque point ; cell-gestion relit, lance le gate, commite et ouvre la PR. |
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

Multi-mesh : voir le chantier 46 (D314, D315), qui applique le choix unique du transport à chaque mesh, avec son proxy et ses lecteurs propres.

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

### D283. Le proxy en lecture seule

Le proxy du Mac est en lecture seule par défaut (#1539 (b) ; swarph-cli PR 712, `d029fea`, DM 95003) : chaque verbe d'écriture répond `verb_not_allowed` sans appeler le gateway. Sans le savoir, A-I-D proposerait « Envoyer », « Prendre », « Refuser » et « Clore », ferait confirmer chaque acte au téléphone, puis échouerait.
- Un réglage `mesh.proxyLectureSeule` (booléen, `false` par défaut ; `true` sur le Mac tant que #1539 (a) n'est pas livré). Il ne vaut que si `mesh.proxySocket` est réglé.
- S'il vaut `true`, les routes `ecrire/envoyer` et `etat/envoyer` répondent 409 `proxy_lecture_seule` **avant** la porte : aucune demande de confirmation n'est créée. L'aperçu et « Copier » du 35 restent.
- L'état du mesh vu par le web dit `ecritures: false` ; le web désactive « Envoyer » avec « Le proxy de ta cellule est en lecture seule : rien ne peut partir. », et n'affiche ni « Prendre », ni « Refuser », ni « Clore ».
- Le réglage ne crée aucune garantie : c'est le proxy qui refuse. Un `verb_not_allowed` reçu malgré tout garde son libellé du 35 bis.

### D284. Un monitor supervisé n'est ni démarré ni arrêté par A-I-D

Depuis le 10 novembre, le monitor du Mac tourne sous un LaunchAgent (`--supervisor launchd:<label>`, KeepAlive), comme celui de cell-gestion sous systemd. Aujourd'hui, A-I-D lance `swarph monitor start` à la connexion et `swarph monitor stop` à la déconnexion. Or un `stop` pose une « supervision hold » : le superviseur ne relance plus le monitor, et le `start` suivant d'A-I-D, lancé sans superviseur, lève le hold puis démarre un monitor détaché, hors de toute supervision.
- `parseMonitorStatus` lit le champ `supervisor` de `swarph monitor status --json` : une chaîne non vide, ou rien.
- **Monitor vivant et supervisé :** à la connexion, A-I-D n'appelle pas `monitor start` ; à la déconnexion, il n'appelle pas `monitor stop`, et il arrête seulement son propre suivi (follower et rafraîchissement). Le monitor continue de recevoir les DM.
- **Monitor arrêté, ou vivant sans superviseur :** rien ne change.
- L'état du mesh gagne `superviseur: string | null`, le nom brut rendu par swarph, sans chemin. Les Réglages affichent « Supervisé par <superviseur> : A-I-D ne le démarre ni ne l'arrête. »
- En mode proxy (`mesh.inboxLog`), rien ne change : A-I-D n'appelle déjà aucune commande du monitor.

## 5. Points

### 44.1 Le plan

Ce document, sur `feat/44-lectures-proxy`.

### 44.2 Le transport (D277, D278, D280)

Le port `Lecteur`, `VERBES_LECTURE`, le choix au démarrage, la traduction des erreurs, et les tests contre le faux proxy du 35b.2 : chaque lecture en mode proxy appelle le bon verbe avec les bons `args` ; aucun appel au CLI en mode proxy ; aucun appel au proxy en mode CLI ; le cache et la fusion inchangés ; chaque ligne de D280.
- *Révision 44.2.* `src/daemon/mesh/lecteur.ts` (`creerLecteurCli`, `creerLecteurProxy`, `classerErreurProxy`), `VERBES_LECTURE` et `argumentsLectureValides` dans `proxy.ts`, avec un paramètre `verbes` du client. Une lecture accepte un `body` objet ou tableau ; une écriture garde l'objet. Le body est sérialisé puis reparsé pour les parseurs existants. Les liens de Memory rendent `not-configured`, sans appel, jusqu'au 44.5. `parsePeers` attend encore une chaîne : `mesh.peers` par le proxy donne `format` jusqu'au 44.3. 29 lignes existantes modifiées. Gate 2813.

### 44.3 Les formes brutes (D279)

D'après L12–L14 (DM 94888) : `POST /messages` rend toujours `id`, `closed_obligations` et `open_obligations` (une clé absente est `format`) ; Memory rend `{result: …}`, et la liste peut être un tableau ou `{pages: […]}` ; le fil et `rights` sont identiques au CLI ; `mesh peers` diffère par le filtrage de la PR 693. Une fixture par lecture et par forme ; les parseurs acceptent les deux.
- *Révision 44.3.* `src/shared/swarph.ts` : 21 lignes ajoutées, aucune modifiée. Une version absente donne `""`. Un pair sans `name` est ignoré, pas la liste. 11 fixtures dans `test/fixtures/proxy/`, avec seulement des valeurs d'exemple. Gate 2845.

### 44.4 Les DM (D281)

`mesh.inboxLog`, `MeshService` sans monitor en mode proxy, l'état « géré par le proxy », le refus de config.
- *Révision 44.4.* `mesh.inboxLog` dans `config.ts` (absolu, requis avec `proxySocket`), `MeshService` sans aucun `run` de `monitor` en mode proxy, `MeshMonitor` gagne `'proxy'`. Un fichier absent donne `'absent'`, illisible `'stopped'` ; le rafraîchissement reprend le suivi dès qu'il redevient lisible. Au démarrage du daemon, le suivi reprend si le fichier se lit, comme un monitor détaché en mode CLI. 11 lignes existantes modifiées, 2 ajoutées côté web. Gate 2831.

### 44.5 L'UI (D282)

Le message des liens de Memory, et l'état du monitor dans Réglages.
- *Révision 44.5.* `BoardErrorKind` gagne `proxy-indisponible`, pour les liens de Memory seulement. Sans indicateur de transport côté web, `'absent'` et `'stopped'` gardent leurs libellés du mode CLI ; seul `'proxy'` dit « Géré par le proxy de ta cellule. ». 2 lignes existantes modifiées (des assertions). Gate 2849, plus un test instable de `conversation-codex`, vert seul trois fois.

### 44.7 Le proxy en lecture seule (D283)

`mesh.proxyLectureSeule`, le 409 avant la porte, `ecritures` dans l'état du mesh, l'UI sans boutons d'écriture, et un test contre le vrai proxy réglé `read_only: true`.
- *Révision 44.7.* `proxyLectureSeule` dans `MeshConfig` ; l'état du mesh gagne `ecritures` et `proxyConfigure`, ce qui distingue « pas de proxy » de « lecture seule ». Les fixtures d'état du web et `host-masque.test.ts` gagnent ces deux booléens, sans aucun changement de masquage (autorisé par cell-gestion). Vrai proxy 24/24, e2e board 8/8. 14 lignes existantes modifiées. Gate 2964.

### 44.6 Le vrai proxy et la recette

Un test contre le vrai `swarph proxy serve`, en lecture seule, avec une fausse gateway (L4). La fiche de recette du Mac, après l'installation du proxy en lecture seule par Julien : Board, fiche d'une carte, Cells, Memory, Boîte, et la preuve qu'aucune écriture ne part (le proxy les refuse).
- *Révision 44.6.* `test/vrai-proxy-lectures.test.ts` : 12 tests, aucun écart révélé par le vrai proxy. Avec les écritures, `npm run test:vrai-proxy` donne 23 tests verts contre swarph-cli `main` (be8ed2b). La recette du Mac attend l'installation du proxy en lecture seule par Julien (le build `read_only` de #5022). Gate 2943.

### 44.8 Le monitor supervisé (D284)

`supervisor` lu dans le statut ; ni start ni stop pour un monitor vivant et supervisé ; `superviseur` dans l'état du mesh et les Réglages.
- *Révision 44.8.* Le statut est lu avant le `start` à la connexion, et relu juste avant le `stop` à la déconnexion. Les fixtures d'état du web et `host-masque.test.ts` gagnent seulement `superviseur: null`. 20 lignes existantes modifiées, 22 tests ajoutés. Gate 3007 (échecs connus hors CI : install, update-check).

## 6. Pièges

- **Pas de repli.** Un proxy en panne ne doit jamais renvoyer au CLI avec un jeton : sur le Mac, il n'y en aura plus.
- **Les formes brutes ne sont pas celles du CLI.** Un parseur testé seulement contre le CLI cassera le jour de la bascule.
- **Le monitor ne doit pas tourner deux fois.** En mode proxy, A-I-D ne lance jamais `swarph monitor` ; sinon deux monitors liraient la même boîte.

## 7. Fini quand

- 44.2 à 44.6 sont commités, avec `npm run gate` et `npm run e2e` verts.
- Le lab a validé, la CI est verte, Julien a dit oui.
