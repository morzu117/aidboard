# Formats

Deux formats, tous deux relus par `scripts/valider-fiche.mjs`. Les respecter à la lettre : un
champ mal nommé est une erreur de validation, pas une variante.

## 1. Fiche de référence — `design/references/<ecran>.json`

Une fiche par écran (ou par dialogue, volet, composant autonome). `<ecran>` est le préfixe des
`data-node`.

```json
{
  "version": 1,
  "ecran": "creer-carte",
  "titre": "Créer la carte d'un sujet Swairm",
  "chantier": "41b",
  "source": {
    "type": "brief",
    "fichiers": ["docs/chantiers/41b-creer-carte.md"],
    "releve": "2026-11-16",
    "note": "Aucune maquette : écran décrit par D341."
  },
  "tokens": "design/aid-vps/tokens.json",
  "tailles": { "phone": 390, "desktop": 1440 },
  "etats": {
    "default": {
      "mise_en_place": "Un sujet Swairm sans carte, proxy en écriture, deux projets lus."
    },
    "loading": {
      "mise_en_place": "Liste des projets en cours de lecture.",
      "provenance": "a-confirmer"
    },
    "error": { "mise_en_place": "Le board refuse la création (403)." },
    "sans-proxy": { "mise_en_place": "mesh.proxySocket non réglé." }
  },
  "noeuds": [
    { "id": "creer-carte", "role": "racine de l'écran", "provenance": "specifie" },
    {
      "id": "creer-carte.projet",
      "role": "liste de choix du projet",
      "provenance": "specifie",
      "decision": "D341",
      "action": "carte.creer.choisir-projet",
      "etats": ["default", "error"]
    },
    {
      "id": "creer-carte.projet.option-{id}",
      "role": "un projet du board",
      "provenance": "illustratif",
      "bind": "projet.nom"
    },
    {
      "id": "creer-carte.envoyer",
      "role": "bouton Envoyer",
      "provenance": "specifie",
      "action": "carte.creer.envoyer",
      "desactive_dans": ["sans-proxy"],
      "styles": {
        "background-color": { "valeur": "token:color.accent", "provenance": "a-confirmer" },
        "border-radius": { "valeur": "8px", "provenance": "a-confirmer" }
      }
    },
    {
      "id": "creer-carte.erreur",
      "role": "message d'erreur",
      "provenance": "specifie",
      "etats": ["error"],
      "texte": "Le board a refusé cette création (403) : ta cell n'a pas le droit d'écrire dans ce projet."
    }
  ]
}
```

### Champs

| Champ                      | Obligatoire | Règle                                                                                                                                                                                                                                                                       |
| -------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                  | oui         | `1`.                                                                                                                                                                                                                                                                        |
| `ecran`                    | oui         | Minuscules, chiffres, tirets. Préfixe de tous les `id`.                                                                                                                                                                                                                     |
| `titre`                    | oui         | Nom lisible.                                                                                                                                                                                                                                                                |
| `chantier`                 | oui         | Numéro du chantier qui crée ou modifie la fiche.                                                                                                                                                                                                                            |
| `source.type`              | oui         | La source principale : `maquette-convention`, `export-dc`, `captures`, `brief`, `application`, `aucune`.                                                                                                                                                                    |
| `source.aussi`             | non         | Les autres sources consultées, mêmes valeurs. Cas courant : `"type": "brief", "aussi": ["application"]` pour un écran décrit en prose et déjà livré.                                                                                                                        |
| `source.fichiers`          | oui         | Chemins lus, toutes sources confondues. Vide seulement si `type` vaut `aucune`.                                                                                                                                                                                             |
| `source.releve`            | oui         | Date du relevé, `AAAA-MM-JJ`.                                                                                                                                                                                                                                               |
| `tokens`                   | non         | Fichier de tokens du design, auquel renvoient les `token:…`.                                                                                                                                                                                                                |
| `variables_css`            | non         | Feuille de style de l'application, à laquelle renvoient les `var:…` (`web/src/styles/maquette.css`).                                                                                                                                                                        |
| `inclut`                   | non         | Noms d'autres fiches dont l'écran embarque le composant (`["host"]`). Voir « Plusieurs préfixes ».                                                                                                                                                                          |
| `tailles`                  | oui         | Nom → largeur en px. Noms admis : `phone` 390, `tablet` 834, `desktop` 1440, `wide` 1920. Ne déclare que les tailles couvertes par la source ou le plan. Si rien n'en cite aucune, déclare `desktop` seul.                                                                  |
| `etats`                    | oui         | Nom → `mise_en_place` (comment un test met l'écran dans cet état). `default` est obligatoire. Les quatre états de la convention sont `default`, `empty`, `loading`, `error` ; un écran peut en avoir d'autres, nommés d'après la situation (`sans-proxy`, `lecture-seule`). |
| `etats.<nom>.tailles`      | non         | Tailles où l'état existe, quand il n'existe pas partout (un tiroir de navigation ouvert, sous 1280 px seulement).                                                                                                                                                           |
| `noeuds[].id`              | oui         | Unique. Commence par `ecran` suivi d'un point (ou lui est égal). `{…}` marque un indice ou un identifiant variable, quel qu'il soit : `sujet-{id}` vaut aussi pour une clé comme `owner/depot#7`.                                                                           |
| `noeuds[].role`            | oui         | Ce que c'est, en quelques mots.                                                                                                                                                                                                                                             |
| `noeuds[].provenance`      | oui         | `specifie`, `existant`, `illustratif`, `a-confirmer`. Dit d'où vient **l'élément**.                                                                                                                                                                                         |
| `noeuds[].nom_dans_app`    | non         | `false` quand l'élément existe ou est spécifié mais que l'application ne pose pas encore ce `data-node`. Dit d'où vient **le nom**. Le validateur liste ces nœuds : c'est du travail pour le dev.                                                                           |
| `noeuds[].decision`        | non         | Identifiant de décision du plan (`D341`).                                                                                                                                                                                                                                   |
| `noeuds[].etats`           | non         | États où le nœud est présent. Absent : présent partout.                                                                                                                                                                                                                     |
| `noeuds[].masque`          | non         | Tailles où le nœud est dans le DOM mais masqué.                                                                                                                                                                                                                             |
| `noeuds[].desactive_dans`  | non         | États où l'élément interactif est désactivé.                                                                                                                                                                                                                                |
| `noeuds[].action` / `bind` | non         | `data-action` / `data-bind` attendus.                                                                                                                                                                                                                                       |
| `noeuds[].texte`           | non         | Texte exact attendu : une chaîne, ou un objet état → chaîne quand le même nœud porte un message différent selon l'état. À réserver aux libellés et messages spécifiés.                                                                                                      |
| `noeuds[].styles`          | non         | Propriété CSS → valeur, ou → `{ "valeur", "provenance" }`. Voir « Valeurs de style ».                                                                                                                                                                                       |
| `noeuds[].styles_par_etat` | non         | État → même objet que `styles`, pour ce qui change avec l'état (la couleur d'une pastille).                                                                                                                                                                                 |

