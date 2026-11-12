# Chantier 46 : le multi-mesh

| Champ | Valeur |
|---|---|
| État | **Révision 1, 12 novembre 2026 (relecture du lab, DM 96861).** Julien a validé la spec, révision 2, et tranché Q-J1 (a). PASS du lab sur la spec (DM 96850). Le commander autorise le branchement du mesh du lab (DM 96847). |
| Emplacement final | `docs/chantiers/46-multi-mesh.md` sur `main` |
| Base | `feat/45-confirmations-completes` (#153), parce que le 46 touche les mêmes confirmations et les mêmes actions d'avis. Se rebase sur `main` après les merges de #152 et #153. |
| Spec | `specs/multi-mesh-46.md`, révision 2 (dossier de travail, hors dépôt). |
| Organisation | morzu-vps gère le chantier. Un agent Codex CLI écrit le code et les tests de chaque point, sur un brief tiré de ce plan. morzu-vps relit chaque diff, lance le gate, commite et ouvre la PR. |
| Validation | Le lab relit le plan, puis le code de 46.3 et 46.4. Ensuite viennent la recette de Julien et son oui pour le merge, CI verte. |

## 0. La condition du commander

Le mesh du lab peut se brancher sur un A-I-D multi-mesh, à côté du mesh de Julien (DM 96847). À une condition : chaque cell du mesh de Julien est une IA de Julien, et le lab peut écrire à chacune. Une cell que le lab ne peut pas joindre, ou l'arrivée d'un tiers, renvoie la question au commander. La décision sera revue quand #20 livrera. La liste des cells est tenue hors du dépôt, dans la spec. La recette avec le mesh du lab attend que chacune soit joignable.

## 1. Pourquoi

Le programme (§5, phase 5, « Plus tard ») prévoit une vue multi-mesh côté client. Le gateway ne fédère pas les meshes entre eux : seul le client peut en tenir plusieurs. Julien veut suivre et piloter, depuis un seul A-I-D, le mesh du lab et un mesh à lui. Chaque mesh a sa propre cell, son propre gateway et, pour les écritures, son propre proxy.

## 2. État actuel

A-I-D suppose un seul mesh partout.

| Zone | Où | Ce qui existe |
|---|---|---|
| La config | `src/daemon/config.ts` : `MeshConfig` (l. 68-88), `parseMesh` (l. 336-415) | Un objet `mesh` unique : `bin`, `cell`, `proxySocket`, `proxyLectureSeule`, `inboxLog`, `cellFile`, `gateway`, `stateRoot`, `tailscale`, `avis`. Une `cell` vide veut dire « mesh désactivé ». |
| Les services | `src/daemon/main.ts:248-317`, `server.ts:230-262` | `MeshService` (un monitor, un `InboxFollower`), deux `BoardReader`, `SwarphReader`, `CommitteeReader` et `CommitteeWriter`. Tous sont construits une fois pour une cell (D277 du 44 : un seul transport, choisi au démarrage). |
| Le proxy | `src/daemon/mesh/proxy.ts`, `confirmations/ecritures.ts:54`, `etats.ts:78` | Le client est sans état. La ligne envoyée ne porte ni cell ni gateway : c'est le proxy qui les porte. Il est recréé à chaque écriture avec `config.mesh.proxySocket`. |
| La base | migrations 009, 018, 025 à 029 | `mesh_inbox.id` est la clé primaire, et cet id n'est unique que dans un gateway. Les numéros de carte nus sont dans `aid_etats`, `aid_propositions`, `swairm_propositions` et `avis_mesh`. `mesh_state(k, v)` est unique. Aucune colonne ne désigne un mesh. |
| L'instantané | `state/snapshot.ts:142-147` | `StateSnapshot.mesh` est un objet unique. Les événements `mesh.dm` et `mesh.state` ne portent pas de mesh. |
| Le corps signé | `pda/demande.ts:52-62`, `porte.ts:174-189` | `CorpsDemandeV2` ne dit pas sur quel mesh porte l'écriture. La cible est fixée à l'exécution par `config.mesh.proxySocket`. |
| Le web | `data/board.ts`, `data/swarph.ts`, `Boite.tsx`, `EcrireAuMesh.tsx`, `FormulaireAvisMesh.tsx`… | Aucune notion de mesh courant. Aucune route ne prend de mesh. |
| Les docs | 24 (l. 86-87), 25 (l. 34), 42 (l. 34), 44 (D277) | Le multi-mesh y est hors périmètre ou reporté. |

## 3. Cible et hors-périmètre

**Cible.**
- **Plusieurs meshes nommés dans la config.** Chacun a sa cell, son gateway et, s'il écrit, son proxy.
- **Toutes les lectures, par mesh :** la boîte, le board, les cells, les canaux, la fédération, la mémoire et les salles d'avis.
- **Toutes les écritures confirmées, par mesh :** le mesh visé est écrit dans le corps signé, et il s'affiche sur le téléphone avant la signature.
- **Une boîte fusionnée**, où chaque message porte le nom de son mesh. Le board, les cells et les onglets swarph se lisent mesh par mesh, avec un sélecteur.
- **L'ancienne config à un seul mesh** reste lisible, sans rien changer.

**Hors-périmètre.**
- Toute fédération entre meshes : aucune donnée ne passe d'un mesh à l'autre de façon automatique.
- Un proxy multi-mesh : un proxy reste lié à une cell.
- La création de cells ou de gateways depuis A-I-D.
- Une salle d'avis répartie sur plusieurs meshes.
- La refonte de l'interface : le chantier ajoute le minimum.

## 4. Décisions

### D311. La config : des meshes nommés

- **La nouvelle clé `meshes`** est une table `nom → MeshConfig`.
  - Le nom suit `^[a-z][a-z0-9-]{0,31}$`.
  - Chaque mesh porte `cell`, `gateway`, `home`, `proxySocket`, `proxyLectureSeule`, `inboxLog`, `cellFile`, `stateRoot` et `avis`.
  - **`home`** est le dossier personnel vu par swarph pour ce mesh. Il vaut par défaut le `HOME` du daemon. Les chemins d'une cell en sont tirés par son nom (`src/daemon/mesh/paths.ts`) : le fichier de jeton `<home>/.config/swarph/<cell>.peer_token`, le fichier de cell `<home>/.config/swarph/cells/<cell>.yaml`, et `stateRoot`, par défaut `<home>/swarph_state`. swarph-cli résout son jeton de la même façon, depuis son `HOME` et `SWARPH_SELF`.
  - `bin` et `tailscale` restent globaux, dans `mesh`.
- **La forme actuelle `mesh: { cell, … }` se lit comme `meshes.principal`.** `principal` est un nom réservé : le mesh des données d'avant le chantier.
- **Avoir les deux formes à la fois est une erreur de config**, avec un message clair. Deux meshes avec la même `cell` et le même `gateway` sont aussi une erreur.
- **Deux meshes ne partagent jamais un fichier.** Un même nom de cell sur deux meshes est le cas attendu : chaque cell de Julien a une identité sur les deux. Sans ce refus, les deux meshes liraient le même fichier de jeton, et un appel au mesh B présenterait le jeton du mesh A au gateway de B. De même, deux `InboxFollower` suivraient le même `inbox.log`, et des DM se rangeraient sous le mauvais mesh. La config est donc refusée si deux meshes mènent :
  - au même fichier de jeton ;
  - au même fichier de cell ;
  - au même dossier `<stateRoot>/<cell>` ;
  - ou au même `inbox.log`.

  Les chemins sont comparés après résolution, en absolu. Pour un même nom de cell, le second mesh pose donc un `home` à lui.
- **Un mesh sans `cell` est désactivé**, comme aujourd'hui.
- **Le nom d'un mesh** est une étiquette locale, choisie par Julien. Il n'est jamais lu depuis le serveur, et c'est lui que l'interface et le téléphone affichent.
- Les exemples de la doc et des tests utilisent `principal` et `perso`, jamais un nom de cell réel.

### D312. L'identité des données : la clé de mesh

La migration 030 ajoute une colonne `mesh` partout où un identifiant swarph est stocké. Les lignes existantes reçoivent `principal`.

- **La colonne `mesh` n'a aucune valeur par défaut** une fois la migration faite. Le défaut ne sert qu'à la reprise des lignes, puis chaque table est reconstruite avec `mesh TEXT NOT NULL`, sans défaut. Sinon, un écrivain qui oublierait le mesh rangerait sa ligne sous `principal`, le mesh du lab, sans bruit, et une écriture prise sur cette ligne partirait vers le mauvais mesh, avec un numéro de carte qui y désigne autre chose.

- **L'identité stable d'un mesh.** Les ids de DM et de carte sont en AUTOINCREMENT par base de gateway, et un second gateway repart de 1 (L5) : les collisions entre meshes sont certaines. Le nom n'est qu'une étiquette locale, qui peut être rebranchée.
  - Une table `meshes_connus(nom, empreinte, vu_a)` garde, pour chaque nom, l'empreinte de son couple : `sha256(jsonCanonique([cell, gateway normalisé]))`, un encodage canonique, pour que deux couples différents ne donnent jamais la même chaîne, en base64url.
  - Au démarrage, si l'empreinte d'un nom a changé, A-I-D **refuse d'activer ce mesh** et l'affiche en erreur. Il n'écrit rien sous ce nom tant que Julien n'a pas choisi « archiver » : les lignes de l'ancien couple passent alors sous `<nom>@archive-<date>`, en lecture seule, et le nom repart à vide.
  - La migration laisse `meshes_connus` vide : SQL n'a pas accès à la config. Au premier démarrage après la migration (46.2), `activerMesh` trouve `principal` nouveau et enregistre l'empreinte de la config courante. Les lignes reprises en `principal` sont donc liées au couple configuré à ce démarrage.

- **`mesh_inbox`** : la clé devient `(mesh, id)`. La table est reconstruite, en gardant les données.
- **`mesh_state`** : la clé devient `(mesh, k)`.
- **`aid_etats`, `aid_propositions`, `swairm_propositions` et `avis_mesh`** gagnent la colonne `mesh`. Les index uniques qui portent une carte ou un canal l'incluent.
- **Les événements `mesh.dm` et `mesh.state`** gagnent un champ `mesh`. Un événement ancien, sans ce champ, se lit comme `principal`.
- **`pda_demandes`** n'a pas besoin de colonne : le mesh d'une demande est dans son corps signé (D313), et `params` est relu depuis ce corps.

### D313. Le corps signé v3 nomme le mesh

- **`CorpsDemandeV3`** = `CorpsDemandeV2` plus `mesh: { nom, cell, gateway, proxy }`, pour toute action mesh. Ici, `gateway` est l'empreinte du gateway normalisé, et `proxy` l'empreinte du chemin absolu du socket du proxy de ce mesh (`sha256(jsonCanonique([chemin]))`, en base64url) (L4). On signe une empreinte, pas le chemin : le corps passe en clair par le relais, et aucun chemin de socket ne sort du daemon. Le nom de cell seul ne fixe pas la destination : il n'est unique que dans un gateway, et c'est la config du proxy qui fixe la cible (`mesh.ecrire`, `mesh.etat`, `mesh.avis`, `mesh.avis.motion`, `mesh.avis.baseline-absent`).
  - Les actions hors mesh (merge, push, etc.) restent en v2.
  - Le contexte de signature ne change pas, `aid-pda-demande-v1` (L1). La v3 a son propre jeu de clés exact. Elle ne vaut que pour les actions mesh, et la v2 refuse toute clé `mesh`. Une v3 échoue donc fermée sur un téléphone d'avant le 46.
- **Le résumé** commence par le nom du mesh, par exemple « [perso] Note sur la carte #12 ».
- **Le téléphone affiche le mesh en tête de l'invite**, avant toute autre ligne. Il vérifie la v3 comme la v2, et refuse une v3 sans `mesh` ou avec un nom hors de la forme de D311.
- **À l'exécution**, la porte prend le mesh du corps signé, jamais celui de l'écran ou de la config par défaut.
  - Si ce mesh n'existe plus dans la config, ou si l'un des quatre champs (`nom`, `cell`, `gateway`, `proxy`) diffère de la config courante, la demande est **périmée**.
  - **Limite connue :** cela fait encore confiance à la config du proxy. Le lien fort demande un verbe d'identité côté proxy swarph, qui rende sa cell et son gateway. Ce verbe n'existe pas, et le lab le cartera si le commander dit oui.
  - Le proxy utilisé est le `proxySocket` de ce mesh. Sans proxy configuré pour ce mesh, l'écriture est refusée avant même la demande, comme aujourd'hui sans proxy.
- **Le hachage de la demande** (`hDemande`, relu par la porte pour les actions mesh) couvre le mesh, puisqu'il couvre tout le corps.
- **La transition.** Le daemon n'émet plus que la v3 pour les actions mesh. Une demande v2 encore ouverte au moment de la mise à jour reste exécutable sur `principal`, jusqu'à son échéance.
- **Le résultat signé du 45 ne change pas.** Son id est unique, et le téléphone connaît le mesh par la demande qu'il a gardée.

### D314. Le daemon : un registre de meshes

- **`MeshRegistry`** tient, pour chaque mesh actif : `MeshService` (un monitor, un `InboxFollower` sur son `inbox.log`), `BoardReader`, `SwarphReader`, `CommitteeReader` et `CommitteeWriter`, et le chemin de son proxy.
- **Ce qui est créé une fois par mesh, au démarrage :** D277 du 44 reste vrai à l'intérieur de chaque mesh, avec un seul transport, choisi au démarrage.
- **L'environnement de chaque appel à `swarph` est construit par liste blanche.**
  - Il part d'un environnement vide, puis reçoit `PATH`, `LANG` et `LC_*`, puis les seules valeurs du mesh : `HOME` (le `home` du mesh, D311), `MESH_GATEWAY_URL`, `SWARPH_STATE` et `SWARPH_SELF`.
  - Aucune autre variable n'est héritée du daemon. Par exemple, `MESH_GATEWAY_TOKEN`, `SWARPH_GATEWAY`, `SWARPH_STATE_ROOT`, `SWARPH_SERVICE_TOKEN`, `SWARPH_BRAIN_GATEWAY`, `MESH_DB_PATH`, `SWARPH_CHANNEL_CELL` ou `SWARPH_MEMORY_DIR` enverraient l'appel vers le mauvais mesh ou la mauvaise identité.
  - Un test le garde : un daemon lancé avec toutes ces variables les voit toutes absentes de l'environnement de chaque appel.
  - La même règle vaut pour l'agent PTY `swarph-cell`.
- **A-I-D ne lit jamais un jeton.** Chaque cell lit le sien dans son état swarph, comme aujourd'hui.
- **La connexion et la déconnexion** (`/api/mesh/connect|disconnect`) se font par mesh.
- **L'agent PTY `swarph-cell`** passe à une session par mesh.
- **Une panne sur un mesh n'arrête pas les autres.** Un mesh injoignable s'affiche dégradé, seul.

### D315. Les routes

- **`GET /api/meshes`** rend la liste `{ nom, cell, actif, etat, ecriture: boolean }`, sans gateway ni chemin.
- **Les routes de lecture** (`/api/mesh/*`, `/api/board/*`, `/api/swarph/*`, `/api/avis-mesh`) prennent `?mesh=<nom>`. Sans paramètre, c'est `principal`, pour la compatibilité. Un nom inconnu donne 404.
- **La boîte** (`/api/mesh/dm/*`) et les marques « vu » ou « décidé » prennent le mesh dans le chemin : `/api/mesh/:mesh/dm/:id/…`. L'ancienne forme vaut pour `principal`.
- **Les routes d'écriture** (aperçu, envoi, avis) prennent `mesh` dans le corps. Il n'a **aucune valeur par défaut** : une écriture sans mesh est refusée (400).
- **L'instantané** gagne `meshes: { [nom]: { state, inbox, checkedAt } }`. `mesh` reste un alias de `meshes.principal` pendant une version, pour le téléphone et le mode host.

### D316. L'interface : le minimum

Elle va bouger : on ajoute le moins possible.

- **La boîte est fusionnée.**
  - Chaque DM porte une pastille avec le nom de son mesh.
  - Un filtre par mesh est replié par défaut.
  - Le tri se fait par heure, tous meshes confondus.
- **Le board, les cells, les onglets swarph et les salles d'avis** se lisent avec un sélecteur de mesh. Il n'apparaît qu'à partir de deux meshes actifs, et il est gardé par écran dans le stockage local.
- **Les écritures.**
  - Le formulaire prend le mesh de l'objet sur lequel il agit (la carte, le DM, la salle) et l'affiche en tête de l'aperçu.
  - Changer de mesh dans un formulaire vide la cible.
  - Il n'y a aucune bascule automatique.
- **La barre** montre une pastille par mesh actif, jusqu'à trois, puis un compte.

### D317. Le cloisonnement entre meshes

- **Aucune donnée ne passe d'un mesh à l'autre sans un geste de Julien.**
  - A-I-D ne relaie, ne cite ni ne recopie rien d'un mesh vers un autre de lui-même.
  - Une écriture sur un mesh ne peut viser qu'une carte, un pair, un canal ou une salle de ce mesh.
- **La citation par jeton du 40** (le charter avis) ne peut citer qu'une carte du mesh de la salle.
- **Pré-remplir une écriture sur le mesh B** à partir d'un DM du mesh A est refusé. Seul le copier-coller manuel reste possible.
- **Les sièges d'une salle d'avis** viennent tous du mesh de la salle. `avis.baseline` et `avis.familles` sont propres à chaque mesh.
- **Limite connue, et c'est la plus importante.** D317 lie le code d'A-I-D, pas les agents qu'A-I-D lance.
  - Un proxy swarph n'admet qu'un seul uid pair. Pour qu'A-I-D écrive sur les deux meshes, les deux proxies doivent admettre l'uid d'A-I-D.
  - Toute session d'agent sous cet uid (un PTY Claude ou Codex, l'agent `swarph-cell`) peut alors lire le mesh du lab par un proxy et poster sur l'autre mesh par le second, sans passer par le code d'A-I-D.
  - Interdire le copier-coller dans l'interface n'y change rien.
  - **La vraie frontière, c'est un uid par mesh pour les sessions d'agent, chacun admis par un seul proxy**, comme dans le modèle de #20. Elle est hors de ce chantier. Julien a choisi d'accepter cette limite (Q-J1, (a)), et le lab ne s'y oppose pas (DM 96850). Elle est écrite sur la fiche de recette.

