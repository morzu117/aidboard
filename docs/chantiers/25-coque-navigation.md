# Chantier 25 : coque et navigation

| Champ | Valeur |
|---|---|
| État | **Révision 1, 5 novembre 2026.** Spec validée par Julien le 5 novembre (`specs/coque-v1.md`). **Plan validé par Julien le 5 novembre.** Relecture légère du lab sur la pastille (programme §5 bis) : d'accord sur les trois points, deux demandes de libellé intégrées en D99, D99 bis et D100 (message 90587, réponse à 90586). |
| Emplacement final | `docs/chantiers/25-coque-navigation.md` sur `main`, dans le premier commit du chantier |
| Base | **05961d9** (`origin/main`, PR #118). Les `fichier:ligne` ont été lus sur cette base. |
| Spec | `docs/fusion-aid-swarph/spec-driven-plan/specs/coque-v1.md` (dossier de travail, hors dépôt), qui adapte les fiches V4 `barre-haut`, `barre-gauche`, `accueil`, `sans-swarph`, `etats` et `regles-globales`. Captures `Top`, `NavEtat`, `NavVps`, `Home`, `HomeSolo`, `Etats` dans `design/aid-refonte-review-2026-11-04-v4.zip`. |
| Programme | `docs/fusion-aid-swarph/spec-driven-plan/programme.md`, phase 2 |
| Validation | Julien (interface purement locale, commander 89702). Recette sous Node 22 et 24. |

## 1. Pourquoi

La V4 refait la coque autour d'une question : qu'est-ce qui t'attend ? Les sujets se rangent par ce qu'ils attendent de toi, la barre du haut montre les liaisons sans servir d'interrupteur, et chaque panne dit ce qui marche encore. Le cockpit actuel a déjà presque tous les morceaux (chantiers 15, 17 à 21, 24). Ce chantier les réarrange, avec les seules données qu'A-I-D a aujourd'hui.

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| Barre du haut | `web/src/ui/Barre.tsx:68-224`, montée par `Layout.tsx:124` | Logo en `<span>` (`:88`) ; liens `LIENS` (`:59-66`) ; lien Board si mesh (`:151-161`) ; **pastille mesh qui bascule** connect/disconnect (`:164-187`, `Layout.tsx:71-99`) ; point daemon (`:188-196`) ; recherche (`:197-211`) ; Nouveau sujet (`:212-220`) |
| Barre gauche | `web/src/ui/Nav.tsx:57-1051`, `web/src/ui/NavServeurs.tsx` | Vues (`navVues.ts:8-15`), groupes éditables et glisser-déposer (D54, D55 ; `Nav.tsx:743-1018`), rail réduit (`prefs.reduit`, D58), serveurs en lignes (`NavServeurs.tsx:111-138`), pied « daemon local · mesh · cell X » (`Nav.tsx:604-608, 1026-1036`) |
| Préférences de la barre | `NavPrefs` (`src/shared/model.ts:238`), `PATCH /api/nav/prefs` (`src/daemon/routes/nav.ts:320-327`, corps `PrefsBody` à `:153`), table `nav_pref` | Seulement `reduit` |
| Accueil | `web/src/ecrans/Accueil.tsx` (`Contenu` à `:503`) | Titre (`:576`), bloc « Décisions en attente » avec `DecisionCard` (`:643-680`), table à plat triée décisions d'abord (`:604-614`), filtre et Tri (`:690-720`), `ActionLigne` Trancher, Reprendre, Lancer, Désarchiver (`:381-501`), aside avec `FilActivite` et l'état (`:847-870`) |
| Bandeaux | `BandeauDaemon` (`Accueil.tsx:45`), `BandeauMaj` (`:118`), `MessageBoard` (`Board.tsx:36`) | Chacun fait à part |
| Serveurs | `ServerStatus` (`model.ts:295-303`) par `GET /api/servers/status` (`routes/servers.ts:161`), relu toutes les 30 s (`web/src/data/serveurs.ts:12`) ; test par étapes (`ServerTest`, `GET/POST /api/servers/:id/test`) ; suivi par agent : `connection_lost` (`src/daemon/remote/agents.ts`, `child.ts`), Reconnecter par agent (`routes/serverDiscussions.ts:156`) | Aucun agrégat des agents par serveur |
| Mesh | `state.mesh` absent si `mesh.cell` est vide (`main.ts:222`, `server.ts:69-71`) ; `MeshState` connecté, Tailscale, monitor, en attente, depuis, cell | Ni nom de mesh, ni cells en ligne |
| Board | `luA` dans `BoardStore` (`web/src/data/board.ts:18`), `PastilleLecture` (`Board.tsx:90`) | L'âge n'existe que dans l'écran Board |
| Réglages | `web/src/ecrans/Reglages.tsx` : Projets, Hooks, Notifications, Version | Pas de section Mesh |

## 3. Cible et hors-périmètre

**Cible** : la fiche `coque-v1.md`, lignes « Construit » et « Gardé ».

**Hors-périmètre** (lignes « Plus tard » de la fiche) : mentions VPS et mesh sur un sujet, étape « 3/5 », preuve attendue, champ de démarrage, « Pas encore sur le board », Livrer (27), entrée Meshes et multi-mesh, compte de cells, numéro d'essai de reconnexion, dernier commit poussé, Transfert, bandeaux Fournisseur, Mesh injoignable, Téléphone et SSO, écran Machines (29), Modifier et mode réduit de la variante C, connexion par QR (33). Aucune écriture sur le board, aucune nouvelle commande swarph.

Multi-mesh : voir le chantier 46 (D316), qui ajoute les pastilles par mesh et les sélecteurs à partir de deux meshes actifs, sans changer la présentation à un seul mesh.

## 4. Décisions

| # | Décision | Pourquoi |
|---|---|---|
| **D99** | La pastille de la barre du haut **affiche** ce qu'elle mesure : « monitor actif · N à traiter », « monitor périmé » (`stale`), « monitor arrêté » ou « hors mesh depuis… », jamais « connecté » ; l'âge de la lecture de `monitor status` quand il dépasse 90 s ; le daemon ; et « board lu il y a N s » sur les écrans du board seulement. Un clic mène à `/reglages#mesh`. Elle n'écrit plus rien. | Choix de Julien. Un clic distrait coupait le monitor. Le lab (90587) : `monitor status` prouve que le processus tourne, pas que les DM arrivent. D97 ne change pas : aucune lecture du board hors de son écran. |
| **D100** | Réglages gagne une section **Mesh** : l'état, Connecter (`POST /api/mesh/connect`), Déconnecter avec confirmation. La confirmation nomme la cell et dit ce qui s'arrête : « Le monitor de la cell morzu-mac s'arrête. Toutes les sessions de cette cell, Claude compris, ne seront plus réveillées par les DM jusqu'à la reconnexion. » La logique de bascule de `Layout.tsx:71-99` y passe telle quelle, avec son délai de 30 s. | Conséquence de D99. Le lab (90587) : Déconnecter coupe le monitor de la cell, pas seulement la vue d'A-I-D. |
| **D99 bis** | `MeshState` gagne `checkedAt` (optionnel) : l'heure de la dernière lecture de `monitor status`, relue toutes les 30 s pendant la connexion (`src/daemon/mesh/service.ts:211, 336`). L'événement `mesh.state` part à chaque relecture, plus seulement à un changement. | Il faut cette heure pour dire l'âge de l'état (90587). Une émission toutes les 30 s ne coûte rien. |
| **D99 bis, rév. 2** | Construit autrement, même résultat : `checkedAt` n'entre pas dans `MeshState`. Le daemon le tient en mémoire, le joint à l'instantané (`state.mesh.checkedAt`) et l'envoie à chaque lecture par un message éphémère `mesh.checked`, relayé aux sockets sans être stocké. `mesh.state` reste émis au seul changement. | Les événements ne sont jamais purgés : un `mesh.state` stocké toutes les 30 s ferait 2 880 lignes par jour de connexion, et chaque client relirait l'instantané complet à chaque fois. L'éphémère suit le chemin de `server.status` (17). Validé par Julien le 5 novembre. |
| **D101** | L'âge du board atteint la barre par un petit magasin partagé, alimenté par `BoardStore` : la dernière `luA` affichée et l'écran du board ouvert ou non. Rien de nouveau n'est lu. | La barre est montée par `Layout`, l'écran par la route. |
| **D102** | Sans swarph (`state.mesh` absent), un bouton « Connecter à swarph » mène à la page `/swarph` : ce qu'apporte swarph, la marche à suivre (installer swarph, `swarph onboard`, `mesh.cell` et le gateway dans `config.yaml`, relancer). A-I-D n'écrit pas la config. | Choix de Julien. Pas de flux de connexion avant le 33. |
| **D103** | Un sujet a une **section**, calculée côté client de l'agent le plus urgent (`mostUrgent`) : `attente` → À décider ; `relire` et `erreur` → À relire ; `cours` → En cours ; `pause` ou aucun agent vivant → En pause. Un agent vivant `inactif` (shell, veille) → En cours. Même fonction pour la barre gauche et l'accueil. | Une seule règle, testée une fois. |
| **D104** | `NavPrefs` gagne `rangement: 'etat' \| 'groupes'`, `'etat'` par défaut, porté par le même `PATCH /api/nav/prefs`. `'groupes'` rend la barre du chantier 15 **intacte**, avec ses `data-node`. | Choix de Julien : rien de ce que le 15 a livré n'est retiré. |
| **D105** | Tuile de projet : la première lettre du nom et une couleur tirée de `COULEURS_GROUPE` (`Nav.tsx:26`) par un hachage stable de l'id du projet. `Nav` passe la palette à la barre par état en prop, sans export, pour éviter un import circulaire. Aucune colonne en base. | Un projet n'a ni icône ni couleur ; en choisir une est hors chantier. |
| **D106** | Le bloc VPS montre une carte par serveur. Les états viennent de `ServerStatus`, et `GET /api/servers/status` gagne un champ optionnel `agents` : vivants, suivi coupé, reprise échouée, dernier événement. Le daemon l'agrège depuis les agents de serveur qu'il tient déjà. | Le « Suivi coupé » d'un serveur n'existe que par agent. Champ optionnel : les clients actuels l'ignorent. |
| **D107** | Accueil : la table à plat devient des sections, dans l'ordre de D103. Le conteneur garde `1-1.table` et les lignes gardent `1-1.table.ligne-N`, numérotées dans l'ordre d'affichage. Le bloc « Décisions en attente » est fondu dans À décider : la ligne montre la question comme prochaine chose, et Trancher déplie la `DecisionCard` sous la ligne. Le menu Tri disparaît. | V4 ; on garde la réponse depuis l'accueil, et les tests qui lisent `ligne-N` restent justes tant que les décisions viennent d'abord, comme aujourd'hui. |
| **D108** | Prochaine chose : la question en attente (`Agent.pending`), sinon `statusMessage`, sinon la phase du sujet, sinon « Aucun agent sur ce sujet ». Relire ouvre le sujet sur le dernier tour ; Suivre ouvre le sujet. | Données existantes seulement. |
| **D109** | « Ce qui a bougé » : une table de phrases par type d'événement ; un type absent de la table n'est pas affiché. | V4 : « sans événements techniques bruts ». |
| **D110** | Un composant `Bandeau` commun (constat, ce qui continue, une action, ton neutre, ambre ou rouge, toujours avec un libellé). Les bandeaux existants ne sont pas migrés dans ce chantier. | Insertion seulement. La migration se fera quand on y touchera. |

## 5. Points

Chaque point est un commit, gate vert. Les lignes existantes modifiées sont comptées dans le message de commit.

### 25.1 Le plan, et les règles de rangement

- **Fichiers** : ce plan ; `web/src/ui/rangement.ts` (nouveau) : `sectionDe` (D103), `prochaineChose` (D108), `tuileProjet` (D105) ; `test/web/rangement.test.ts`.
- **Vérification** : `npm run gate`

### 25.2 Composant `Bandeau`

- **Fichiers** : `web/src/ui/Bandeau.tsx` (nouveau) et ses styles, dans un fichier à part de `maquette.css` (voir Pièges) ; `test/web/bandeau.test.tsx`.
- **Vérification** : `npm run gate`

### 25.3 Réglages, section Mesh

- **Fichiers** : `src/shared/model.ts` et `src/daemon/mesh/service.ts` : `checkedAt` (D99 bis) ; `web/src/ecrans/Reglages.tsx` (section insérée, ancre `#mesh`) ; la bascule de `Layout.tsx:71-99` déplacée dans un hook `web/src/data/useMeshBascule.ts`. Confirmation sur Déconnecter, au texte de D100.
- **Tests** : `test/mesh-service.test.ts` gagne `checkedAt` et l'émission à chaque relecture.
- Sans swarph : la section dit que le mesh n'est pas configuré et mène à `/swarph`.
- **Tests** : `test/web/reglages-mesh.test.tsx`.
- **Vérification** : `npm run gate`

### 25.4 Barre du haut

- **Fichiers** : `web/src/ui/Barre.tsx` : **modifications autorisées** du logo (`<span>` → `Link` vers `/`, même `data-node`) et du bouton mesh (devient un `Link` vers `/reglages#mesh`, même `data-node` `barre.mesh` et `barre.mesh.texte`, `data-action` `nav.reglages-mesh`) ; âge du board (D101) ; « Connecter à swarph » si `mesh` est absent. `Layout.tsx` : `onToggle` retiré de `barreMesh`. `web/src/data/board.ts` : publication de `luA` (D101).
- **Tests** : `test/web/barre.test.tsx` ; `e2e/mesh.spec.ts` passe par Réglages pour connecter (modification autorisée de ses clics).
- **Vérification** : `npm run gate`, `npm run gate:e2e`

### 25.5 Page « Connecter à swarph »

- **Fichiers** : `web/src/ecrans/Swarph.tsx` (nouveau), route `/swarph` dans `App.tsx`, `EcranId` (`Barre.tsx:12`) gagne `'swarph'`.
- **Tests** : `test/web/swarph.test.tsx`.
- **Vérification** : `npm run gate`

### 25.6 Barre gauche, rangement par état

- **Fichiers** :
  - `src/shared/model.ts` : `NavPrefs.rangement` (D104) ; `src/daemon/routes/nav.ts` : lecture et `PATCH` (modification autorisée de `PrefsBody` et du gestionnaire) ;
  - `web/src/ui/NavEtat.tsx` (nouveau) : tuiles de projet, sections, lignes (gras si À décider, grisé en pause), Tous, Épinglés, Archivés en liens discrets, Serveurs, meshes en route (cell et état) ou « Connecter à swarph » ;
  - `web/src/ui/Nav.tsx` : au début de `Nav`, rend `NavEtat` si `prefs.rangement === 'etat'`, sinon la barre actuelle sans autre changement ;
  - Réglages : la bascule « Ranger par mes groupes ».
- **Tests** : `test/web/nav-etat.test.tsx`. Les tests existants de la barre (`nav.test.tsx`, `nav-edition.test.tsx`, `nav-edition.spec.ts`, `sujet-colonnes.spec.ts`) passent en `rangement: 'groupes'` par leur fixture, sans autre changement.
- **Vérification** : `npm run gate`, `npm run gate:e2e`

### 25.7 Bloc VPS

- **Fichiers** : `src/shared/model.ts` : `ServerStatus.agents?` (D106) ; le daemon le remplit dans `statusesRefreshing` (`src/daemon/remote/connection.ts:116`) ; `web/src/ui/NavVps.tsx` (nouveau) : la carte par serveur, en mode `etat` seulement ; `NavServeurs.tsx` reste celui du mode `groupes`, inchangé (écart validé par Julien le 5 novembre).
- **États** : Connecté (latence, agents actifs, session persistante) ; Reconnexion… ; Suivi coupé (Reconnecter ouvre la discussion) ; Session perdue (Reprendre… ouvre la discussion) ; Injoignable (étape du dernier test, Diagnostiquer relance le test).
- **Tests** : `test/server-status-agents.test.ts`, `test/web/nav-vps.test.tsx`.
- **Vérification** : `npm run gate`

### 25.8 Accueil en sections

- **Fichiers** : `web/src/ecrans/Accueil.tsx` : sections (D107), compteur à côté du filtre, prochaine chose (D108), « local », Relire et Suivre dans `ActionLigne`, `DecisionCard` dépliée par Trancher. Sans swarph, l'encart explique la connexion et mène à `/swarph`.
- **Tests** : `test/web/accueil.test.tsx` gagne les sections ; les attentes sur `1-1.decisions.*` et `1-1.table.tri` sont modifiées (comptées dans le commit).
- **Vérification** : `npm run gate`, `npm run gate:e2e` (`pilotage.spec.ts` lit `1-1.decisions.decision-1.carte.question`)

### 25.9 Ce qui a bougé

- **Fichiers** : `web/src/ecrans/FilActivite.tsx` : table de phrases (D109).
- **Tests** : `test/web/fil-activite.test.tsx`.
- **Vérification** : `npm run gate`

### 25.10 Bandeaux d'état

- Board indisponible : sur les écrans du board, avec l'heure de la dernière lecture et Réessayer (au-dessus du `MessageBoard`, qui ne change pas).
- Discussion de serveur : Suivi coupé, Session perdue, Machine injoignable, en `Bandeau`, en plus des lignes du fil.
- **Tests** : unitaires des deux écrans.
- **Vérification** : `npm run gate`

### 25.11 E2E et fiche de recette

- **Fichiers** : `e2e/coque.spec.ts` (nouveau) : sections de la barre et de l'accueil, bascule « Ranger par mes groupes » aller-retour, pastille vers Réglages, Connecter et Déconnecter avec confirmation, sans swarph et `/swarph`, bloc VPS sur le faux serveur ; `docs/recette-chantier-25-coque.md` (nouveau).
- **Recette de Julien** : sous Node 22 et 24, sur son vrai cockpit. Rien n'est lancé sur le daemon de travail sans son accord.
- **Vérification** : `npm run gate:e2e`, la fiche remplie, citée dans la PR.

## 6. Pièges

- **`test/web/maquette-css.test.ts`** compare l'empreinte de `web/src/styles/maquette.css` au bloc `<style>` des maquettes `design/maquettes/aid-1-*.html`. Les styles nouveaux vont dans `web/src/styles/coque.css`, jamais dans `maquette.css`.
- **`data-node` épinglés** par beaucoup de tests (`barre.*`, `barre-gauche.*`, `rail.*`, `groupe-*`, `table.*`, `aside`). Le mode `groupes` les garde tous ; le mode `etat` en crée de nouveaux sous `barre-gauche.etat.*`.
- **La pastille n'écrit plus** : tout ce qui cliquait dessus pour connecter passe par Réglages.
- **D97** : ne jamais lancer de lecture du board pour la barre. Hors de l'écran, pas d'âge.
- **`EcranId`** : vérifier les `switch` exhaustifs qui en dépendent quand on ajoute `'swarph'`.
- **Insertion seulement** : chaque ligne existante modifiée est annoncée dans le point et comptée dans le commit.
- **Daemon de travail de Julien** : des agents y tournent. Aucun redémarrage ni changement d'installation sans son accord.

## 7. Fini quand

- Les points 25.1 à 25.11 sont commités, un par point, `npm run gate` et `npm run gate:e2e` verts.
- La recette de Julien est faite sous Node 22 et 24, et sa fiche est remplie.
- La PR cite la carte du chantier 25 dans le projet 18, si elle existe ; Julien l'a mergée.
