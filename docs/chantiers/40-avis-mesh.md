# Chantier 40 : poser une question à N cells du mesh (`swairm ask` réparti)

| Champ | Valeur |
|---|---|
| État | **Spec et plan, révision 2, 12 novembre 2026. Spec validée par Julien ; C1 tranché, validé par Julien.** Écrite contre `swarph committee` de swarph-cli 0.75.0, comme le lab l'a demandé (DM 93080, point 6). Reprend la spec révision 0 (9 novembre), les réponses du lab C2, C3 et C5 (DM 93087 et 93255), et le PASS du lab sur le charter, sous quatre corrections, intégrées en D297 (DM 93110). Révision 1 : réponses du lab à C6, C7 et C8 (DM 96738). Révision 2 : la réponse du commander à C1, relayée par le lab (DM 96740) et validée par Julien : la cell d'A-I-D préside, la cell du lab siège en baseline. La variante B est retirée. Le lab relit la spec : le 40 touche au contrat swarph. |
| Emplacement final | `docs/chantiers/40-avis-mesh.md` sur `main` |
| Base | `main` (c6d3332, v0.7.2) |
| Organisation | Comme au 42. morzu-vps gère le chantier. Codex CLI écrit le code et les tests de chaque point. morzu-vps relit, lance le gate, commite et ouvre la PR. |
| Validation | Le lab valide le chantier, comme pair distinct du constructeur, parce qu'il touche au mesh. Julien fait la recette. Merge : CI verte, validation du lab, puis oui de Julien. |
| Bloqué par | Plus rien pour le CLI : A-I-D préside en direct avec swarph-cli 0.73.0 ou plus. Le passage par le proxy, lectures et écritures, attend la carte #1581, après la phase proxy de #20. C9 (les familles, §8) est à confirmer par le lab avant la recette. |

## 1. Pourquoi

Le 39 donne un deuxième avis : la même question part à N agents Claude indépendants sur le Mac, et A-I-D montre, sous-question par sous-question, où ils s'accordent. Le 40 pose la question à N **cells du mesh**. Chaque cell répond avec son propre agent, ses outils et son abonnement, et A-I-D rassemble les réponses dans le même tableau. C'est la phase 5 du programme (blocs 9 et 10) : le mesh devient une force d'avis.

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| Le 39 dans A-I-D | `src/daemon/swairm/ask.ts:54` (`SwairmAsk`), `src/daemon/routes/swairm.ts:58-78`, `src/shared/swairm-ask.ts:98` (`parseAsk`) | Le lancement de `swairm ask`, les routes `/api/swairm/ask*` et la lecture de `swairm-ask/1`. Le découpage en sous-questions et le calcul de l'accord (D247) sont **dans swairm**, en Python, et pas dans A-I-D. |
| L'UI du 39 | `web/src/ui/DemanderAvis.tsx:14`, `web/src/ui/DemandesAvis.tsx:10`, `web/src/ecrans/TableauAvis.tsx:14` | La boîte « Demander N avis », la liste des demandes et le tableau d'accord. |
| Le nettoyage | `src/shared/nettoyage.ts:227` (`nettoyer`) | Les motifs de secrets de swarph-cli, plus les hôtes et adresses du tailnet. Il sert aux écritures du 35. |
| Les écritures | `src/shared/ecritures.ts:157` (`argsProxy`), `src/daemon/confirmations/porte.ts:61` (`creerPorte`) | Les écritures du mesh passent par la porte des confirmations (`mesh.ecrire`, toujours confirmé) et par le proxy. |
| Le proxy, côté A-I-D | `src/daemon/mesh/proxy.ts:11-31` | `VERBES_PROXY` (7 écritures) et `VERBES_LECTURE` (10 lectures). **Aucun verbe `committee`.** |
| Le proxy, côté swarph-cli 0.75.0 | `proxy_routes.py:72-98` | La liste fermée des verbes relayés : board, mesh, canal et mémoire. **Aucun verbe `committee`** (C6). |
| `swarph committee` 0.75.0 | `commands/committee.py` | `rooms open --name --charter-file --card-id --seats-file [--json]` (chair) ; `motion <canal> [--open --text --options --positions-deadline --rebuttal-deadline --vote-deadline] [--json]` ; `post <canal> --round positions\|rebuttal\|vote --body-file [--outcome pass\|cannot_evaluate] [--json]` ; `results <canal> [--motion ID] --json` ; `recast` et `baseline-absent` (chair). Les sièges sont un JSON `[{"peer", "role", "family"}]`. `--options` demande au moins deux valeurs. |
| Le gateway | lab, DM 93087 et 93255 | `results` rend la motion, les sièges et les bulletins. Le corps et l'outcome d'un bulletin ne sortent que si le scellé l'autorise (côté serveur). Le gateway ne liste que les motions ouvertes : une motion close ne se relit que par son id. |

