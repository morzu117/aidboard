---
name: contrat-acceptation
description: Prépare tout ce dont les testeurs ont besoin pour un chantier A-I-D — convertit un plan de `docs/chantiers/` et le design disponible (maquette à la convention data-node, export `.dc.html`, captures, brief en prose, ou rien) en fiches de référence d'écran (`design/references/<ecran>.json` — nœuds data-node, états, tailles, styles attendus) et en contrat d'acceptation (critères vérifiables rattachés à un niveau de test, ajoutés au plan). À utiliser dès qu'il est question de contrat d'acceptation, de critères d'acceptation, de fiche de référence, de préparer le travail du testeur ou du vérificateur, de convertir une maquette ou un export design en quelque chose de testable, de nommer des data-node pour un nouvel écran, de figer un écran existant comme référence, ou d'écart maquette/UI — même si l'utilisateur ne prononce pas le mot « contrat ». À utiliser aussi en phase plan, avant de lancer le dev d'un point qui touche `web/src`.
---

# Contrat d'acceptation et fiches de référence

## À quoi ça sert

Dans la chaîne, le développeur écrit le code et ses propres tests : ces tests vérifient ce que le
code fait, pas ce que le plan demandait. Le testeur d'acceptation écrit donc ses tests **depuis le
plan, sans voir l'implémentation**, et le vérificateur compare l'application lancée à une
référence. Ni l'un ni l'autre ne peut travailler depuis de la prose ou une capture d'écran : il
leur faut des critères vérifiables et des noms de nœuds.

Ce skill produit ces deux choses :

1. **Une fiche de référence par écran** — `design/references/<ecran>.json`. Elle dit quels nœuds
   `data-node` existent, dans quels états, à quelles tailles, avec quelles valeurs de style. C'est
   le fichier que les tests et le vérificateur lisent.
2. **Le contrat d'acceptation** — une section ajoutée à la fin du plan du chantier. Chaque critère
   est rattaché à un point du plan, à un niveau de test et à un fichier de test.

Tu n'écris ni les tests ni le code de l'écran. Tu donnes au testeur de quoi les écrire.

## Ce qu'il te faut

- **Le plan** : `docs/chantiers/<n>-<slug>.md`. Sans plan, arrête-toi et demande-le : un contrat
  sans plan n'a rien à quoi se rattacher.
- **Le design**, sous la forme qui existe. Cherche dans cet ordre, et prends la première source
  qui couvre l'écran : maquette à la convention (`design/maquettes/`, `design/aid-export-*/`),
  export `.dc.html` + `BRIEF.md` + `tokens.json`, captures ou archive fournies par l'utilisateur,
  description dans le plan, l'application elle-même (écran déjà livré). Les plans citent souvent
  des sources hors dépôt (`docs/fusion-aid-swarph/`, des `.zip`) : si elles sont absentes de la
  machine, dis-le et demande-les plutôt que de reconstruire l'écran de mémoire.

Lis `references/sources-design.md` avant de traiter une source : chaque type a sa façon d'être lu
et ses pièges.

**Si le design n'est pas encore fait** — l'utilisateur s'apprête à ouvrir une session de design,
ou te demande comment préparer la suite — donne-lui `assets/consigne-design.md` à coller au début
de cette session, et arrête-toi là pour les écrans concernés. Un design produit avec cette
consigne porte déjà ses noms de nœuds, ses états et ses tailles : la conversion devient une
extraction, et il ne reste presque rien `a-confirmer`. Sans elle, c'est toi qui devines, et chaque
devinette est une question de plus pour l'humain.

## Trois situations, trois livrables

Repère d'abord dans laquelle tu es : le déroulé complet ne vaut que pour la première.

| Situation                                                                               | Ce que tu livres                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chantier à venir** : un plan, du code pas encore écrit.                               | Fiches + contrat complet. Tout le déroulé.                                                                                                                                                                                          |
| **Chantier déjà livré** : le plan existe, le code et des tests aussi.                   | Fiches + contrat écrit depuis le plan, puis seulement ensuite un regard sur les tests existants pour marquer `(couvert)` ce qui l'est. L'ordre compte : lire les tests d'abord, c'est écrire le contrat que le code satisfait déjà. |
| **Figer un écran existant** : pas de chantier, on veut une référence de non-régression. | Fiches seules (étapes 2, 3, 6, 7). Pas de contrat, sauf si l'utilisateur le demande ; dans ce cas il se rattache au plan du chantier qui a livré l'écran.                                                                           |

Pour un écran déjà livré, deux vérifications évitent de figer une illusion :

- **Les `data-node` existent-ils ?** Lance l'extracteur sur les composants. S'il n'en trouve
  aucun, dis-le en tête de ton compte rendu : tous les noms de la fiche sont alors des
  propositions (`nom_dans_app: false`), et les critères qui les citent ne passeront qu'après un
  point de dev qui les pose.
