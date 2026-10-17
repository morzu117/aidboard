# Entrer au banc `structural_index`

Ce document dit ce qu'un second adaptateur (Kivgraph, ou autre) doit fournir pour se
brancher derrière `StructuralService` (`src/daemon/structural/service.ts`), sans toucher
aux routes HTTP, aux outils MCP `index_*` ni à `CarteSujet` — c'est tout l'intérêt du
contrat posé par le chantier 08 (`docs/chantiers/08-index-structurel.md`, DS1). codegraph
en est la première implémentation (`src/daemon/structural/codegraph.ts`) ; elle sert de
référence, pas de modèle à copier bit à bit.

## Le contrat minimal

Un adaptateur implémente `StructuralIndex` (`src/daemon/structural/types.ts`). Pour entrer
au banc, quatre méthodes suffisent :

- `detect(root)` — `.codegraph/` existe-t-il (ou l'équivalent du moteur) à cette racine ?
  Décide `indexing` vs `disabled` à la création d'un sujet (D6).
- `init(root, log)` — lance la construction initiale, en sous-process, sortie vers le
  descripteur `log` fourni. Le daemon ne l'attend pas : il suit l'événement `topic.state`
  que l'`Indexer` publie à la fin.
- `status(root)` — l'état relu en direct (DS7) : `ready | indexing | stale | unavailable`,
  `indexedAt`, `files`, `symbols`, `languages`, `pending` (fichiers modifiés depuis
  `indexedAt`), `engineVersion`, `builtWith`, `capabilities`. Jamais stocké, jamais plus de
  30 s de cache par chemin côté service.
- `explore(root, query, opts?)` — `{ text }`, un texte libre. Pas de JSON à inventer : si le
  moteur n'a qu'un rendu texte (comme `codegraph explore`), c'est le contrat lui-même (DS6),
  pas une limite temporaire de l'adaptateur.

Un adaptateur qui ne fait que ces quatre-là est utilisable : `index_status` et
`index_explore` fonctionnent, le reste dégrade proprement (section suivante).

## Capacités optionnelles

`symbols`, `callers`, `impact`, `affected` sont les méthodes restantes du contrat. Un moteur
qui ne les a pas ne les implémente pas à moitié : il les **déclare absentes** dans
`IndexStatus.capabilities` (`Capability[]`, valeurs `explore | symbols | callers | impact |
affected | types`) et lève `StructuralUnavailable` s'il est appelé quand même. La route et
l'outil MCP correspondants rendent alors la dégradation déclarative habituelle (DS4), jamais
une erreur 500 ni un `isError` différent selon la capacité manquante.

`types` est réservée à un moteur fondé sur un type-checker (résolution exacte, pas
tree-sitter) — aucun adaptateur ne la déclare aujourd'hui.

## Provenance (DS3)

Toute `Relation` rendue par `callers`/`impact` porte `provenance: 'exact' | 'candidate' |
'heuristic'`, posée par l'adaptateur lui-même :

- `exact` — résolution par type-checker ou équivalent garanti. Aucun moteur actuel ne le
  rend ; c'est ce qu'un banc Kivgraph viserait à démontrer.
- `candidate` — lu dans l'arbre syntaxique (tree-sitter) : appels, imports, héritage. C'est
  ce que rend codegraph partout aujourd'hui, y compris pour les homonymes fusionnés dans
  `callers`.
- `heuristic` — synthétisé par convention plutôt que lu (ex. lien client HTTP → nœud
  `route`, résolution par nom quand le symbole est ambigu).

Un adaptateur qui ne peut pas distinguer ses propres relations rend tout en `candidate` au
pire, jamais `exact` par confort.

## Dégradation (DS4)

Binaire absent, délai dépassé, sortie illisible, index non initialisé : tout converge vers
`status.state = 'unavailable'` avec un `reason` lisible, jamais une exception qui remonte.
`StructuralUnavailable` (`src/shared/structural.ts`) est la seule façon de signaler un échec
depuis une méthode autre que `status` — le service, les routes et les outils MCP la
convertissent chacun dans leur registre (503, `isError`), sans jamais connaître la cause
réelle (DS4 : le daemon ne tombe jamais à cause du moteur).

## Métrique du banc

Un candidat au banc ne se juge pas sur les tokens consommés par réponse (`explore` rend déjà
un texte libre, pas une réponse de modèle — DS8, pas de modèle sur le chemin de requête) : il
se juge sur le **coût à tâche terminée**. Concrètement, sur un jeu de tâches réelles
(plan → impact, dev → explore, review → affected, rejoué sur un sujet klasso) : temps total
agent compris, nombre d'allers-retours avant une réponse utilisable, et angles morts mesurés
(aujourd'hui pour codegraph : pas d'arête `prisma.<modèle>.<op>`, chaîne HTTP partielle,
homonymes fusionnés — voir le chantier 08 §5). Un moteur plus lent par appel mais qui évite un
aller-retour supplémentaire gagne au banc ; un moteur qui rend plus de JSON ne gagne rien si
l'agent doit relire le code pour trancher quand même.

## Brancher un adaptateur

Un adaptateur se sélectionne par `config.structural.engine` (`'codegraph' | 'off'`, bientôt
`'kivgraph'` au banc) — jamais par un import direct dans une route, un outil MCP ou
`CarteSujet.tsx` : tous ne connaissent que `StructuralService`. Ajouter un moteur, c'est
ajouter une valeur à `IndexEngine` (`src/shared/structural.ts`), une classe qui implémente
`StructuralIndex`, et son branchement dans le constructeur de `StructuralService` — rien
d'autre à toucher pour que `index_*`, `/api/structural/*` et le board le servent.
