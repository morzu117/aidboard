# Adaptateur — capacité `structural_index`

Implémentation : CodeGraph. Index de code local sous `.codegraph/`, graphe
d'appels extrait statiquement, resynchronisé en tâche de fond à chaque
modification de fichier.

## Appel

```
codegraph_explore    (MCP, agent principal)
codegraph explore    (CLI, sous-agents et harnais sans MCP)
```

Un appel rend le source verbatim des symboles pertinents groupés par fichier,
les chemins d'appel entre eux — sauts de dispatch dynamique inclus — et un
résumé du rayon d'impact.

Le reste de la surface, par ordre d'utilité :

```bash
codegraph impact <symbole>       # ce qu'un changement de ce symbole touche
codegraph affected <fichiers…>   # les fichiers de test concernés
codegraph callers <symbole>      # qui l'appelle
codegraph callees <symbole>      # ce qu'il appelle
codegraph node <symbole|fichier> # un symbole et sa trace d'appels
codegraph query <recherche>      # trouver un symbole par son nom
codegraph context <tâche…>       # symboles et relations pour une tâche
```

## Par phase

| Phase  | Usage                                                                                   |
| ------ | --------------------------------------------------------------------------------------- |
| plan   | `codegraph impact <symbole>` → le rayon d'impact va dans la page de plan                |
| dev    | `codegraph_explore` pour comprendre avant de modifier                                   |
| review | `codegraph affected` → les tests à faire tourner ; comparaison du diff au rayon déclaré |

## Contraintes

**Le source rendu est déjà lu.** Ne pas le re-vérifier au grep.

**Ne jamais déléguer l'exploration à un sous-agent.** L'outil n'aide que
s'il est interrogé directement.

**Bannière de péremption.** Après une écriture de fichier, une fenêtre courte
existe pendant laquelle l'index n'a pas rattrapé. Les réponses portent alors
une bannière nommant les fichiers en attente — la lire et ouvrir le fichier
directement quand elle apparaît.

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