- **L'écran a-t-il changé depuis sa recette ?** `git log --oneline -- <composant>` le dit. Si des
  chantiers ultérieurs l'ont modifié, nomme-les : « accepté au chantier 29 » ne couvre pas ce que
  le 31 et le 33 ont ajouté.

## Déroulé

### 1. Lire le plan et découper

Relève les points (`### 41b.3 …`), les décisions (`### D341 …`), la cible, le hors-périmètre.
Classe chaque point : **daemon**, **web**, **e2e/recette**, **docs**. Seuls les points web ont
besoin d'une fiche d'écran ; tous ont besoin de critères.

Ne lis que ces sections du plan, pas le plan entier s'il est long : les plans de ce dépôt font
souvent plusieurs centaines de lignes de décisions révisées.

### 2. Établir la fiche de chaque écran touché

Pour un écran **déjà maquetté à la convention** ou **déjà dans l'application**, ne recopie rien à
la main — extrais :

```bash
node .claude/skills/contrat-acceptation/scripts/extraire-noeuds.mjs design/maquettes/aid-1-1-accueil.html
node .claude/skills/contrat-acceptation/scripts/extraire-noeuds.mjs web/src/ecrans/Machines.tsx
```

Sur un `.tsx`, le script résout les préfixes du type `const n = (rest) => \`machines.${rest}\``et
liste à part les`data-node`calculés qu'il n'a pas su résoudre. Ceux-là, résous-les en lisant les
quelques lignes signalées ; ne les ignore pas, sinon la fiche décrit un écran incomplet et le
vérificateur signalera de faux « nœuds en trop ». Il liste aussi les composants importés qui
posent leurs propres nœuds et les préfixes transmis à un enfant : relance-le sur ces fichiers, un
écran tient rarement dans un seul. Les composants vivent dans`web/src/ecrans/`, `web/src/ui/`,
`web/src/dialogues/`et`web/src/conversation/`.

**Quand plusieurs sources décrivent le même écran**, elles ne se valent pas pour tout :

- **les noms** viennent de l'application dès qu'elle en pose — un nom différent casserait les
  tests existants ;
- **ce qui doit être là** (éléments, textes, états) vient du plan ou du design ;
- un élément voulu par le plan ou le design que l'application ne nomme pas encore garde sa
  provenance (`specifie`) et reçoit `nom_dans_app: false` ;
- un élément présent dans l'application et absent du design est `existant` : ne le retire pas de
  la fiche, signale-le comme écart possible.

Déclare la source qui fait foi dans `source.type` et les autres dans `source.aussi`. Tout écart
que tu vois entre le design et l'application en passant (une police, un emplacement) va dans ton
compte rendu : c'est exactement ce que l'utilisateur cherche, ne le garde pas pour toi.

Pour un écran **nouveau**, c'est toi qui nommes les nœuds. Règles de nommage, reprises de
`design/maquettes/README.md` — elles comptent parce que 1 000 `data-node` de l'application et tous
les tests les suivent déjà :

- `écran.zone.élément[.champ]`, en minuscules, mots séparés par des tirets. Le préfixe d'un nouvel
  écran est un mot (`machines`, `livraison`, `carte-board`), pas un numéro.
- Un élément répété est indicé dans la fiche par un gabarit : `machines.machine-{id}.nom`.
- Un nœud est unique dans son cadre, et **identique à toutes les tailles** : ce qui n'a pas la
  place est masqué, jamais retiré. C'est ce qui rend la comparaison de structure possible.
- Nomme ce qu'un test devra retrouver : les zones, les éléments interactifs, les textes porteurs
  d'information, les états (vide, chargement, erreur). Pas les `div` de mise en page.
- Avant d'inventer une zone, regarde si l'application en a déjà une équivalente (barre, volet,
  bandeau) et reprends son nom : `index_symbols` ou l'extraction d'un écran voisin.

Écris ensuite la fiche au format de `references/format-fiche.md`.

### 3. Dire d'où vient chaque chose

C'est la règle qui rend la fiche digne de confiance. Chaque nœud et chaque valeur de style porte
une `provenance` :

| Valeur        | Sens                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `specifie`    | Écrit dans le plan, le brief ou une maquette à la convention.                                                                        |
| `existant`    | Relevé dans l'application telle qu'elle est aujourd'hui.                                                                             |
| `illustratif` | Présent dans la maquette mais donnée factice (noms, compteurs, latences). Le test vérifie la présence et la forme, jamais la valeur. |
| `a-confirmer` | Déduit par toi. Personne ne l'a décidé.                                                                                              |

Un export `.dc.html` ou une capture ne dit rien des états vide, chargement et erreur, ni du
téléphone. Tu peux proposer ces cadres — c'est utile, beaucoup de bugs d'UI y vivent — mais en
`a-confirmer`, et tu les listes à l'utilisateur à la fin. Ne les fais jamais passer pour
spécifiés : un testeur écrirait un test rouge sur une invention, et le dev implémenterait une
décision que personne n'a prise. Une ambiguïté de conception remonte à l'humain, c'est une règle
de la chaîne.

### 4. Écrire les critères