## 5. Points

### 46.1 La config et la base (D311, D312)

- `src/daemon/config.ts` :
  - la clé `meshes` (nom → `MeshConfig` par mesh), avec la forme du nom ;
  - l'ancienne forme `mesh: { cell, … }`, lue comme `meshes.principal` ;
  - `bin` et `tailscale` restent globaux ;
  - la clé `home` par mesh, et les chemins tirés de `home` (`paths.ts`) ;
  - les erreurs : les deux formes à la fois, deux meshes avec le même couple (cell, gateway), deux meshes qui mènent au même fichier de jeton, au même fichier de cell, au même `<stateRoot>/<cell>` ou au même `inbox.log`, un nom invalide.

  Le reste du daemon continue de lire le mesh `principal` : rien ne change dans son comportement à ce point.
- `src/shared/meshes.ts`, nouveau :
  - `normaliserGateway(url)` : schéma et hôte en minuscules ; le port par défaut retiré (80 en http, 443 en https), un autre port gardé ; la barre finale retirée. Elle **refuse** une URL avec des identifiants (userinfo), une requête, un fragment ou un chemin autre que la racine, et un schéma autre que http ou https ;
  - `empreinteChemin(chemin)` = `sha256(jsonCanonique([chemin absolu]))`, en base64url, pour le socket du proxy (D313) ;
  - `empreinteMesh(cell, gateway)` = `sha256(jsonCanonique([cell, normaliserGateway(gateway)]))`, en base64url.
