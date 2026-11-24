# Chantier 62 : des faits candidats en mémoire quelques minutes après un handoff

| Champ | Valeur |
|---|---|
| État | **Révision 0, 24 novembre 2026.** C'est la seconde partie du lot D de la note d'idéation du 17 novembre (§9.3, §11.3, §12.2). Julien a arbitré le 24 novembre : une extraction a lieu aussi en journée, à chaque dev-handoff ou review, et les journaux de terminal ne sont jamais lus. |
| Emplacement final | `docs/chantiers/62-faits-en-journee.md` sur `main` |
| Base | `feat/61-retro-moteur` (PR #205), rebasée sur `main` après les merges de #202 et #205 |
| Organisation | Comme au 61. cell-gestion gère le chantier, Codex CLI écrit le code et les tests, et cell-gestion relit, lance le gate, commite et ouvre la PR. |
| Dépend de | 57 (le modèle local), 60 (`liens`, `issu_de`), 61 (le récit filtré, la rétro de nuit). |
| Validation | Le gate est vert à chaque point, puis `gate:e2e`. Merge sur le oui de Julien, CI verte. |

## 1. Pourquoi

La note veut qu'un fait appris pendant un sujet soit en mémoire **pendant** le sujet. Elle le dit ainsi : « ce qu'un agent apprend à la minute dix est lisible par un autre à la minute quinze » (§13.1). Le chantier 61 n'extrait qu'à la fin du cycle, la nuit, et en propositions : un autre agent ne voit rien avant la décision de l'admin.

La grille du §9.1 nomme aussi l'écart du contrat MCP : « `memory_put` ne distingue pas un fait candidat d'un fait établi ».

## 2. Cible et hors-périmètre

**Cible.** Quelques minutes après l'écriture d'un dev-handoff ou d'une review par un agent, le daemon en tire des faits candidats avec le modèle local. Il les écrit en mémoire, marqués `statut: candidat`. Un autre agent les trouve par `memory_search`, signalés comme candidats. La rétro de nuit (61) les lit et propose d'en promouvoir en leçons.

**Hors-périmètre.**
- Les journaux de terminal et les conversations des agents. Ils ne sont jamais lus (arbitrage du 24 novembre).
- Écrire dans `lesson/` sans décision. Un fait candidat ne quitte jamais le namespace du projet.
- L'assemblage du contexte par rôle (lot E).

## 3. Décisions

### DM30. Le déclencheur : un handoff ou une review écrit par un agent, après un délai

- Un événement `memory.page` déclenche l'extraction si trois conditions sont réunies :
  - son opération est une écriture, et non une suppression ;
  - son slug est `<ns>/dev-handoff/<task>` ou `<ns>/review/<task>` ;
  - son auteur est un run (`run:…`). Les écritures de l'admin, de l'import, du reindex et de l'entretien ne déclenchent rien.
- Il enfile un job `faits` sur le slug de la page, à exécuter après `memory.capture.delayMinutes` (5 par défaut).
  - Une nouvelle écriture de la même page avant ce délai le repousse. Un agent qui écrit son handoff en trois `--append` ne déclenche donc qu'une extraction.
- Le plafond `memory.capture.maxPerDay` (30 par défaut) compte les jobs `faits` créés depuis minuit, heure locale. Au-delà, rien n'est enfilé ; le compteur le montre (DM34).
- La capture est éteinte par défaut (`memory.capture.enabled: false`). Allumée, elle tourne à toute heure. Elle est indépendante de la fenêtre et du plafond de nuit de l'entretien. Elle demande le modèle de l'entretien (`memory.maintenance.model`) et Ollama.

### DM31. La source : la seule page déclenchante, filtrée

- Le job relit la page au moment de son exécution, à sa révision courante. Il passe son corps par `nettoyer`, avec `memory.maintenance.hotesPrives`.
  - Un corps refusé ne part pas. Le journal du daemon note la classe du refus, jamais le texte, et le job se termine sans écrire.
- Le prompt reçoit le corps de la page et les titres des faits candidats déjà écrits pour cette tâche. Il demande au plus trois faits **nouveaux**, chacun une seule affirmation de 8 lignes au plus. « Aucun fait » est une réponse normale.

### DM32. Le fait candidat est écrit sans décision, dans le namespace du projet

- Slug : `<ns>/fait/<task>.<slug>`, où le slug est un segment rendu par le modèle et vérifié. Un slug déjà pris est écarté. Une tâche garde au plus 10 faits candidats.
- Le frontmatter est posé par le code :
  - `statut: candidat` ;
  - `title` ;
  - `cycle: <ns>/<task>` ;
  - `liens: { issu_de: [<slug de la page source>] }`.
- L'auteur est `maintenance`. L'écriture porte le `topicId` et le `runId` de l'événement source, pour que le récit de la rétro (61) retrouve ces pages.
- **Pourquoi sans décision :** un fait en proposition n'est lu par aucun agent, et c'est l'écart que ce chantier ferme. Trois choses bornent le risque :
  - le namespace du projet, jamais `lesson/` ;
  - le marquage `statut: candidat` ;
  - le filtre de secrets en amont.

  La purge des pages du cycle emporte ces faits.

### DM33. Ce que voient les agents

- `memory_search` et `aid mem search` signalent un fait candidat : `candidat: true` sur le résultat, et « (candidat) » dans le texte.
- La description de l'outil MCP dit qu'un fait candidat n'est pas établi. Il se vérifie avant de s'appuyer dessus.
- Le récit de la rétro (61) inclut les faits candidats de la tâche. Le prompt de la rétro demande lesquels méritent de devenir des leçons. La promotion reste une proposition, décidée par l'admin.
- `aid mem purge` traite `<ns>/fait/<task>.*` comme une page du cycle `<task>`.

### DM34. La santé

`faits { candidats, aujourdhui, plafond }` dans la santé, et une ligne « Faits candidats » dans `aid doctor`.

## 4. Points

### 62.1 Le plan

Ce document et une ligne dans `docs/chantiers/README.md`.

### 62.2 La config et le déclencheur (DM30)

Les points de ce chantier :
- `memory.capture` dans la config ;
- le genre de job `faits`, qui demande une migration ;
- l'abonnement aux événements `memory.page` ;
- le délai repoussé à chaque écriture ;
- le plafond du jour.

Les tests couvrent :
- un handoff écrit par un run, qui enfile un job ;
- trois écritures rapprochées, qui n'enfilent qu'un job, au délai repoussé ;
- une écriture de l'admin, qui n'enfile rien ;
- une page `plan/`, qui n'enfile rien ;
- le plafond ;
- la capture éteinte.

- _Révision 62.2._ Fait :
  - `memory.capture` (`enabled`, `delayMinutes`, `maxPerDay`) ;
  - la migration 039 ;
  - `MemoryJobs.enqueueAfter`, qui repousse le délai d'un job en attente ;
  - `src/daemon/memory/capture.ts`, abonné aux événements, qui ne réagit qu'aux écritures d'un run sur `dev-handoff` ou `review`, avec un plafond du jour qui laisse passer les reports ;
  - le worker passe les jobs `faits` à `deps.faits`.

  Gate 4 748.

### 62.3 Le job et l'écriture (DM31, DM32)

Les tests couvrent :
- une réponse sans fait ;
- une réponse avec trois faits, dont le frontmatter est posé par le code ;
- un slug pris ;
- la limite de 10 faits par tâche ;
- un corps refusé par le filtre, où rien n'est écrit et où le texte n'est ni en base ni dans le journal ;
- une réponse invalide, que le job réessaie.

### 62.4 La lecture (DM33)

Les points couverts sont :
- `candidat` dans la recherche, le CLI et le MCP ;
- les faits dans le récit de la rétro, et le prompt de la rétro ;
- la purge.

### 62.5 La santé, le noyau et la fiche (DM34)

Ce point couvre :
- la santé et `aid doctor` ;
- `kernel/policy/namespace.md`, qui reçoit `<ns>/fait/<task>.<slug>` et `statut: candidat` ;
- `kernel/adapters/aid.md`, avec les blocs rendus s'ils changent ;
- le changelog du noyau ;
- `docs/recette-chantier-62-faits-en-journee.md`, à faire sur la tour avec Ollama : un vrai handoff, puis un fait candidat lisible par un second agent cinq minutes plus tard.

## 5. Pièges

- **Un fait candidat n'est pas une leçon.** S'il glisse vers `lesson/` sans décision, la mémoire transverse se remplit de bruit.
- **Le délai doit être repoussé, pas cumulé.** Un handoff écrit en dix `--append` ne doit pas coûter dix appels au modèle.
- **La page source change entre l'événement et le job.** Le job lit la révision courante, jamais celle de l'événement.

## 6. Fini quand

- Un handoff écrit par un agent donne, quelques minutes plus tard, des faits candidats trouvables par un autre agent et signalés comme tels.
- Aucun texte de terminal ni de conversation n'est envoyé au modèle. Un corps refusé ne part pas.
- La rétro de nuit lit ces faits et peut proposer de les promouvoir.
- Le plafond du jour tient, et la santé le montre.
