# Adaptateur — capacité `memory`

> **Déprécié depuis 0.9.0, retiré en 1.0.** La capacité `memory` est portée par
> `adapters/aid.md`. Ce fichier reste pour les projets dont le manifeste déclare encore
> `adapter: gbrain` ; `/sync` les avertit. Procédure de migration : `CHANGELOG.md`, 0.9.0.

Implémentation : GBrain. Recherche sémantique par embeddings sur des pages
écrites par les agents.

## Sources et fédération

Une installation GBrain héberge **plusieurs sources**, une par projet, et
chacune est soit **fédérée** — visible depuis les recherches des autres — soit
**isolée**. C'est le point qui décide si la couche transverse du noyau
fonctionne ou pas.

```bash
gbrain sources list        # état et mode de chaque source
```

La source du projet courant est épinglée dans `.gbrain-source` à la racine du
repo. Elle se déclare aussi à chaque appel :

```bash
gbrain search "<termes>" --source <project.namespace>
```

**Une isolation est un choix, pas un défaut.** Isoler la source d'un projet
empêche sa fuite dans les recherches des autres — c'est parfois exactement ce
qu'on veut. Mais ça rend aussi les pages `lesson/` écrites depuis ce projet
introuvables ailleurs, ce qui annule la couche cumulative. D'où la règle
ci-dessous.

**Vérifier l'isolation à chaque cycle.** Le mode d'une source peut changer
silencieusement à une montée de version de l'outil. Une source qu'on croyait
isolée et qui ne l'est plus est une fuite ; une source qu'on croyait fédérée
et qui ne l'est plus est une mémoire transverse morte sans message d'erreur.

## Appel

```bash
gbrain search "<termes>" --source <source>          # recherche par mots-clés
gbrain query "<question>" --source <source>         # recherche hybride
gbrain put <slug> --content "…" --source <source> --force   # écrire une page
echo "<contenu>" | gbrain put <slug> --source <source> --force
```

**`--force` n'est pas optionnel.** Depuis gbrain 0.52, remplacer une page
existante exige sa révision (`--expected-revision`) ou `--force` ; sans l'un
ni l'autre, `put` et `capture` ne savent que créer, et la mise à jour d'une
page de plan ou de handoff échoue en `revision_conflict`. Les phases
réécrivent leur page en entier : `--force` est le bon contrat.

**Mais une page de phase se complète, elle ne se remplace pas.** Une même
tâche connaît plusieurs lancements de la même phase — re-dev après review,
point du plan livré par un second agent. `--force` écrase sans rien
demander : le lancement suivant efface alors le handoff du précédent, et la
review compare le diff à un compte rendu amputé (constaté le 2026-09-24,
cycle `site-commercialisation`). Avant d'écrire, lire la page
(`gbrain get <slug> --source <source>`) ; si elle existe, la réécrire
**en entier, en ajoutant sa section à la fin**, titrée du lancement
(`## Re-dev 1/2`, `## Point 5`…). Ne jamais retirer une section écrite par
un autre lancement.

**Le slug est en `/`, jamais en `:`.** gbrain 0.52 refuse tout slug hors
`[lettres chiffres . _ -]` séparés par `/` (`invalid_params`).

Avant d'écrire, chercher : une page existante sur le même sujet se met à jour
plutôt que de se dupliquer.

## Où va quoi

| Pages                     | Source                                                                  | Pourquoi                                           |
| ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| `<namespace>/plan         | dev-handoff                                                             | review                                             | retro/*` | celle du projet | cycliques, sans intérêt ailleurs |
| `lesson/<domaine>/<slug>` | `capabilities.memory.lessons_source` du manifeste, **toujours fédérée** | c'est la seule couche censée traverser les projets |

Écrire une `lesson/` dans une source isolée est l'erreur qui vide la
politique de son sens : la page existe, la rétro se sent utile, et personne ne
la retrouvera jamais depuis un autre projet.

## Contraintes

**Rien de dérivable du code.** C'est la règle qui détermine si la mémoire
reste utile ou pourrit. Voir `policy/routing.md`.

**Écriture aux frontières de phase seulement.** Pas d'écriture opportuniste
en cours de travail — ça produit du volume sans validation.

**`lesson/` en rétro uniquement.** Aucune autre phase ne touche à l'espace
transverse.

## Hygiène

**Pas de mirroir : `sync.write_through` est coupé.** Par défaut, gbrain
recopie chaque page écrite en fichier markdown dans le dépôt de la source —
et, depuis 0.52, n'accepte alors d'écriture que du poste déclaré
« propriétaire » de ce dépôt (`owner_unavailable` partout ailleurs). La
chaîne veut que **chaque poste puisse tout faire** ; les pages mémoire vivent
donc en base seulement :

```bash
gbrain config get sync.write_through     # doit répondre false
gbrain config set sync.write_through false   # réglage du cerveau, une fois pour tous les postes
```

Le réglage est stocké dans la base partagée : il vaut pour toutes les
machines à la fois. `bootstrap-machine.sh --check` le vérifie. Un `sync
--full` ne supprime pas ces pages sans fichier (vérifié en 0.52.2).

**Les fonctions de recherche de code ne sont pas utilisées ici.** GBrain sait
faire `code-def` et consorts, mais ce rôle est tenu par `structural_index`,
exact là où la recherche sémantique est approximative. Deux outils pour la
même question, c'est la violation d'exclusivité du routage — et celui des deux
qui répond « à peu près » est celui qu'on retire.

Purger périodiquement les pages cycliques des cycles clos.

## Dépendances

Le calcul des embeddings passe par un service distant et demande sa clé dans
l'environnement — sans elle, la synchronisation échoue. C'est le seul point où
quelque chose sort de la machine.