## 3. Cible et hors-périmètre

**Cible.**
- Dans la boîte du 39, un choix « au Mac » (le 39) ou « au mesh » (le 40). Au mesh, on choisit les cells, la carte liée et les échéances.
- A-I-D ouvre une salle et une motion par question, comme chair. La cell du lab y siège en baseline (C1).
- A-I-D lit les résultats, calcule l'accord comme au 39, et les montre dans le même tableau, avec une colonne par cell.
- Les demandes au mesh se rouvrent en lecture, comme celles du 39.

**Hors-périmètre.**
- Le tour `rebuttal` compté : il s'affiche en texte seul.
- `recast` : il reste au chair, à la main. `baseline-absent` entre dans le périmètre (D295).
- Une réponse de Codex dans une cell : chaque cell répond avec l'agent de son propriétaire, A-I-D n'en choisit aucun.
- Plusieurs motions ouvertes à la fois dans une salle (C3 : une motion par question).
- Toute écriture sur un board en dehors de la salle.

## 4. Décisions

### D294. Une salle « avis » par demande, une motion par question

- **La salle.** Une demande au mesh ouvre une salle, liée à une carte (`--card-id`). Son nom est `avis-<id>`, où `<id>` est l'id de la demande, au format du 39 (`ID_ASK`).
- **Les sièges**, une liste fermée, chacun avec sa famille de modèle (D303) :
  - la cell d'A-I-D, `role: "chair"` : le gateway veut que le chair soit la cell qui ouvre la salle, sinon il répond 403 ;
  - la cell du lab, `role: "baseline"` (D295) ;
  - les cells choisies, `role: "seat"`, de 2 à 8.
  Le gateway exige exactement un chair, un baseline et au moins un siège qui vote (DM 96740).
- **La motion.** Une seule motion par demande (C3), quel que soit le nombre de sous-questions. Le texte de la motion est la question citée (D297). Les `--options` valent `avis,objection` (C7, DM 96738) : le gateway en exige deux distinctes, et le vrai verdict est dans le corps du bulletin. **L'abstention passe uniquement par `--outcome cannot_evaluate`**, jamais par une option : le charter le dit.
- **Les échéances.** Le tour `positions` est obligatoire : 24 h par défaut, entre 1 h et 7 jours. Les tours `rebuttal` et `vote` sont facultatifs, désactivés par défaut.
- **L'id de la motion** rendu par `motion --open --json` est gardé dans la base d'A-I-D, car le gateway ne liste plus une motion close (DM 93255).

### D295. A-I-D préside, le lab siège en baseline (C1, tranché)

- **C1.** Le commander a répondu (DM 96740, relayé par le lab) : la cell d'A-I-D peut présider une salle, avec la cell du lab en baseline. Julien a validé. La variante B (le lab préside) est retirée, avec l'option `mesh.avis.chair` et la route d'enregistrement de la motion.
- **Les écritures.** A-I-D lance `rooms open`, puis `motion --open`, et lit les résultats. Les deux écritures forment une seule action confirmée (D296).
- **La cell du baseline** se règle par `mesh.avis.baseline`, sans valeur par défaut dans le dépôt. Sans elle, la boîte au mesh dit « baseline non configuré » et n'envoie rien.
- **Le baseline bloque le tour positions.** Le gateway garde le tour `positions` ouvert tant que le baseline n'a pas posté, sauf si le chair le déclare absent. A-I-D ajoute donc l'action « Déclarer le baseline absent » (`swarph committee baseline-absent`), toujours confirmée, disponible seulement pendant le tour `positions` et après son échéance.
- **Le bulletin du baseline** s'affiche dans sa propre colonne, marquée « baseline », avec les mêmes états. **Il ne compte pas dans l'accord**, qui porte sur les seules cells choisies.

### D296. Les verbes et leur passage

- **Lectures** : la motion ouverte d'un canal (`swarph committee motion --json`, verbe proxy `committee.motions.list`) et une motion par son id (`swarph committee results --motion ID --json`, verbe proxy `committee.motion.get`). Elles ne consomment rien (invariant 4).
- **Écritures** : `committee.rooms.open` et `committee.motion.open` forment l'action `mesh.avis`, et `committee.baseline-absent` l'action `mesh.avis.baseline-absent`. Les deux passent par la porte des confirmations et sont toujours confirmées.
  - L'aperçu de `mesh.avis` montre la salle, les sièges avec leur rôle et leur famille, la carte, les échéances et le texte exact de la motion.
  - Si `rooms open` réussit et que `motion --open` échoue, la demande passe à l'état `salle-sans-motion`, avec le canal gardé. Rien n'est relancé tout seul.
