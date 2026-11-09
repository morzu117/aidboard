# Chantier 35 : les écritures qui parlent, à blanc

| Champ | Valeur |
|---|---|
| État | **Révision 0, 9 novembre 2026.** Julien a lancé le 35 « à blanc », avec le découpage par effet proposé par le lab (DM 93114) : le 35 couvre ce qui parle, le 36 ce qui change un état. Julien a retenu Q1 et Q2 (oui aux deux). Le lab a donné son PASS sur la révision 0 (DM 93207), avec la correction de D255, intégrée. #562 ne reviendra pas en arrière. |
| Emplacement final | `docs/chantiers/35-ecritures-a-blanc.md` sur `main`, dans le premier commit du chantier |
| Base | **d990186** (`origin/main`, PR #134). |
| Organisation | Comme au 37. morzu-vps gère le chantier. Un agent Codex CLI écrit le code et les tests de chaque point, sur un brief tiré de ce plan. morzu-vps relit chaque diff, lance le gate, commite et ouvre la PR. |
| Validation | Le lab valide le 35, parce qu'il fige la forme des écritures swarph (programme §5 bis). Le merge suit la règle de Julien : CI verte, validation du lab et oui de Julien. |

## 1. Pourquoi

Le 24 et le 37 ne font que lire. Julien veut aussi écrire depuis A-I-D, mais l'envoi réel attend le proxy local de #20 : sans lui, le daemon d'A-I-D tiendrait un jeton qui a tous les droits de sa cell (D35). Le lab a mesuré que la forme des actions ne changera pas avec le proxy, seulement le transport (DM 93114). Le 35 construit donc tout, **sauf l'envoi** :
- le catalogue fermé des actions ;
- leur commande exacte ;
- leur texte ;
- la confirmation dans l'UI ;
- un mode « à blanc » qui montre la commande au lieu de l'envoyer.

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| Les lectures du board | `src/daemon/mesh/board.ts` | `BoardReader`, une liste fermée de lectures `--json --as <cell>`. La fiche d'une carte lit `obligations list --card <id>`. |
| Le service mesh | `src/daemon/mesh/service.ts` | `MeshService.read(args, …)` : des lectures seules. **Aucune écriture n'existe**, et c'est voulu (D35). |
| Les DM | `src/daemon/routes/mesh.ts` | `seen` et `decision` (D137) : rien ne part vers le pair. |
| L'écran d'une carte | `web/src/ecrans/CarteBoard.tsx` | La carte, son graphe, son fil et ses obligations. |
| Le nettoyage | chantier 39, D245 | Les motifs de secrets de swarph-cli (`scrub.py`, `redact.py`, MIT), les hôtes et les adresses privées, avec un refus net. Ils sont copiés dans Swairm, en Python. |

Les commandes swarph-cli visées (lues dans 0.72.47) :

| Action | Commande | Remarque |
|---|---|---|
| Note sur une carte | `swarph board cards say <id> --content-file F --kind K [--to P] --as <cell>` | `--to` vaut par défaut l'assigné, sinon l'orchestrateur du projet. Depuis #562, la réponse rappelle les obligations ouvertes du posteur (`open_obligations`) et n'en clôt aucune. |
| DM | `swarph mesh send <pair> --kind K --content-file F [--thread H] --as <cell>` | Un envoi à soi-même est refusé par le gateway. |
| Post de canal | `swarph channel post <canal> --kind K --content-file F --as <cell>` | Il touche tous les membres du canal. La fuite de #1319 venait d'un post de canal. |

`K` est l'un de `status`, `question`, `answer`, `unblock` ou `fyi`.

## 3. Cible et hors-périmètre

**Cible.**
- Trois actions à blanc : la note sur une carte, le DM et le post de canal.
- Pour chacune, une boîte qui contrôle le texte, montre l'aperçu exact et se ferme sur « Rien n'est parti ».

**Hors du 35 :**
- l'envoi réel, qui viendra avec le proxy et sera branché par un point ultérieur ;
- toute obligation (prise ou clôture) et tout déplacement de carte : c'est le 36 ;
- les membres d'un canal, la création d'un canal ou d'un fil ;
- les confirmations par le téléphone du 34 : la classe de chaque action se décidera avec le proxy.

## 4. Décisions

### D251. Le catalogue fermé

`src/shared/ecritures.ts` définit trois actions : `carte.note`, `dm.envoyer` et `canal.poster`. Chacune a un schéma fermé, et toute clé en trop est refusée :
- `carte.note` : `{ carte: entier > 0, kind, texte, a: pair | null }` ;
- `dm.envoyer` : `{ pair, kind, texte, fil: uuid | null }` ;
- `canal.poster` : `{ canal, kind, texte }`.

Les règles communes :
- **Les noms** de pair et de canal suivent `^[a-z0-9][a-z0-9-]{0,62}$`.
- **Le `kind`** est pris dans la liste fermée.
- **Le texte** n'est pas vide, fait au plus 4 000 caractères et ne contient aucun caractère de contrôle autre que le retour à la ligne et la tabulation.
- **Le destinataire** d'un DM n'est jamais la cell elle-même : refus local, avant le gateway.

### D252. La commande exacte

Une fonction pure, `argvEcriture(action, params, cell)`, construit l'argv. C'est toujours un tableau, jamais une chaîne passée à un shell :
- l'option `--as <cell>` est toujours présente ;
- le texte passe **toujours** par `--content-file`, jamais par `--content` (board #458).

À blanc, la place du fichier est le jeton littéral `FICHIER`. L'aperçu montre le texte à part. Un test fige l'argv de chaque action.

### D253. Le résumé

`resumeEcriture(action, params)` donne une phrase d'au plus 160 caractères, construite à partir des seuls `params`, par exemple « Note `fyi` sur la carte #1457, à peer-b ». Elle ne contient jamais le texte du message. L'UI l'affiche en texte React, comme au 34 (D229).

### D254. Le nettoyage

Le texte passe par le nettoyage du 39 (D245), porté en TypeScript dans `src/shared/nettoyage.ts` :
- mêmes motifs ;
- source et commit en commentaire ;
- un test par motif ;
- la liste des hôtes privés reprise de la config d'A-I-D.

Le refus est net : il nomme la classe, sans recopier le texte trouvé. Pour un post de canal, le refus est le même, mais l'UI rappelle en plus le nombre de lecteurs, quand il est connu, ou « tous les membres du canal ».

### D255. Le rappel des obligations ouvertes (lab, DM 93204 et 93207)

Depuis #562, un message ne clôt plus aucune obligation. Le gateway rend seulement, en rappel, les obligations ouvertes du posteur sur le fil (`open_obligations`), et `closed_obligations` reste vide. Clore est un acte distinct, `POST /board/obligations/{id}/close`, qui relève du 36. Le DM et le post de canal ne touchent à aucune obligation (#525).

- **À blanc,** avant l'aperçu d'une `carte.note`, le daemon lit `board obligations list --card <id> --json --as <cell>` avec le lecteur du 24. Si la cell détient une obligation `open`, l'aperçu montre le rappel « Tu as l'obligation #N ouverte sur cette carte. Cette note ne la clôt pas ; la clore passe par le 36. ». **L'action reste permise.**
- **Si cette lecture échoue,** l'aperçu s'affiche quand même, avec la mention « rappel indisponible », sans bloquer.
- **Pour l'envoi réel à venir,** la règle est déjà posée : le rappel est repris de `open_obligations`, et un `closed_obligations` non vide est traité comme **une erreur**, pas comme une information. Un test sur le parseur de la réponse le fige dès le 35.

### D256. La route d'aperçu

`POST /api/swarph/ecrire/apercu`, avec `{ action, params }`. Le serveur :
1. valide le schéma ;
2. applique le nettoyage ;
3. pour `carte.note`, ajoute le rappel de D255 ;
4. rend `{ ok: true, argv, resume, texte, aBlanc: true }`, ou `{ ok: false, kind, message }`.

Les règles de la route :
- elle **n'exécute rien** et ne crée aucun fichier ;
- elle répond 404 si le mesh est désactivé ;
- elle n'est pas réexposée aux appareils du mode host (D178) ;
- un test vérifie qu'aucun appel ne part vers `MeshService` sauf la lecture des obligations, et qu'aucun processus n'est lancé.

### D257. Aucun chemin d'envoi

Le 35 ne contient **aucun** code qui envoie :
- aucune route `…/envoyer` ;
- aucun drapeau ni réglage qui transforme l'aperçu en envoi ;
- aucun appel à `mesh send`, `cards say` ou `channel post` exécuté.

Un test parcourt `src/daemon` et échoue si l'une de ces trois commandes apparaît ailleurs que dans `argvEcriture`. L'envoi réel sera un point à part, relu par le lab, une fois le proxy posé.

### D258. Les points d'entrée dans l'UI

- **La note :** sur `CarteBoard`, un bouton « Écrire une note », dans la zone du fil.
- **Le DM :** dans la Boîte, sur un DM reçu, un bouton « Répondre (à blanc) ». Le pair et le fil sont repris du DM, et le `kind` vaut `answer` par défaut.
- **Le post de canal :** à l'écran Swarph, une boîte « Écrire au mesh », où l'on choisit entre un DM et un canal. On tape le nom du canal (Q1, retenue par Julien).

Le libellé des boutons dit « à blanc » tant que l'envoi n'existe pas.

### D259. La boîte et l'aperçu

La boîte réutilise les éléments du 39 (`DemanderAvis`) : le texte, le `kind`, le destinataire, puis « Voir l'aperçu ». L'aperçu montre :
- le résumé (D253) ;
- la commande, en bloc monospace, avec `FICHIER` à la place du chemin ;
- le texte exact, en bloc, tel qu'il partirait ;
- le bandeau « À blanc : rien n'est parti. L'envoi viendra avec le proxy local (#20). ».

Deux boutons, « Copier la commande » et « Copier le texte », sont présents (Q2, retenue par Julien). La commande copiée garde `FICHIER` : l'aperçu rappelle d'écrire le texte dans un fichier et d'en donner le chemin. Rien n'est copié sans un clic. Sous « Copier la commande », une ligne rappelle : « s'exécute avec tous les droits de ta cellule » (lab, DM 93207). Un refus s'affiche à la place de l'aperçu, avec son message.

## 5. Points

### 35.1 Le plan
Ce fichier, et sa ligne dans `docs/chantiers/README.md`.

### 35.2 Le catalogue, l'argv, le résumé et le nettoyage (D251 à D254)
`src/shared/ecritures.ts` et `src/shared/nettoyage.ts`, avec leurs tests, dont l'argv figé et un test par motif.
_Fait (révision 1)._ `src/shared/ecritures.ts` et `src/shared/nettoyage.ts`, avec 65 tests. Choix de Codex : `a` et `fil` sont obligatoires mais acceptent `null`. Le validateur rend pour l'instant un message unique, « Paramètres d'écriture invalides » : le 35.3 y ajoute un message par champ, dont le DM à soi-même.

### 35.3 La route d'aperçu et la garde des obligations (D255 à D257)
`src/daemon/routes/swarph.ts` ou une nouvelle `ecritures.ts`, le rappel des obligations, le parseur de réponse qui refuse un `closed_obligations` non vide, et le test « aucun chemin d'envoi ». Le faux swarph sert la lecture des obligations depuis les fixtures du 24.
_Fait (révision 1)._ `src/daemon/routes/ecritures.ts`, avec `BoardReader.obligations()`, une lecture sans cache. Un refus métier répond en HTTP 200 avec `ok: false`. Le test D257 exempte `routes/host.ts`, où `'post'` est la méthode HTTP de la rotation de clé du PDA.

### 35.4 L'UI (D258, D259)
- la boîte `EcrireAuMesh` ;
- les boutons dans `CarteBoard`, dans la Boîte et à l'écran Swarph ;
- `web/src/data/ecritures.ts` ;
- les tests web.

### 35.5 L'e2e et la fiche de recette
- **`e2e/ecritures-a-blanc.spec.ts`** couvre :
  - l'aperçu de chaque action ;
  - un refus de nettoyage ;
  - le rappel d'une obligation ouverte sur une note ;
  - la preuve qu'aucun processus d'écriture n'est lancé : le faux swarph journalise chaque appel.
- **`docs/recette-chantier-35-a-blanc.md`.**

## 6. Pièges

- **Une lecture de swarph-cli antérieure à #562** fait croire qu'une note clôt une obligation. Le gateway ne le fait plus (lab, DM 93204). Si `closed_obligations` revenait non vide, c'est une erreur.
- Ne jamais passer le texte par `--content` : un shell, ou un argv mal cité, pourrait l'altérer (board #458).
- Un aperçu ne doit jamais être mis en cache ni journalisé avec son texte.
- Le mode host ne réexpose pas la route.

## 7. Questions

- ~~Q1~~ : oui (Julien). Le post de canal se fait dans la boîte « Écrire au mesh », en tapant le nom du canal.
- ~~Q2~~ : oui (Julien). L'aperçu a les boutons « Copier la commande » et « Copier le texte ».
- ~~Q3~~ : tranchée par le lab (DM 93204). Pas de refus, un rappel, et `closed_obligations` non vide est une erreur.

## 8. Fini quand

- Les trois actions donnent un aperçu exact, et chaque refus a son message.
- Le test « aucun chemin d'envoi » passe.
- Le gate et l'e2e sont verts.
- Le lab a donné son PASS.
- La fiche de recette existe.