Un état, un nœud ou un style sans `provenance` propre hérite de celle de son parent ; un état sans
`provenance` est `specifie`.

Aucun nœud racine n'est exigé : si l'application n'en pose pas (`machines.page` est la racine
rendue, pas `machines`), n'en invente pas.

### Plusieurs préfixes

Une fiche ne porte qu'un préfixe. Quand un écran embarque un composant qui a le sien — le cockpit
`host.*` dans la page Machines — ce composant a **sa propre fiche**, et la fiche de l'écran le
cite dans `inclut`. Le vérificateur sait alors que des nœuds `host.*` dans la page ne sont pas
« en trop ».

Un composant partagé qui reçoit son préfixe de l'écran (`{screen}.barre.…`) n'est pas dans ce cas :
ses nœuds portent le préfixe de l'écran et vont dans la fiche de l'écran.

Quand le chantier n'ajoute qu'une zone à un écran existant, la zone va dans la fiche de cet écran,
sous son préfixe (`board.sans-carte.…`). Si cette fiche n'existe pas encore, crée-la partielle et
dis-le dans `source.note` (« fiche partielle : seule la zone sans-carte est décrite ») — une fiche
partielle sous le bon préfixe vaut mieux qu'une fiche complète sous un préfixe inventé.

### Valeurs de style

Trois formes, par ordre de préférence :

1. `var:--nom` — une variable CSS de l'application (`var:--acc`). À utiliser pour tout écran déjà
   livré ou construit avec les styles du dépôt : c'est ce que l'application calcule réellement.
2. `token:chemin` — un token du design (`token:color.accent`). À utiliser pour une fiche tirée
   d'un export de design.
3. Une valeur littérale (`"14px"`, `"#62D699"`), telle que la source l'écrit.

Les tokens du design et les variables de l'application **ne portent pas les mêmes valeurs
aujourd'hui** (l'accent vaut `#5de0a1` dans `design/aid-vps/tokens.json` et autre chose dans
`maquette.css`). Ne choisis pas en silence : une fiche tirée d'un design garde `token:`, et tu
signales dans ton compte rendu chaque token dont la valeur diffère de la variable correspondante
de l'application. C'est un écart à trancher par l'humain, pas à lisser dans la fiche.

Écris la valeur telle qu'elle est déclarée (hex, px). Le vérificateur se charge de la comparer à
la valeur calculée (`rgb(…)`) ; n'essaie pas de la convertir. Une valeur lue dans le CSS sans
avoir lancé l'application reste `a-confirmer` si la cascade peut la changer.

### Quels styles relever

