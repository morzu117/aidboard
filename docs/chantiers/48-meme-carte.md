# Chantier 48 : même carte, deux états

| Champ | Valeur |
|---|---|
| État | **Révision 0, 13 novembre 2026.** Julien a validé la spec (Q-J1 à Q-J3). Le lab a rendu PASS sur sa révision 1 (DM 97457), après un REVISE sur l'identité d'une carte (DM 97453). |
| Emplacement final | `docs/chantiers/48-meme-carte.md` sur `main` |
| Base | `main`, après le merge du 47 (#159). |
| Spec | `specs/meme-carte-48.md`, révision 1 (dossier de travail, hors dépôt). |
| Organisation | morzu-vps gère le chantier. Un agent Codex CLI écrit le code et les tests de chaque point, sur un brief tiré de ce plan. morzu-vps relit chaque diff, lance le gate, commite et ouvre la PR. |
| Validation | Le lab relit le code de 48.1. Ensuite viennent la recette de Julien et son oui pour le merge, CI verte. |

## 1. Pourquoi

Le bloc 13 du plan d'architecture prévoit une liste « même carte, deux états » entre réseaux. Il dépend de l'export masqué (bloc 12), que le lab n'a pas commencé. Depuis le 46, A-I-D lit directement chaque mesh où il a une cell : sur ces meshes, il n'a pas besoin d'export pour voir une carte. Le 48 couvre ce cas, en lecture seule, et laisse le reste au bloc 12.

Julien relie à la main des cartes qui suivent le même travail sur plusieurs meshes. A-I-D montre leurs états côte à côte, et signale quand leurs étapes divergent. Rien n'est écrit sur aucun mesh.

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| La lecture d'une carte | `src/daemon/mesh/board.ts:109` (`card`) | Quatre lectures : la carte, le graphe, le fil et les obligations. Aucune lecture de la carte seule. |
| Le parseur | `src/shared/board.ts:365` (`parseCard`) | Ne garde pas `thread_uuid`, que `cards show` rend déjà (`test/fixtures/board/cards-show-101.json:32`). |
| Le registre | `src/daemon/mesh/registre.ts:72` (`obtenir`) | Les services d'un mesh par son nom ; l'empreinte de chaque mesh (D312). |
| La garde admin | `src/daemon/routes/mesh.ts` (`POST /api/meshes/:nom/archiver`) | `req.principal?.kind !== 'admin'` rend 403. |
| La base | `migrations/` jusqu'à `031_demande_mesh.sql` | Aucune table de liens entre cartes. |
| La fiche d'une carte | `web/src/ecrans/CarteBoard.tsx` | Une carte d'un seul mesh. |
| Le board | `web/src/ecrans/Board.tsx` | Les cartes d'un projet, sur le mesh du sélecteur (46). |

## 3. Cible et hors-périmètre

**Cible.** Des groupes de cartes reliées, au plus une par mesh. Leur état se lit sur le mesh de chaque carte et s'affiche sur la fiche de la carte et dans une liste du board.

**Hors périmètre.**

- L'export masqué (bloc 12), et les réseaux où A-I-D n'a pas de cell.
- Tout rapprochement automatique (Q-J1) : ni par titre, ni par contenu, ni par score.
- Toute écriture sur un mesh à cause d'un lien, y compris dans le champ `links` d'une carte (L3).
- La synchronisation des états.
- Le téléphone, l'appareil et le mode host.

## 4. Décisions

### D321. Le groupe et l'identité d'un membre

- Un groupe réunit au moins deux cartes, sur deux meshes différents, et au plus une carte par mesh (Q-J2). Une carte appartient au plus à un groupe.
- **Un membre** est désigné par le nom du mesh, son empreinte (D312), le numéro de carte, le `thread_uuid` de la carte et sa date de création.
- **Le `thread_uuid` et la date** sont ceux que le daemon lit sur le mesh au moment de l'ajout, jamais des valeurs envoyées par le web. Une carte sans `thread_uuid` est refusée (DM 97457 : une très vieille carte peut ne pas en avoir).
- **À chaque lecture**, le daemon compare l'empreinte, le `thread_uuid` et la date à ce qu'il a gardé :
  - une empreinte différente, ou un mesh inactif : `mesh_change` ;
  - un `thread_uuid` ou une date différents, ou une carte disparue : `carte_remplacee` ;
  - une lecture en erreur ou hors délai : `lecture_impossible` ;
  - sinon : `ok`.
- Un membre qui n'est pas `ok` ne montre aucun champ de sa carte. On peut le retirer du groupe, mais jamais le rattacher à nouveau en silence.

### D322. Le stockage, local seulement

- **La migration 032** ajoute deux tables :
  - `groupes_cartes(id INTEGER PRIMARY KEY, note TEXT, cree_a TEXT NOT NULL)` ;
  - `membres_groupe(id INTEGER PRIMARY KEY, groupe INTEGER NOT NULL REFERENCES groupes_cartes(id) ON DELETE CASCADE, mesh TEXT NOT NULL, empreinte TEXT NOT NULL, carte INTEGER NOT NULL, thread_uuid TEXT NOT NULL, carte_creee_a TEXT, ajoute_a TEXT NOT NULL)`, avec deux contraintes d'unicité : `(mesh, empreinte, carte)` et `(groupe, mesh, empreinte)`.
- `note` compte au plus 120 caractères, rendus en texte. On compte au plus 500 groupes.
- Rien de ces tables ne sort d'A-I-D : ni dans un corps signé, ni dans une écriture mesh, ni dans l'instantané, ni sur le serveur host.
- L'archivage d'un mesh (46) ne touche pas ces tables : le membre devient `mesh_change`, puisque l'empreinte du mesh réactivé diffère.

### D323. La lecture et les routes

- **`BoardReader.carte(id)`** ne lit que `cards show`, avec le cache existant du lecteur. `parseCard` garde `threadUuid`.
- **`GET /api/cartes-reliees?limite=&apres=`** rend `{ groupes, suivant }` : au plus `limite` groupes (20 par défaut, 50 au plus), d'id supérieur à `apres`, dans l'ordre des ids, et `suivant`, l'id du dernier, ou `null` s'il n'y en a plus. Le daemon ne lit que les membres de ces groupes. Pour chaque membre :
  - `{ id, mesh, carte, statut }` ;
  - si le statut est `ok` : `titre`, `etape`, `responsable`, `obligations`, `echeance` et `maj`.
  - Le groupe porte en plus `ecart: true` quand les étapes de ses membres `ok` diffèrent, par égalité de texte.
- **`GET /api/cartes-reliees?mesh=&carte=`** rend le groupe de cette carte, ou `null`.
- **Les lectures** passent par le lecteur du mesh de chaque membre, jamais par celui d'un autre. Le daemon lance au plus 4 lectures à la fois, et garde un cache de 60 s indexé par `(mesh, empreinte, carte)`.
- **Les écritures locales** suivent la garde admin de `POST /api/meshes/:nom/archiver`, sans passer par la porte du téléphone :
  - `POST /api/cartes-reliees` avec `{ membres: [{mesh, carte}, {mesh, carte}], note? }` ;
  - `POST /api/cartes-reliees/:id/membres` avec `{ mesh, carte }` ;
  - `DELETE /api/cartes-reliees/:id/membres/:membre` ; un groupe qui tombe sous deux membres est supprimé ;
  - `PATCH /api/cartes-reliees/:id` avec `{ note }`.
- **Les refus :**
  - 400 : un corps mal formé, une note trop longue, deux membres sur le même mesh, ou un mesh qui n'est pas actif ;
  - 404 : une carte introuvable ;
  - 409 : une carte sans `thread_uuid`, une carte déjà dans un groupe, un mesh déjà présent dans le groupe, ou plus de 500 groupes.
- Le serveur host n'expose aucune de ces routes.

### D324. L'affichage

- **La fiche d'une carte** (`CarteBoard`) montre une section « Même carte ailleurs » si la carte est reliée. Pour chaque autre membre, elle donne :
  - le mesh et le numéro ;
  - les champs de D323, ou le statut en clair (« mesh changé », « carte remplacée », « lecture impossible ») ;
  - un lien vers la fiche de l'autre carte, sur son mesh.
- **Le bouton « Relier à une carte d'un autre mesh »** ouvre un dialogue :
  - le choix du mesh, parmi les meshes actifs autres que celui de la carte ;
  - le numéro de la carte ;
  - un aperçu des deux cartes, lu par la route du board de chaque mesh, avant la confirmation.
- **La liste « Cartes reliées »** sur le board réunit les groupes, avec l'étape de chaque membre et une pastille « écart ». Elle ne lit que les groupes affichés.
- **Tout champ lu sur un mesh est rendu en texte** par React.
- **Avec un seul mesh actif**, ni le bouton ni la liste n'apparaissent. Un groupe déjà créé reste visible sur la fiche, avec son membre `mesh_change`.

## 5. Points

### 48.1 Le stockage, la lecture et les routes (D321, D322, D323)

- La migration 032.
- `parseCard` garde `threadUuid`.
- `BoardReader.carte(id)`.
- Un module `src/daemon/cartes-reliees/` : le dépôt, le calcul des statuts, la limite de 4 lectures et le cache.
- Les routes, branchées dans `server.ts`.
- **Tests :**
  - la migration, ses contraintes d'unicité et la cascade ;
  - `parseCard`, avec et sans `thread_uuid` ;
  - la création avec un `thread_uuid` lu sur le mesh, même si le corps en envoie un autre ;
  - chaque refus de D323 ;
  - chaque statut de D321, dont `carte_remplacee` quand le `thread_uuid` change sous le même numéro, et `mesh_change` après un archivage ;
  - aucun champ pour un membre qui n'est pas `ok` ;
  - le calcul de `ecart` ;
  - au plus 4 lectures simultanées, et le cache de 60 s ;
  - le lecteur du bon mesh, avec deux faux meshes ;
  - la garde admin ;
  - aucune route `/api/cartes-reliees` sur le serveur host ;
  - aucune écriture mesh pendant toute la suite.
48.1 commité. Gate vert (3 851 tests). Migration 032, identité par thread_uuid lu sur le mesh, statuts, pagination, 4 lectures à la fois, cache par (mesh, empreinte, carte). À relire par le lab.

### 48.1c Les corrections du lab (DM 97474)

- **Les membres orphelins.** Quand un groupe tombe sous deux membres, `retirer` supprime d'abord ses membres (`DELETE FROM membres_groupe WHERE groupe = ?`), puis le groupe, dans la même transaction. On ne compte pas sur la cascade, même si `db.ts` active `foreign_keys`.
- **La date de création** se compare comme un instant (`Date.parse` des deux côtés, null égal à null, une date illisible comparée comme du texte). Le `thread_uuid` reste comparé en égalité stricte.
- **Un échec de lecture** n'est gardé en cache que 5 s. Une lecture réussie l'est toujours 60 s.
- **La garde de lecture.** Sur le daemon local, un jeton de run ne peut faire que `POST /api/events` : toute lecture, du board comme des cartes reliées, est réservée à l'admin. Le téléphone passe par le serveur host, qui n'expose pas ces routes. Un test le montre pour `GET /api/cartes-reliees`.
- **Tests :**
  - retirer un membre d'un groupe de deux ne laisse aucune ligne, et la carte restante peut être reliée à nouveau ;
  - deux écritures du même instant ne rendent pas « carte remplacée » ;
  - un échec de lecture se relit après 5 s ;
  - un jeton de run reçoit 403 sur `GET /api/cartes-reliees`.

### 48.2 Le web (D324)

- `web/src/data/cartes-reliees.ts`, la section de `CarteBoard`, le dialogue et la liste du board.
- **Tests :**
  - la section, avec chaque statut ;
  - le dialogue : le choix des meshes, l'aperçu et l'appel ;
  - la liste, avec la pastille « écart » ;
  - un seul mesh actif : ni bouton ni liste, mais un groupe existant reste visible sur la fiche ;
  - un titre de carte contenant du HTML, rendu en texte.

### 48.3 La fin

- Un e2e avec deux faux meshes : relier deux cartes, voir les deux états, voir l'écart, puis changer le `thread_uuid` d'une carte sous le même numéro et voir « carte remplacée ».
- La fiche `docs/recette-chantier-48-meme-carte.md`.
- La ligne du README.

## 6. Pièges

- Ne jamais prendre le `thread_uuid` ou la date d'une carte dans le corps d'une requête.
- Ne jamais lire un membre avec le lecteur d'un autre mesh, ni mettre ses données dans le cache d'un autre mesh.
- Ne jamais écrire sur un mesh à cause d'un lien.
- Ne jamais montrer les champs d'un membre qui n'est pas `ok`.
- Aucun nom de cell réel dans le code, les tests ou la doc : `principal`, `perso`, `peer-a`, `peer-b`.
- Les tests de frontière host ne changent pas.

## 7. Fini quand

- Les points 48.1 à 48.3 sont commités.
- Le gate est vert, et la CI de la PR est verte.
- Le lab a rendu PASS sur le code de 48.1.
- Julien a fait la recette, puis il a donné son oui pour le merge.
