# Phases

Une phase est définie par ce qu'elle **lit** et ce qu'elle **écrit** — pas par
qui l'exécute. Les agents ne s'échangent rien latéralement : ils se coordonnent
par la couche décisionnelle, par git et par le document de plan.

L'enchaînement des phases, les gates et les règles d'escalade sont dans
`policy/orchestration.md`.

## plan

**Lit** — la demande, `lesson/` pertinents, l'index structurel.

**Écrit** — `<namespace>/plan/<task>`.

La page contient l'intention, les options écartées et pourquoi, et le
**rayon d'impact** obtenu de l'index structurel. Ce dernier point transforme
le blackboard : il passe de narratif à vérifiable.

Sortie : le rayon d'impact est déclaré, ou la page dit explicitement pourquoi
il n'a pas pu l'être.

## dev

**Lit** — `<namespace>/plan/<task>`, l'index structurel.

**Écrit** — `<namespace>/dev-handoff/<task>`.

Le handoff contient les écarts au plan et leur justification, et la liste des
tests affectés obtenue de l'index structurel. Cette liste devient un champ du
handoff au lieu d'être redevinée à chaque cycle.

Sortie : commit présent sur la branche, gate du projet vert, diff resté dans
le périmètre, handoff écrit. Le détail de ces quatre points est dans
`policy/orchestration.md`.

## review

**Lit** — `<namespace>/plan/<task>`, `<namespace>/dev-handoff/<task>`, le
diff, l'index structurel.

**Écrit** — `<namespace>/review/<task>`.

Vérification centrale : **le diff est-il resté dans le rayon d'impact
déclaré au plan ?** Un dépassement n'est pas nécessairement une faute, mais
il doit être nommé.

Sortie : verdict explicite. Pas de « globalement bon ». Les findings portent
une **catégorie**, parce que c'est elle qui pilote la phase suivante.

## triage

**Lit** — `<namespace>/review/<task>`.

**Écrit** — rien. Elle route.

Chaque finding part vers le re-dev ou vers l'humain selon sa catégorie, jamais
selon sa gravité. La table est dans `policy/orchestration.md`.

C'est la seule phase sans page : elle ne produit pas de connaissance, elle
prend une décision d'aiguillage qui se lit ensuite dans le cycle lui-même.
Lui donner une page reviendrait à écrire ce que le plan et la review disent
déjà.

Sortie : chaque finding est routé, ou le cycle est clos.

## retro

**Lit** — les trois pages du cycle.

**Écrit** — `<namespace>/retro/<cycle>`, et **zéro ou plusieurs**
`lesson/<domaine>/<slug>`.

C'est la seule phase autorisée à écrire dans l'espace transverse. Une leçon
n'est promue que si elle est vraie hors de ce projet. Dans le doute, elle
reste dans la rétro.

Sortie : les pages de cycle sont purgeables.

## Cycle de vie

Les pages préfixées par le namespace projet sont **cycliques** : elles se
purgent quand le cycle est clos, la rétro ayant extrait ce qui méritait de
survivre.

Les pages `lesson/` sont **cumulatives**. C'est la seule couche qui grossit
avec le temps au lieu de tourner.
