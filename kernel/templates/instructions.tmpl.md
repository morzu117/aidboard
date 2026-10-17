## Chaîne agent — {{project.name}}

Rendu depuis agent-kernel {{kernel.version}}. Ne pas éditer à la main :
toute modification est écrasée au prochain `/sync`. Pour changer ce bloc,
modifier le noyau ou `agent.yml`.

### Routage de la connaissance

Pour une question donnée, il y a **exactement un** premier point d'entrée.
Interroger deux sources « au cas où » double le coût au lieu de le diviser.

| La question porte sur                                                          | Premier appel                            | Interdit                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------- |
| Ce que le code fait, où c'est défini, qui appelle quoi, impact d'un changement | `{{capabilities.structural_index.call}}` | grep, lecture de fichier, sous-agent d'exploration |
| Pourquoi une décision, ce qui a été tenté, l'état d'un cycle                   | `{{capabilities.memory.call}}`           | relire l'historique git                            |
| Comment on travaille, quelle phase fait quoi                                   | ce bloc                                  | tout appel                                         |
| Rien ne répond                                                                 | lecture directe                          | —                                                  |

**Deux règles à ne pas violer :**

Le source rendu par `{{capabilities.structural_index.call}}` est **déjà lu**.
Ne pas le re-vérifier au grep.

**Ne jamais déléguer l'exploration du code à un sous-agent.** L'index n'aide
que s'il est interrogé directement ; un sous-agent qui lit des fichiers
annule le bénéfice. La phase qui doit comprendre le code l'interroge
elle-même.

### Quand une capacité ne répond pas

Ce bloc est **commité**. Il sera donc lu dans des environnements que le rendu
n'a pas inspectés : un worktree, un conteneur, une machine sans l'outillage.
La vérification faite au `/sync` vaut pour la machine qui a rendu, pas pour
celle qui lit.

La règle d'exclusivité vaut **là où la capacité répond**. Là où elle ne
répond pas, la table de routage retombe sur sa dernière ligne — lecture
directe. Deux conditions, non négociables :

**Dis-le.** Nomme la capacité absente dans ton handoff. Un agent qui retombe
silencieusement sur le grep rend un travail qui ressemble au travail normal
sans en avoir les garanties : le rayon d'impact déclaré n'en est plus un, et
la review vérifie un contrat qui n'existe pas.

**Ne fais pas semblant.** Ne présente pas une lecture de fichiers comme un
rayon d'impact. La phase plan dit explicitement qu'il n'a pas pu être établi ;
la review sait alors qu'elle n'a rien à comparer.

L'index momentanément en retard sur une écriture est un cas particulier de
capacité qui ne répond pas — même conduite.

### Règle d'hygiène mémoire

Si l'information est dérivable du code, elle n'a rien à faire en mémoire.
Une page qui décrit qui appelle quoi sera fausse dans deux semaines et
duplique ce que l'index donne à jour. La mémoire sert à ce qui n'est pas
dans le code : les intentions, les options écartées, les pièges appris.

Si la réponse obtenue est durable **et non dérivable du code**, elle remonte
en mémoire avant la fin de la phase.

### Phases

{{phases.table}}

Les agents ne s'échangent rien latéralement — ils se coordonnent par les
pages mémoire, par git et par le document de plan. L'orchestrateur lance les
agents de phase ; c'est le seul appel direct de la chaîne.

### Definition of Done

Quatre points, tous obligatoires, avant de rendre la main :

**1. Le commit existe** sur la branche courante. Un point de plan est un
commit. Du travail non commité est du travail non rendu.

**2. Le gate de la couche touchée est vert**, lancé **en entier** — pas un
sous-ensemble, pas « les tests qui semblent pertinents ». Un gate partiel
rate les dérives d'artefacts générés.

{{gates.block}}

**3. Le diff est resté dans le périmètre** — voir ci-dessous.

**4. Le handoff est écrit**, selon la phase.

### Contrainte de périmètre (stricte)

**Insertion-only.** N'ajoute que ce que la sous-tâche demande. Ne reformate
pas, ne réindente pas, ne touche à aucune ligne existante hors cible.

Le contrôle est mécanique, pas déclaratif :

```bash
git --no-pager show <COMMIT> | grep -E "^-" | grep -vE "^---" | wc -l
```

Proche de zéro. Toute suppression de ligne existante hors en-têtes est un
dépassement — reformatage automatique, refactor non demandé — et vaut revert
ou escalade.

Ne modifie ni le manifeste, ni la configuration du projet, ni la CI sans que
le brief le demande. Ne bump aucune version.

### Échec pré-existant

Un gate rouge sur quelque chose que ton diff ne touche pas ne te bloque pas.
Trois conditions, toutes obligatoires :

**Le prouver** — rejouer le test sur la base, sans ton diff. Sans la
démonstration, l'échec est le tien.

**Le signaler** — fichier, message exact, depuis quand. Dans le handoff. Un
échec remarqué et non signalé est un échec de DoD.

**Ne pas le contourner** — aucun `skip`, aucun test exclu, aucun seuil
abaissé, aucune assertion retirée. Rendre un test vert en supprimant ce qu'il
vérifiait n'est pas un raccourci.

### Escalade

Remontent à l'humain, et rien d'autre : un finding de conception ou
d'architecture, un dépassement de périmètre, une sous-tâche encore rouge
après {{guardrails.redev_cap}} re-dev, un garde-fou budget atteint, une
ambiguïté irréductible du besoin ou du plan.

Le reste se déroule et se présente à la fin.

### Pages mémoire

```
{{memory.source}} — pages cycliques du projet
  {{project.namespace}}/plan/<task>
  {{project.namespace}}/dev-handoff/<task>
  {{project.namespace}}/review/<task>
  {{project.namespace}}/retro/<cycle>

{{memory.lessons_source}} — espace partagé, transverse
  lesson/<domaine>/<slug>
```

`<task>` est un slug stable sur tout le cycle : il relie les quatre pages.

Les pages préfixées `{{project.namespace}}/` sont cycliques et se purgent une
fois la rétro faite. Les pages `lesson/` sont **transverses, sans préfixe
projet, et écrites dans un espace partagé** — c'est la seule couche qui
s'accumule, et la seule façon qu'une leçon apprise ici serve ailleurs. Une
`lesson/` écrite dans l'espace du projet est une leçon perdue. Seule la phase
retro y écrit.

### Capacités

{{capabilities.block}}

### Commandes

```
test   {{commands.test}}
lint   {{commands.lint}}
```

### Contexte projet

{{stack.block}}