- **Le transport.** Les deux formes du 44 :
  - par le CLI, si la cell a encore son jeton (avant la bascule du 44) : swarph-cli 0.73.0 ou plus suffit (DM 96740) ;
  - par le proxy, quand la carte #1581 y aura ajouté les verbes `committee`. #1581 couvre les lectures, `rooms.open` et `motion.open` ; elle dépend de la phase proxy de #20, sans date. `baseline-absent` n'y figure pas encore.
  Tant qu'un verbe n'est pas relayé, le transport proxy rend « non relayé par le proxy » et ne tente rien d'autre. Il n'y a jamais de repli automatique du proxy vers le CLI.

### D297. Le charter « avis » et la question citée (lab, DM 93110)

Le charter est un texte fixe, versionné dans `src/shared/charter-avis.ts`. Seuls le jeton de citation, la carte et le nombre de sous-questions y sont remplacés. Il reprend le brouillon 0 relu par le lab, avec ses quatre corrections :

1. **La citation par jeton.** La question est citée entre `<<<QUESTION-<jeton>` et `QUESTION-<jeton>>>>`, où `<jeton>` est tiré au hasard à chaque salle (8 caractères hexadécimaux) et écrit dans le charter. A-I-D refuse aussi, avant l'envoi, une question qui contient `<<<QUESTION` ou `QUESTION>>>`. Les deux défenses sont nécessaires.
2. **Les seules commandes permises** : `swarph committee motion <canal>`, pour lire, et `swarph committee post`, pour déposer, dans cette salle. Rien d'autre : ni board, ni DM, ni canal, ni fichier, ni autre commande.
3. **Le canal.** « Ne publie ta position nulle part ailleurs que par `post`, ni dans un canal ni dans un DM, avant la clôture du tour. »
4. **Le secret repéré.** « Abstiens-toi avec `--outcome cannot_evaluate` et un corps qui dit seulement "secret suspecté", sans le recopier. »

Le reste du brouillon tient : l'objet de la salle, le format JSON du bulletin, la phrase sur le scellé, l'abstention visible et le coût consenti à l'ouverture.

### D298. Le nettoyage avant envoi

- Le nettoyage du 35 (`nettoyer`) s'applique à la question, avec les mêmes refus nets : le message nomme la classe et ne recopie jamais le texte trouvé.
- S'y ajoutent les marqueurs de citation (D297, point 1), et une longueur maximale de 8 000 caractères.
- Le rappel de la boîte dit : « Le texte part dans le mesh, vers les cells choisies et le gateway. N'y mets ni secret, ni contenu de carte, ni nom de client. »

### D299. Le bulletin et l'accord

- **Le corps du bulletin** du tour `positions` est le JSON fermé du 39 : `{"reponses": [{"n": 1, "verdict": "oui|non|nuance|ne_sait_pas", "justification": "…"}]}`.
- **La lecture**, dans une fonction pure (`src/shared/avis-mesh.ts`), portée de D247 avec la source citée :
  - le premier objet JSON du corps est lu ;
  - un verdict hors de la liste fermée, un `n` en double ou un `n` hors des sous-questions donnent un bulletin `invalide`, gardé et affiché, non compté ;
  - une sous-question sans réponse donne `manquant` pour cette case ;
  - la justification est coupée à 600 caractères ;
  - `cannot_evaluate` donne une abstention visible ; « secret suspecté » s'affiche comme tel ;
  - un siège sans bulletin à l'échéance est `absent`.
- **L'accord** se calcule comme au 39 (`unanime`, `majorite`, `partage`, `insuffisant`), sur les seuls verdicts valides du tour `positions`. Si le tour `vote` est ouvert, il remplace les verdicts de `positions` des sièges qui ont voté, et le tableau le dit.
- **Le découpage en sous-questions** est porté aussi : lignes `N.` ou `N)`, 12 au plus, le texte entier sinon.
- Le résultat garde la forme de `swairm-ask/1`, avec une colonne par cell (`avis[].cell`), pour réutiliser `TableauAvis`. Son champ `format` vaut `aid-avis-mesh/1`, pour ne pas le confondre avec une sortie de swairm.

### D300. Le scellé, dit tel qu'il est

