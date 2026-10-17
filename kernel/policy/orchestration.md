# Orchestration

Comment un cycle se déroule, ce qui le fait avancer tout seul, et ce qui
l'arrête.

## Le tableau noir, et sa limite

Les agents ne se parlent pas. Ils se coordonnent par la couche décisionnelle,
par git et par le document de plan. Un agent qui a besoin de savoir ce qu'un
autre a décidé lit sa page — il ne lui demande pas.

Ça ne veut pas dire que personne ne lance personne. **L'orchestrateur lance
les agents de phase en sous-processus** : c'est lui qui déclenche le dev, puis
la review. Ce qui est interdit, c'est l'échange latéral — un agent de dev qui
consulterait le reviewer, ou l'inverse. Le canal reste la page, toujours.

## La boucle

Gate d'entrée : besoin défini, plan validé, **GO explicite** de l'humain. Le
routage modèle est visible dans le plan et peut être écrasé à ce moment-là.

Ensuite, pour chaque sous-tâche, dans l'ordre des dépendances :

```
1. BUILD    l'agent de dev exécute le brief
2. GATE     l'orchestrateur vérifie la DoD, lance la suite complète,
            et le contrôle anti-dépassement de périmètre
3. REVIEW   le reviewer juge le diff, borné, en JSON
4. TRIAGE   l'orchestrateur route chaque finding
5. CLEAN    purge du mirroir mémoire
```

Toutes les sous-tâches vertes et sans finding bloquant → escalade finale :
résumé, diff, proposition de livraison.

Tout se passe sur une branche dédiée. Jamais de poussée sur la branche
principale sans aval humain.

## Le gate

Quatre vérifications, toutes obligatoires, dans cet ordre :

**1. Le commit existe.** Un point de plan est un commit. Un agent qui rend du
travail non commité n'a rien rendu — le rappeler dans le brief, parce que ça
arrive.

**2. La suite complète passe.** Pas un sous-ensemble, pas « les tests qui me
semblent pertinents ». Un gate étroit rate les dérives d'artefacts générés,
qui sont précisément le genre de casse qu'aucun agent ne pense à chercher.
Les commandes sont dans `commands` du manifeste ; si le projet a plusieurs
couches, chaque couche touchée lance son gate **en entier**.

**3. Le diff est resté dans le périmètre.** La contrainte dans le brief ne
suffit pas — elle se double d'un contrôle mécanique :

```bash
git --no-pager show <COMMIT> | grep -E "^-" | grep -vE "^---" | wc -l
```

Proche de zéro. Toute suppression de ligne existante hors en-têtes est un
dépassement : reformatage automatique, refactor non demandé, réindentation.
La sanction est le revert ou l'escalade, pas la discussion.

**4. Le handoff existe.** Voir `policy/phases.md`.

## Échec pré-existant

Un gate qui échoue sur quelque chose que le diff ne touche pas ne bloque pas
la sous-tâche. Trois conditions, toutes obligatoires :

**Le prouver.** Rejouer le test en échec sur la base, sans le diff. Si la
démonstration n'est pas faite, l'échec est le tien.

**Le signaler fort.** Fichier, message exact, depuis quand. Dans le handoff
et dans la demande de livraison. Un agent de dev n'a pas les credentials pour
ouvrir une carte — le silence perd l'information définitivement.

**Ne jamais le contourner.** Aucun `skip`, aucun test exclu, aucun seuil
abaissé, aucune assertion retirée. Rendre un test vert en supprimant ce qu'il
vérifiait est un échec de DoD, pas un raccourci. On le laisse rouge et on le
signale.

La raison : une régression sans rapport arrivée sur la branche principale ne
doit pas prendre la sous-tâche en otage — mais elle ne doit pas non plus
passer à la trappe. Elle a sa propre carte et se corrige sur son propre
mérite.

## Triage

L'orchestrateur lit les findings et route par catégorie. C'est mécanique :

| Catégorie                        | Route                           |
| -------------------------------- | ------------------------------- |
| `bug`, `test-gap`, `nit`         | re-dev automatique, dans le cap |
| `design`, `archi`, `scope-creep` | escalade humaine                |

Le critère n'est pas la gravité, c'est la nature. Un bug bloquant se corrige
tout seul ; une question de conception mineure remonte. Un agent qui tranche
une décision d'architecture pour éviter une escalade a fait le contraire de
ce qu'on lui demande.

## Garde-fous

- **Cap de re-dev** : deux par sous-tâche, puis escalade. Une troisième
  tentative sur le même point signale que le brief est faux, pas l'agent.
- **Cap budget** : natif côté reviewer, à surveiller côté dev.
- **Branche dédiée**, donc réversible.

## Ce qui remonte à l'humain

Rien d'autre que ça :

- un finding de conception ou d'architecture ;
- un dépassement de périmètre détecté au gate ;
- une sous-tâche encore rouge après le cap de re-dev ;
- un garde-fou budget atteint ;
- une ambiguïté irréductible dans le besoin ou le plan.

Le reste se déroule et se présente à la fin. Une escalade sur autre chose que
cette liste est une orchestration qui n'orchestre pas.