- **`migrations/030_multi_mesh.sql` :**
  - `mesh_inbox`, reconstruite avec la clé `(mesh, id)`, en gardant les données ;
  - `mesh_state`, avec la clé `(mesh, k)` ;
  - la colonne `mesh` sur `aid_etats`, `aid_propositions`, `swairm_propositions` et `avis_mesh`, et les index uniques qui portent une carte ou un canal l'incluent. Le défaut `'principal'` ne sert qu'à la reprise : les quatre tables, comme `mesh_inbox` et `mesh_state`, sont reconstruites avec `mesh TEXT NOT NULL`, **sans défaut** (D312) ;
  - la table `meshes_connus(nom PRIMARY KEY, empreinte, vu_a)`.
- **Les écrivains existants** (le projecteur de la boîte, les états, les propositions, l'avis) écrivent `mesh = 'principal'`. Les lecteurs filtrent sur `principal`.
- **Les événements `mesh.dm` et `mesh.state`** gagnent le champ `mesh`. Un événement sans ce champ se lit comme `principal`.
- **`activerMesh(db, nom, empreinte)`**, une fonction pure côté base. Elle rend `nouveau`, `connu` ou `rebranche`. `archiverMesh(db, nom)` renomme les lignes en `<nom>@archive-<date>`. Elles servent en 46.2.
- **Tests :**
  - la config dans ses deux formes et chacun de ses refus ;
  - deux meshes avec le même nom de cell : refusés avec le même `home`, acceptés avec deux `home` distincts ;
  - la normalisation (`http://h` et `http://h:80` donnent la même empreinte, et chaque refus) et l'empreinte, avec deux couples qui se concatènent pareil mais donnent deux empreintes différentes ;
  - une insertion sans `mesh` échoue, dans chacune des six tables ;
  - la migration sur une base peuplée : les lignes passent en `principal`, et un même id peut exister dans deux meshes ;
  - `activerMesh` et `archiverMesh` ;
  - aucun test existant ne change de comportement, à part les attentes de version de migration.
46.1 commité. Gate vert (3 629 tests). 66 lignes existantes remplacées : les écrivains et lecteurs passent mesh = 'principal', les fixtures SQL des tests ajoutent le mesh, cinq attentes de version passent de 29 à 30, et une attente de mesh-schema gagne mesh. Les contraintes d'origine (CHECK, index uniques) sont gardées, avec le mesh dans les index. À reprendre en 46.2 : valider le type de d.mesh dans les projecteurs, et brancher activerMesh au démarrage.

### 46.2 Les lectures par mesh (D314, D315)

- `MeshRegistry` : un jeu de services par mesh actif, et `activerMesh` au démarrage. Un nom rebranché reste inactif, et s'affiche en erreur.
- L'environnement de chaque appel à `swarph`, et de l'agent PTY, est construit par liste blanche, avec le test des variables héritées.
- `GET /api/meshes`, `?mesh=` sur les lectures, `/api/mesh/:mesh/dm/:id/…`, la connexion par mesh, et l'instantané `meshes` avec l'alias `mesh`.
- Une panne sur un mesh n'arrête pas les autres.

### 46.3 Les écritures par mesh (D313, D317)

- Le corps v3, avec `mesh = { nom, cell, gateway, proxy }` et son jeu de clés exact. La v2 refuse toute clé `mesh`.
- La porte prend le mesh du corps signé, et rend la demande périmée si l'un des quatre champs a changé.
- Le proxy du mesh signé.
- La transition depuis la v2.
- Le mesh obligatoire dans les routes d'écriture.
- Le cloisonnement côté A-I-D : les cibles du même mesh, la citation par jeton du 40 limitée au mesh, et aucun pré-remplissage d'un mesh vers un autre.
- **Ce code est relu par le lab.**

### 46.4 Le téléphone (D313)

- La vérification de la v3, et le refus d'une v3 hors forme.
- Le mesh en tête de l'invite.
- **Ce code est relu par le lab.**

### 46.5 Le web (D316)

- La boîte fusionnée, avec la pastille et le filtre par mesh.
- Le sélecteur par écran.
- Les formulaires, avec le mesh en tête de l'aperçu.
- La barre.

### 46.6 La fin

- Un e2e avec deux faux meshes.
- La fiche `docs/recette-chantier-46-multi-mesh.md`, avec la limite des agents (Q-J1, (a)).
- Les renvois depuis les plans 12, 24, 25, 42 et 44.

## 6. Pièges

- Ne jamais indexer une donnée par le seul nom d'un mesh : c'est l'empreinte qui le lie à son couple (cell, gateway).
- Ne jamais hériter d'une variable d'environnement du daemon dans un appel à `swarph` : la liste blanche seulement.
- Ne jamais choisir le mesh d'une écriture ailleurs que dans le corps signé.
- Aucun nom de cell réel dans le code, les tests ou la doc : `principal` et `perso` seulement.
- Aucun gateway, chemin de socket ni `home` dans `GET /api/meshes`, dans l'interface ou dans un corps signé : seulement des empreintes.
- Ne jamais donner de valeur par défaut à la colonne `mesh`.
- Deux meshes ne partagent jamais un fichier de jeton, de cell, d'état ou de boîte.
- Les tests de frontière host ne changent pas.

## 7. Fini quand

- Les points 46.1 à 46.6 sont commités.
- Le gate est vert, et la CI de la PR est verte.
- Le lab a rendu PASS sur le code de 46.3 et 46.4.
- Julien a fait la recette, avec deux faux meshes, puis avec le mesh du lab et le sien quand les quatre cells sont joignables, puis il a donné son oui pour le merge.

## 8. Relectures du lab (DM 96840)

- **L1, le contexte : oui.** On garde `aid-pda-demande-v1`, aux conditions de D313.
- **L2, un second proxy : oui, il suit le modèle.** Ce modèle :
  - un `swarph proxy serve --cell X` par cell, avec sa config, son fichier de jeton (magasin 0700, propriété de l'uid du proxy, refusé si l'uid de la cell le possède) et son `socket_path` ;
  - sur le Mac, `socket_path` explicite (par défaut, c'est `/run/swarph-proxy/<user>.sock`) ;
  - un parent du socket qui n'est pas inscriptible par l'uid de la cell ;
  - chaque proxy sous un uid autre que celui d'A-I-D.

  Que les deux proxies admettent l'uid d'A-I-D, c'est la limite de D317.
- **L3, le cloisonnement : D317 ne suffit pas.** C'est la limite connue de D317. Aujourd'hui, la cell d'A-I-D sur le mesh du lab lit déjà tous les DM de ce mesh (acceptation écrite du 27 octobre 2026). Une portée plus étroite viendra avec #733 et #20.
- **L4, le gateway et le socket : oui**, signés dans `mesh` (D313).
- **L5, les ids : oui, ils sont uniques dans un gateway seulement.** Les collisions sont certaines, d'où l'empreinte de D312. Les messages des fils de carte et les DM partagent le même espace d'ids. Le lab n'a pas vérifié qu'une restauration, ou la bascule Postgres de #733, garde les ids.