- Le scellé, côté serveur (`_visible`, DM 96738) : un bulletin `positions` devient visible aux autres à partir de la phase `rebuttal`, un bulletin `vote` à la phase `closed`. Tant qu'un bulletin n'est pas visible, sa case montre « scellé par le gateway », sans contenu. Jamais « invisible » ni « secret » : le scellé n'est pas étanche (#1319, #1326).
- La boîte affiche la phase et les échéances en tête du tableau, et un bouton « Relire » qui relance `committee.results`. Il n'y a ni sondage périodique, ni relance des sièges.

### D301. Les routes et la base

- **Les routes**, locales et jamais réexposées en mode host :
  - `POST /api/avis-mesh` `{question, cells, carte, echeances}` : nettoyage, contrôle des familles (D303), puis demande de confirmation de l'action `mesh.avis`. Il exige `X-AID-Confirm: avis`, comme au 39 ;
  - `GET /api/avis-mesh` : les 20 dernières demandes ;
  - `GET /api/avis-mesh/:id` : relit les résultats de la motion et rend `aid-avis-mesh/1`, avec la phase, les échéances et la colonne du baseline ;
  - `POST /api/avis-mesh/:id/baseline-absent` : demande de confirmation de l'action `mesh.avis.baseline-absent`. Il exige `X-AID-Confirm: avis`.
- **La base** : une table `avis_mesh` (migration à numéroter au moment du point), avec `id`, `question`, les sièges (cell, rôle, famille), la carte, le canal, l'id de la motion, le jeton de citation, la date et l'état. Elle ne garde aucun corps de bulletin : ils sont relus au gateway à chaque ouverture.

### D302. La boîte et le tableau

- La boîte du 39 gagne une bascule « Au Mac » / « Au mesh », visible seulement si la cell est connectée.
- Au mesh :
  - les cells se cochent dans la liste de `mesh.peers` (2 au moins, 8 au plus), sans la cell d'A-I-D ni celle du baseline ;
  - chaque cell affiche sa famille (D303). Une cell sans famille ne se coche pas, et la boîte dit pourquoi ; deux familles identiques bloquent l'envoi ;
  - la carte liée se choisit par son numéro, et la boîte affiche son titre pour vérifier ;
  - l'échéance du tour `positions`, et les tours facultatifs.
- Le tableau est celui du 39, avec le nom de la cell en tête de colonne, la phase et les échéances en tête, les pastilles « scellé », « absent », « abstention » et « invalide », et tout en texte React.
- La colonne du baseline, marquée « baseline », vient après celles des cells, hors de l'accord. Pendant le tour `positions`, après son échéance, un bouton « Déclarer le baseline absent » lance l'action confirmée.

### D303. Les familles de modèle

- Le gateway exige que chaque siège, observateurs compris, déclare une famille de modèle différente. La famille est déclarée dans le fichier des sièges et n'est pas vérifiée : elle doit être honnête (DM 96740).
- A-I-D lit les familles dans la config, `mesh.avis.familles`, une table de la cell vers sa famille, remplie une fois par Julien. Elle couvre la cell d'A-I-D, celle du baseline et les cells qui peuvent siéger. A-I-D ne devine jamais une famille.
- Avant l'envoi, A-I-D refuse une demande où un siège n'a pas de famille, ou où deux sièges, chair et baseline compris, déclarent la même. Le refus nomme les cells en cause.

## 5. Points

### 40.1 Le cœur pur (D297, D298, D299)

`src/shared/charter-avis.ts` (le charter, le jeton, le refus des marqueurs) et `src/shared/avis-mesh.ts` (le découpage, la lecture des bulletins, l'accord, la forme `aid-avis-mesh/1`). Tests unitaires sur chaque cas de D299, sur le jeton et sur une question qui contient un marqueur. Ne dépend ni de C1 ni de C6.
- 40.1 : `src/shared/charter-avis.ts` et `src/shared/avis-mesh.ts`, 41 tests. Ajout de l'état `attendu` (un siège qui n'a encore rien déposé) et du drapeau `vote_scelle`. `BulletinAvis` est défini aussi dans `src/shared/committee.ts` (40.2) : les deux définitions sont fusionnées au 40.3.

### 40.2 La lecture des résultats (D296, D300)

Le lecteur `committee.motion` et `committee.results` par le CLI (`--json`, argv en tableau, jamais de shell), avec la lecture défensive de la réponse du gateway. Côté proxy, les deux verbes sont déclarés mais rendent « non relayé par le proxy » tant que C6 n'est pas tranché. Tests avec un faux `swarph` qui rend des résultats scellés, ouverts, avec abstention, absent et invalide.
- 40.2 : lecteur `CommitteeReader` (`src/daemon/mesh/committee.ts`), parseur `src/shared/committee.ts`, 9 tests. La forme exacte de la réponse du gateway et le type de l'id de motion restent à vérifier à la recette.

