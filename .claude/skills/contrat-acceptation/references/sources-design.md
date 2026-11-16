# Lire une source de design

Va directement à la section du type que tu as sous les yeux.

- [Maquette à la convention](#maquette-à-la-convention)
- [Export `.dc.html`](#export-dchtml)
- [Captures ou archive](#captures-ou-archive)
- [Brief ou plan en prose](#brief-ou-plan-en-prose)
- [L'application elle-même](#lapplication-elle-même)

## Maquette à la convention

**Où** : `design/maquettes/` (écrans 1.x, 2.x), `design/aid-export-git-flow/html/` (3.x).
**Reconnaissable à** : `data-screen`, `data-state`, `data-viewport` sur la racine de chaque cadre,
aucun attribut `style`.

Ces fichiers pèsent 100 à 300 Ko : ne les lis jamais en entier. Le script fait l'inventaire :

```bash
node .claude/skills/contrat-acceptation/scripts/extraire-noeuds.mjs design/maquettes/aid-1-3-sujet.html
node .claude/skills/contrat-acceptation/scripts/extraire-noeuds.mjs --json design/maquettes/aid-1-3-sujet.html
```

Il rend les cadres (état × taille), les nœuds de chaque état, ce qui apparaît ou disparaît d'un
état à l'autre, les `data-action` et `data-bind`. Le `--json` donne la matière brute d'une fiche.

Tout y est `specifie`, sauf les données d'exemple (noms de sujets, compteurs) : `illustratif`.

**Piège, et il est de taille** : ces maquettes datent d'avant la refonte de l'interface. L'application
a volontairement divergé — la barre du haut v0 n'existe plus, par exemple. Avant de t'appuyer sur
l'une d'elles pour un chantier d'aujourd'hui, extrais aussi le composant correspondant de
`web/src` et compare : si la majorité des nœuds de la maquette sont absents de l'application, la
maquette est périmée pour cet écran. Dis-le et bascule sur « l'application elle-même ». Une fiche
tirée d'une maquette périmée ferait signaler comme écarts des choix assumés.

Ne reformate jamais ces fichiers : `test/web/maquette-css.test.ts` compare leur empreinte.

## Export `.dc.html`

**Où** : `design/aid-vps/sources/`. **Reconnaissable à** : `<x-dc>`, `<dc-import>`, `<sc-for>`,
`<sc-if>`, des trous `{{…}}`, des styles en ligne, un `<script type="text/x-dc">`.

**Commence par passer le script dessus.** Un export produit avec `assets/consigne-design.md`
porte `data-screen`, `data-state`, `data-viewport` et des `data-node` : le script le lit alors
comme une maquette à la convention (les `{{m.id}}` deviennent `{id}`), les noms sont `specifie`
et tu n'as plus qu'à reprendre les étiquettes du brief. Le reste de cette section vaut pour un
export **sans** ces attributs — le script le dit (« aucun data-node »).

Sans attributs, ce format n'est **pas convertible mécaniquement** : aucun nom de nœud, aucun état, une seule
largeur (1440, conçu pour ≥ 1280), et il ne se rend pas sans un `support.js` qui n'est pas dans le
dépôt. Le brief qui l'accompagne interdit d'ailleurs d'en copier le markup. Tu le lis comme un
plan d'architecte, et c'est toi qui nommes.

Méthode :

1. `canvas.json` d'abord : la liste des planches, leur titre, leur taille. C'est le sommaire.
2. `BRIEF.md` ensuite, section par section. Il étiquette ce qu'il dit : **Spécifié** →
   `specifie`, **Illustratif** → `illustratif`, **À confirmer** → `a-confirmer`. Reprends ces
   étiquettes telles quelles, c'est la provenance.
3. Le `.dc.html` de l'écran, pour la structure : chaque bloc commenté (`<!-- Lecture -->`) est une
   zone candidate, chaque `<sc-for>` un élément répété (donc un nœud `…-{id}`), chaque `<sc-if>`
   une variante ou un état, chaque `<dc-import name="Nav">` un composant partagé qui a sa propre
   fiche.
4. Les valeurs de style : relève-les dans `tokens.json`, pas dans les `style="…"`. Retrouve le
   token qui correspond à la valeur en ligne (`#5de0a1` → `token:color.accent`). Une valeur en
   ligne sans token correspondant est `a-confirmer` : c'est soit un token manquant, soit un écart
   du designer.
5. Les données dans `renderVals()` sont factices : `illustratif`.

Ce que l'export ne dit pas, et que tu dois signaler plutôt qu'inventer : les états vide,
chargement, erreur ; le téléphone et la tablette ; le focus clavier ; les textes d'erreur.

## Captures ou archive

**Où** : fournies par l'utilisateur ; les plans des chantiers 24 à 32 citent
`design/aid-refonte-review-2026-11-04-v4.zip`, qui n'est pas dans le dépôt.

Une archive venue de l'extérieur se décompresse dans un dossier vide à elle, hors du dépôt.

Une capture donne la structure et les proportions, rien de mesurable avec certitude. Tout ce que
tu en tires est `a-confirmer` pour les styles ; les nœuds peuvent être `specifie` si une fiche de
spécification écrite accompagne la capture et nomme la zone. Ne relève pas de couleur ni de taille
de police à l'œil sur une image : relève-les dans les tokens ou ne les relève pas.

## Brief ou plan en prose

Cas le plus fréquent sur les chantiers récents : l'écran n'existe que dans une décision du plan
(« D341. L'écran »).

Chaque phrase de la décision qui nomme un élément visible donne un nœud `specifie` ; chaque texte
entre guillemets donne un champ `texte`. Tout le reste de l'écran — sa structure, ses styles —
n'est pas spécifié : ne mets pas de `styles` dans la fiche, hormis ce que la décision fixe.

Déclare la source `brief`. Pour ce type d'écran, le niveau `conformite` ne vérifie que la
structure ; les contrôles de bon sens du vérificateur (pas d'erreur console, pas de débordement,
focus atteignable) font le reste.

## L'application elle-même

Pour un écran déjà livré et accepté en recette, dont la maquette est absente ou périmée.

```bash
node .claude/skills/contrat-acceptation/scripts/extraire-noeuds.mjs web/src/ecrans/Machines.tsx web/src/ui/Statut.tsx
```

Le script lit le source, pas le rendu : il ne sait pas quels nœuds sont présents dans quel état.
Pour ça, lis les conditions du composant autour des lignes qu'il cite, ou les tests existants de
`test/web/` qui montent déjà l'écran dans chaque état — ils disent aussi comment mettre l'écran en
place, ce qui remplit `mise_en_place`.

Un composant partagé (`Barre`, `Nav`, `Statut`) reçoit son préfixe en propriété : le script
l'affiche comme `{screen}.barre.…`. Dans la fiche de l'écran, remplace par le préfixe réel.

Pour les styles, relève les déclarations de la feuille de l'écran (`web/src/styles/<ecran>.css`)
et écris-les en `var:--nom` avec `variables_css: "web/src/styles/maquette.css"` : c'est là que
l'application définit ses variables. N'utilise pas `token:` ici, les tokens du design ne sont pas
ceux de l'application.

Tout est `existant`. Dis clairement à l'utilisateur que cette fiche fige l'état actuel : elle
attrapera une régression, pas un défaut déjà présent.
