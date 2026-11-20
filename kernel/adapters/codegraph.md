# Adaptateur — capacité `structural_index`

Implémentation : le daemon aid expose les outils `index_*`, avec CodeGraph comme moteur et `codegraph` comme CLI de repli.

## Appel

```
index_explore { query }               (MCP « aid », agent principal)
codegraph explore <recherche>         (CLI, sous-agents et harnais sans MCP)
```

`index_explore` rend un texte libre (jamais du JSON) : le sens du code plutôt qu'un nom
exact. Derrière, le daemon porte la capacité `structural_index` du kernel pour le worktree
du sujet courant — un seul serveur MCP (`aid`) pour la mémoire et l'index, plus besoin
d'installer le MCP `codegraph` tiers. Celui-ci (`codegraph_explore` et le reste de sa
surface) reste toléré en transition, worktree par worktree, tant qu'il est déjà enregistré
quelque part.

Le reste de la surface, par ordre d'utilité :

```
index_impact { symbol, depth? }        # ce qu'un changement de ce symbole touche
index_affected { files }               # les fichiers de test concernés
index_callers { symbol, limit? }       # qui l'appelle
index_symbols { query, kind?, limit? } # trouver un symbole par son nom
index_status {}                        # moteur, fraîcheur, nombre de fichiers en retard
```

Les relations rendues portent `provenance` : `candidate` pour codegraph (tree-sitter, pas
de type-checker — homonymes fusionnés dans `callers`), `heuristic` pour ce qu'il synthétise
par convention. Un futur moteur fondé sur le type-checker rendra `exact`.

## Par phase

<!-- prettier-ignore -->
| Phase | Usage |
|---|---|
| plan | `index_impact` → le rayon d'impact va dans la page de plan |
| dev | `index_explore` pour comprendre avant de modifier |
| review | `index_affected` → les tests à faire tourner ; comparaison du diff au rayon déclaré |

## Contraintes

**Le résultat est dérivé du code : il ne se note jamais en mémoire.** Règle du kernel,
reprise dans la description de chaque outil `index_*`.

**Ne jamais déléguer l'exploration à un sous-agent.** L'outil n'aide que
s'il est interrogé directement.

**Index indisponible.** Moteur coupé, binaire absent ou délai dépassé rendent tous le même
texte, `isError` « index indisponible : lecture directe » — lire le fichier directement
plutôt qu'insister. `index_status` porte `stale` et le nombre de fichiers en retard quand
l'index n'a pas rattrapé une écriture récente.

## Limites connues

Les langages à forte dynamique donnent un graphe plus maigre. En particulier
les pipelines de données construits par chaînage de transformations ou
pilotés par configuration : le graphe d'appels ne capture pas le flux de
données. Sur ces projets, l'index reste utile pour la navigation mais le
rayon d'impact est à considérer comme un plancher, pas comme un périmètre.

Les frontières réseau sont opaques. Un appel client vers un service distant
est suivi jusqu'à l'appel, pas au-delà — ce qui vit côté serveur relève de la
couche décisionnelle.

## Installation

Une fois par machine :

```bash
npm install -g @colbymchenry/codegraph
codegraph telemetry off        # la télémétrie est active par défaut
```

Une fois par projet :

```bash
codegraph init      # construit l'index
codegraph status    # vérifier
codegraph install   # déclare le serveur MCP auprès des agents installés
```

`codegraph install` câble le serveur MCP dans les agents détectés — dont
l'agent de dev de la chaîne, qui gagne ainsi l'accès direct à l'index au lieu
de retomber sur la lecture de fichiers.

`.codegraph/` va dans le `.gitignore` — c'est de la donnée dérivée.

**Avant le premier `init`** : vérifier qu'aucun fichier d'environnement ou de
secret ne traîne hors `.gitignore`. Ce qui est ignoré n'est pas indexé, mais
un secret commité serait indexé et servi à l'agent.

En cas d'index bloqué : `codegraph unlock`, puis `codegraph index` pour
reconstruire de zéro.