Un critère est une phrase qu'un test peut rendre vraie ou fausse. Pour chaque point du plan,
dérive-les des décisions qu'il cite :

- un comportement observable par critère (« le bouton “Créer la carte” est désactivé sans
  proxy »), pas une intention (« l'écran gère bien l'absence de proxy ») ;
- les bornes et les refus comptent autant que le cas nominal : une décision qui dit « de 1 à 200
  caractères » donne trois critères (0, 200, 201) ;
- chaque message d'erreur cité entre guillemets dans le plan est un critère : le texte exact fait
  partie du contrat ;
- pour un point web, au moins un critère par état **confirmé** de la fiche, et un par taille où
  l'écran change de forme. Un état `a-confirmer` n'a pas de critère tant que personne ne l'a
  décidé : il va dans les questions.

Rattache chaque critère au **niveau le moins cher qui le vérifie vraiment** :

| Niveau       | Fichier                               | Pour                                                                        |
| ------------ | ------------------------------------- | --------------------------------------------------------------------------- |
| `unitaire`   | `test/<nom>.test.ts`                  | Logique du daemon, schémas, bornes, refus.                                  |
| `web`        | `test/web/<nom>.test.tsx`             | Un composant rendu : nœuds présents, libellés, bouton désactivé, états.     |
| `e2e`        | `e2e/<nom>.spec.ts`                   | Un parcours complet contre le daemon et les faux services.                  |
| `conformite` | `design/references/<ecran>.json`      | Structure et styles comparés à la fiche, par état et par taille.            |
| `recette`    | `docs/recette-chantier-<n>-<slug>.md` | Ce qui exige un vrai environnement (vrai mesh, vrai proxy, vrai téléphone). |

Un critère en `recette` dit pourquoi il n'est pas automatisable. « C'est plus simple à la main »
n'est pas une raison : la recette manuelle est le seul filet aujourd'hui, et le but est de la
réduire à ce qui demande réellement un humain.

Rappelle au testeur les contraintes du dépôt quand un critère les touche : `AID_HOME` temporaire,
jamais le vrai `~/.aid` ; jamais `claude` ni `codex` dans un test automatique
(`test/fixtures/fake-agent.sh`) ; faux proxy et faux swarph de `test/fixtures/`.

### 5. Ajouter le contrat au plan

Ajoute **à la fin** du plan une section `## Contrat d'acceptation`, au format exact de
`references/format-fiche.md` (le validateur la relit). N'édite aucune ligne existante du plan :
le dépôt est en insertion seule, et un plan réécrit ne se relit plus contre ses révisions.

Si la section existe déjà (révision du plan, re-dev), complète-la : ajoute les critères nouveaux,
marque `retiré (révision N)` ceux qui ne tiennent plus, ne renumérote pas — les tests portent déjà
ces identifiants.

### 6. Valider

```bash
node .claude/skills/contrat-acceptation/scripts/valider-fiche.mjs --plan docs/chantiers/<n>-<slug>.md design/references/<ecran>.json
```

Le validateur vérifie la forme des fiches, l'unicité et le nommage des nœuds, les références de
tokens, que chaque critère a un niveau et un fichier de test cohérents, que chaque nœud cité dans
le contrat existe dans une fiche, et il liste les points du plan sans critère et tout ce qui reste
`a-confirmer`. Corrige les erreurs ; les avertissements se rapportent tels quels.

### 7. Rendre la main

Dis à l'utilisateur, brièvement :

- les fichiers écrits ;
- le nombre de critères par niveau ;
- **la liste des `a-confirmer`**, formulée en questions auxquelles il peut répondre par oui ou non ;
- les points du plan pour lesquels tu n'as pas pu écrire de critère vérifiable, et pourquoi —
  c'est souvent le signe que le plan lui-même est flou à cet endroit, et c'est une information
  utile avant de lancer le dev ;
- les sources de design citées par le plan et absentes de la machine ;
- **ce que tu as remarqué en chemin et qui n'entre pas dans le format** : un comportement du code
  qui contredit une décision du plan, un token de design dont la valeur n'est pas celle de
  l'application, un écart de mise en page entre la planche et l'écran. Le format range, il ne doit
  pas faire taire : ces constats valent souvent plus que la fiche elle-même.

Ne commite pas : le contrat se relit avant d'engager le testeur.

## Limites à dire plutôt qu'à masquer

- L'outil qui compare l'application lancée à une fiche (niveau `conformite`) peut ne pas exister
  encore dans le dépôt. Cherche-le avant de promettre ; s'il n'existe pas, écris quand même les
  critères `conformite` et signale qu'ils ne seront vérifiables qu'une fois l'outil livré.
- Une fiche tirée de l'application (`existant`) garde contre les régressions, pas contre un écart
  initial à la maquette : elle fige ce qui est, pas ce qui était voulu. Dis-le quand tu en produis
  une.
- Si l'index structurel ne répond pas, lis les fichiers directement et nomme la capacité absente
  dans ton compte rendu.