### 40.3 L'envoi, la salle et le baseline (D294, D295, D296, D301, D303)

L'action `mesh.avis` (`rooms open` puis `motion --open`) dans la porte des confirmations, avec son aperçu, et l'action `mesh.avis.baseline-absent`. Les configs `mesh.avis.baseline` et `mesh.avis.familles`, et leur contrôle. La table `avis_mesh` et les quatre routes, au contrat déjà écrit par le client du 40.4. La fusion des deux définitions de `BulletinAvis`. Par le CLI ; par le proxy, « non relayé » tant que #1581 n'existe pas.

### 40.4 La boîte et le tableau (D302)

La bascule, le choix des cells, de la carte et des échéances, le tableau par cell, et la liste des demandes. Les tests web de chaque état.
- 40.4 : client `web/src/data/avis-mesh.ts` (contrat de D301, à implémenter tel quel par le 40.3), `FormulaireAvisMesh`, `TableauAvisMesh` et la liste sœur `DemandesAvisMesh`. 3 lignes de la boîte et de la liste du 39 remplacées pour y brancher la bascule. 9 tests web ; les 1 105 tests web passent.

**Reprise de la révision 2.** La famille de chaque cell dans la boîte, et ses deux refus. La cell du baseline retirée de la liste. La colonne « baseline » hors de l'accord, et le bouton « Déclarer le baseline absent ». Le client gagne la route `baseline-absent`.

### 40.5 L'e2e et la fiche de recette

Un e2e avec un faux `swarph`. La fiche `docs/recette-chantier-40-avis-mesh.md` : une vraie salle avec deux cells et le baseline, le scellé, une abstention, un absent, le baseline déclaré absent, l'accord, puis la relecture après la clôture.

## 6. Pièges

- **La question est une donnée.** Les sièges ont des outils, contrairement aux avis du 39. Le charter et la citation par jeton sont la défense ; un test vérifie que le charter envoyé contient bien le jeton de la salle.
- **Ne jamais promettre l'invisibilité** du scellé (#1319, #1326).
- **L'id de la motion se perd** si A-I-D ne le garde pas : le gateway ne liste pas les motions closes.
- **`--as` explicite** à chaque appel de `swarph committee` : sinon le CLI retombe sur `$SWARPH_SELF`.
- **Aucun repli du proxy vers le CLI** : un verbe non relayé est une réponse, pas une panne à contourner.
- **Le fan-out pendant le scellé n'est pas vérifié** (DM 96738) : un membre non-siège reçoit-il le texte d'un bulletin pendant que le tour est scellé (la fuite de #1326) ? La recette le teste avant d'y compter.
- **Le baseline bloque le tour.** Sans son bulletin, le tour `positions` ne se ferme pas, même après l'échéance : seul le chair le débloque, par `baseline-absent`.
- **Les familles sont déclarées, pas vérifiées.** Une famille fausse trompe le gateway ; A-I-D ne la devine jamais.
- **Le coût est chez les autres.** Chaque siège dépense le quota de son propriétaire, qui consent à l'ouverture de la salle. Rien ne relance un siège.

## 7. Fini quand

- Une demande au mesh ouvre une salle et une motion, sous confirmation, avec le baseline.
- Le tableau montre l'accord par cell, avec le scellé, l'abstention, l'absent et l'invalide.
- La recette réelle passe avec deux cells, et le lab valide le chantier.
- Le gate est vert, sous Node 22 et 24.

## 8. Questions ouvertes

- **C9, pour le lab** : les familles. Le gateway attend-il des valeurs dans une liste fermée, et à quelle finesse (un fournisseur, ou un modèle) ? Deux cells servies par le même fournisseur peuvent-elles siéger ensemble ? Le baseline suit-il le même charter et le même format de bulletin ?
- **C4, pour Julien** : les sièges et les échéances de la première recette.

**Réponse du commander (DM 96740), intégrée :**
- **C1** : la cell d'A-I-D préside, la cell du lab siège en baseline. Julien a validé : D295.

**Réponses du lab (DM 96738), intégrées :**
- **C6** : le proxy ne relaie aucun verbe `committee`. La carte #1581 ajoutera `committee.motion.get` et `committee.motions.list` en lecture, et les écritures seulement si C1 est oui. Elle dépend de la phase proxy de #20 : D296.
- **C7** : `--options avis,objection`, et l'abstention par l'outcome seulement : D294.
- **C8** : un membre du canal sans siège suffit pour lire ; le scellé est appliqué par phase : D295 et D300. Le fan-out pendant le scellé reste à tester (§6).