Peu, et seulement ceux qu'un œil remarque et qu'une valeur fixe : taille et graisse de police,
couleur du texte et du fond, rayon, hauteur d'une barre fixe, largeur d'une colonne fixe. Pas les
marges de mise en page ni ce qui dépend du contenu : chaque valeur relevée est un test qui peut
casser, et une fiche qui casse à chaque retouche finit ignorée.

Préfère toujours `token:…` à une valeur littérale quand le token existe : le test suit alors le
token, et un changement de palette ne casse pas quarante fiches.

## 2. Contrat d'acceptation — section du plan

Ajoutée à la fin de `docs/chantiers/<n>-<slug>.md`. Le titre et les colonnes sont fixes.

```markdown
## Contrat d'acceptation

Établi le 2026-11-16 depuis la révision 3 du plan. Fiches : `design/references/creer-carte.json`.

| ID      | Point | Critère                                                                                       | Niveau     | Nœuds                                       | Cadre                 | Test                                       |
| ------- | ----- | --------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------- | --------------------- | ------------------------------------------ |
| 41b-C01 | 41b.2 | `preparer` refuse en 400 un titre vide après retrait des espaces (D338).                      | unitaire   | —                                           | —                     | `test/creation-carte.test.ts`              |
| 41b-C02 | 41b.2 | `preparer` accepte un titre de 200 caractères et refuse 201 (D338).                           | unitaire   | —                                           | —                     | `test/creation-carte.test.ts`              |
| 41b-C07 | 41b.3 | Sans proxy, « Envoyer » est désactivé et les deux boutons « Copier » restent (D341).          | web        | `creer-carte.envoyer`                       | sans-proxy · desktop  | `test/web/creation-carte.test.tsx`         |
| 41b-C09 | 41b.3 | Un refus 403 affiche le message exact de D339.                                                | web        | `creer-carte.erreur`                        | error · desktop       | `test/web/creation-carte.test.tsx`         |
| 41b-C12 | 41b.4 | Parcours complet : choix du projet, aperçu, confirmation, un seul `board.cards.create`.       | e2e        | `creer-carte.projet`, `creer-carte.envoyer` | default · desktop     | `e2e/creer-carte.spec.ts`                  |
| 41b-C14 | 41b.3 | Structure de l'écran conforme à la fiche dans chaque état.                                    | conformite | `creer-carte`                               | tous · phone, desktop | `design/references/creer-carte.json`       |
| 41b-C15 | 41b.5 | La carte créée apparaît sur le vrai board. Non automatisable : exige un proxy réel en 0.82.0. | recette    | —                                           | —                     | `docs/recette-chantier-41b-creer-carte.md` |

### À confirmer avant le dev

- L'état `loading` n'est décrit nulle part : faut-il un squelette pendant la lecture des projets ?

### Points sans critère

- 41b.1 (le plan) : point documentaire, rien à vérifier.
```

### Règles

- **ID** : `<chantier>-C<nn>`, stable. Un critère retiré garde sa ligne, avec `retiré (révision N)`
  en tête de la colonne Critère.
- **Point** : un identifiant de point du plan, tel qu'il apparaît dans son titre `###` ou dans sa
  puce en gras (`**S.4 — …**`), selon la forme du plan.
- **Niveau** : `unitaire`, `web`, `e2e`, `conformite`, `recette`.
- **Nœuds** : identifiants entre accents graves, séparés par des virgules, ou `—`. Chacun existe
  dans une des fiches passées au validateur.
- **Cadre** : `état[, état] · taille[, taille]`, ou `tous · …`, ou `… · toutes`, ou `—` hors UI.
  Les états et les tailles cités existent dans la fiche des nœuds cités : le validateur le vérifie.
- **Test** : un chemin entre accents graves, cohérent avec le niveau (`test/` pour `unitaire`,
  `test/web/` pour `web`, `e2e/` pour `e2e`, `design/references/` pour `conformite`,
  `docs/recette` pour `recette`). Le fichier peut ne pas exister encore : c'est le testeur qui le
  crée. Sur un chantier déjà livré, fais suivre le chemin de `(couvert)` quand un test existant
  vérifie déjà le critère : le testeur sait alors ce qu'il reste à écrire.
- **Contrat partiel** : si la demande ne porte que sur un écran ou quelques points, le contrat ne
  couvre que ceux-là. Dis-le dans la ligne d'en-tête (« Contrat partiel : point S.4 seul ») et
  liste les autres points dans « Points sans critère » avec la mention « hors de la demande ».
- Un état `a-confirmer` n'a pas de critère : on n'écrit pas de test rouge sur une supposition. Il
  figure dans « À confirmer avant le dev » et reçoit son critère une fois confirmé.
- Un critère `recette` contient la raison dans son énoncé (« Non automatisable : … »).
- Les deux sous-sections finales sont toujours présentes ; écris « Aucun. » si elles sont vides.
