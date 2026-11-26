# Chantier 61 : le moteur écrit la rétro, et propose les leçons

| Champ | Valeur |
|---|---|
| État | **Révision 0, 24 novembre 2026.** C'est le lot D de la note d'idéation de Julien du 17 novembre (la capture et l'extraction par le moteur), avec les recommandations R5 de l'analyse du 16 novembre (une rétro mécanique et le rattrapage des cycles passés). Avis du lab (DM 103453, Q6) : corriger `maintain.ts` plutôt que brancher `swarph dreaming`, pour qu'A-I-D tourne sans swarph. |
| Emplacement final | `docs/chantiers/61-retro-par-le-moteur.md` sur `main` |
| Base | `feat/60-memoire-liens` (PR #202), rebasée sur `main` après son merge |
| Organisation | Comme au 60. cell-gestion gère le chantier ; Codex CLI écrit le code et les tests de chaque point ; cell-gestion relit, lance le gate, commite et ouvre la PR. |
| Dépend de | 57 (l'entretien, les propositions, le modèle local), 60 (les liens `issu_de`, les pages closes). |
| Validation | Le gate est vert à chaque point, puis `gate:e2e`. Le chantier ne touche pas au contrat swarph. Merge sur le oui de Julien, CI verte. |

## 1. Pourquoi

La note du 17 novembre (§9.2) le dit : « la mémoire dépend de la discipline des agents, et elle ne tient pas ». Une seule phase capitalise, la rétro, et elle a tourné une fois sur dix-sept cycles. Le relevé du code du 24 novembre donne la cause :

1. **Rien ne lance la rétro.** Le daemon ne lance jamais d'agent avec un rôle de phase : tous sont `free` (`src/daemon/pty/manager.ts`). La boucle du noyau (`kernel/policy/orchestration.md`) ne cite pas la rétro.
2. **Un agent ne peut pas écrire de leçon.** L'écriture dans `lesson/` n'est permise qu'au rôle `retro`, qu'aucun chemin ne pose (`src/daemon/routes/memory.ts`). Seul l'admin le peut.
3. **Rien ne marque la fin d'un cycle.** Le sujet passe à `merged` (`topic.merge`), puis à `archived` (`topic.cleanup`), sans regarder si sa rétro existe. Seule la purge le fait (`aid mem purge --orphelines`).

## 2. Cible et hors-périmètre

**Cible.** À la fin d'un cycle, le daemon rédige lui-même la rétro avec le modèle local, à partir de ce que le cycle a laissé. Il en tire des leçons candidates. Rien n'est écrit sans décision : tout arrive en propositions, dans la section « Entretien de la mémoire » de la Boîte. Les cycles passés sans rétro sont rattrapés la nuit.

**Hors-périmètre.**
- Lire les journaux de terminal ou les conversations des agents (DM25).
- L'assemblage du contexte par rôle (lot E), l'auditeur et l'oubli (lot F).
- Lancer un agent avec un rôle de phase : c'est la boucle dans le daemon, un sujet de la note à part.
- Appliquer une leçon sans décision.

## 3. Décisions

### DM25. Les sources : les pages du cycle et les événements structurés, jamais le texte brut des terminaux

- Le récit d'un cycle est assemblé par le daemon, sans modèle, à partir de :
  - les pages `<ns>/plan/<slug>`, `<ns>/dev-handoff/<slug>` et `<ns>/review/<slug>`, où `<slug>` est celui du sujet (la convention déjà lue par Livraison et le panneau de contexte) ;
  - les pages mémoire écrites par les agents du sujet, retrouvées par les événements `memory.page` et `memory.decision` qui portent son `topicId` ;
  - les issues des actions du sujet (`action.finished` : test, merge, avec leur résultat), la durée du cycle (de la création au merge) et le nombre de reprises.
- **Ni les journaux de terminal, ni `agent_messages`, ni le texte des événements `agent.tool`, `agent.status` ou `approval.requested`.** Ils peuvent contenir des secrets (une ligne de commande avec un jeton), et aucun filtre ne s'y applique aujourd'hui.
- Le récit passe par `nettoyer` (`src/shared/nettoyage.ts`) avant tout envoi au modèle. Un récit refusé ne part pas : le sujet est noté « rétro à écrire à la main », avec la classe du refus, jamais le texte.
- Le modèle est le modèle local de l'entretien (`memory.maintenance.model`, par Ollama). Aucun appel à un modèle distant.

### DM26. Une proposition `retro` par cycle

- Un nouveau type de proposition, `retro`, qui demande la migration de la contrainte sur `memory_proposals.kind`. Son payload :
  - `retro` : une page `{ title, body }`, écrite à `<ns>/retro/<slug>` ;
  - `lecons` : de zéro à trois leçons `{ slug, title, frontmatter, body }`, chacune au format atomique de `kernel/policy/namespace.md` (une affirmation, quinze lignes au plus, `domaine`, `tags`, `entites`).
- Le code pose lui-même `cycle: <ns>/<slug>` et `liens.issu_de: [<ns>/retro/<slug>]` sur chaque leçon. Il garde seulement `domaine`, `tags`, `entites` et `title` du frontmatter rendu par le modèle, comme le découpage du 57 (DM13).
- Les slugs de leçon sont vérifiés à la création de la proposition (`lesson/<domaine>/<slug>`, libres). Un slug pris fait échouer l'application sans écriture partielle.
- **Appliquer** écrit la rétro, puis les leçons, en création seule, avec l'auteur `maintenance`. En cas d'échec, tout est annulé, comme le découpage.
- **Appliquer sans les leçons.** Le payload garde la liste, et l'écran permet de décocher une leçon avant d'appliquer. Une rétro peut donc être acceptée sans ses leçons.
- **Rejeter** laisse la proposition à l'état `rejected`, et rien n'est écrit dans les pages. Une proposition `retro` rejetée compte comme existante : elle ne revient pas pour ce cycle.
- Le modèle peut répondre « aucune leçon », et c'est la réponse normale d'un petit cycle. Une leçon qui reprend une leçon existante, trouvée par les vecteurs sous le seuil de doublon, est écartée avant la proposition.

### DM27. Quand : la nuit, le dernier cycle mergé d'abord

- **Pas de crochet au merge.** Le worker traite un job dès qu'il est enfilé. Un job posé au merge tournerait donc tout de suite, hors de la fenêtre de l'entretien, et en concurrence avec la machine de travail. C'est la passe de nuit qui enfile les jobs.
- **La passe de nuit.** Elle tourne dans la fenêtre et sous le plafond `maxPerNight`, qu'elle partage avec les jobs `maintain`. Elle prend les sujets `merged` ou `archived` qui n'ont ni rétro, ni proposition `retro`, ni note `seen`. Le dernier mergé passe en premier : un sujet mergé dans la journée reçoit sa proposition la nuit qui suit, et les cycles passés sont rattrapés ensuite. Les jobs `retro` sont enfilés avant les jobs `maintain`.
- Un sujet sans aucune page de cycle n'a pas de récit. Un récit refusé par le filtre ne part pas. Dans les deux cas, le sujet est noté une fois dans `memory_maintenance_seen`, avec le genre `retro`, la raison, et la classe s'il s'agit d'un refus. Il n'est plus repris ensuite.
- L'entretien éteint (`memory.maintenance.enabled: false`) ne crée aucun job `retro`. Le compteur reste visible (DM28).

### DM28. La rétro manquante se voit, elle ne bloque pas

- **Ce que veut la note :** un cycle n'est pas clos tant que sa rétro n'existe pas (R5). Ici, cela se dit et se compte, cela ne bloque ni le merge ni le nettoyage. Julien veut moins d'arrêts humains (note du 17 novembre, §10). Bloquer le nettoyage d'un sujet sur une proposition non décidée en ajouterait un.
- La santé de la mémoire gagne `retros: { manquantes, proposees }`.
- `aid mem purge --orphelines` liste déjà les cycles sans rétro, et ne change pas.
- La Boîte montre la proposition `retro` dans « Entretien de la mémoire », avec le récit résumé (le nombre de pages et d'actions lues), la rétro proposée et les leçons à cocher.

### DM29. Le rôle `retro` n'est pas corrigé ici

- Le droit d'écrire `lesson/` reste réservé au rôle `retro`. Lancer des agents avec un rôle de phase est un sujet de la boucle dans le daemon.
- Ici, les leçons passent par l'entretien (l'auteur `maintenance`, la décision de l'admin), qui a déjà ce droit.

## 4. Points

### 61.1 Le plan

Ce document, et une ligne dans `README.md`.

### 61.2 Le récit d'un cycle (DM25)

Une fonction pure, testée seule, qui assemble le récit d'un sujet à partir des pages et des événements, avec une taille bornée. Elle passe ensuite le récit par `nettoyer`.

Les tests couvrent :
- un cycle complet ;
- un cycle sans pages ;
- un événement `agent.tool` avec un faux jeton, qui n'entre jamais dans le récit ;
- un récit refusé par `nettoyer` ;
- la borne de taille.

- _Révision 61.2._ Fait : `src/daemon/memory/recit.ts`, avec `assembleCycleRecit`, qui lit en liste blanche `action.finished`, `agent.resumed` et `topic.state`, borne à 12 000 caractères et passe le récit par `nettoyer` avec les hôtes privés, et `loadCycleInput`. Gate 4 688.

### 61.3 La proposition `retro` (DM26)

La migration du type, le prompt, le schéma de la réponse, le filtre du frontmatter, l'écart des doublons, l'application et l'annulation, le rejet.

Les tests couvrent :
- une réponse sans leçon ;
- une réponse avec trois leçons ;
- une réponse invalide ;
- un slug pris ;
- l'application avec une leçon décochée ;
- un échec au milieu, rendu à l'identique ;
- le rejet qui ne revient pas.

- _Révision 61.3._ Fait :
  - la migration 038, qui ajoute `retro` aux trois contraintes ;
  - `src/daemon/memory/retro.ts` et `runRetroJob`, où le frontmatter est posé par le code et les tags filtrés au vocabulaire ;
  - l'écart des doublons, par slug et par la voisine vectorielle `lesson/` ouverte la plus proche (`nearestOpenLesson`) quand les vecteurs sont là ;
  - l'application avec `lecons` à garder, tout ou rien, et le rejet sans écriture ;
  - les décisions sur une même proposition, sérialisées ;
  - la clé `memory.maintenance.hotesPrives` ;
  - dans l'interface, seulement le libellé « Rétro » ; l'écran vient au 61.5.

  Gate 4 712.

### 61.4 La passe de nuit (DM27)

L'enfilage des jobs `retro` dans `scheduleMaintenance`, avec le plafond partagé.

Les tests couvrent :
- l'ordre, du dernier mergé au plus ancien ;
- les sujets écartés : ceux qui ont déjà une rétro, une proposition ou une note `seen`, et ceux qui ne sont ni mergés ni archivés ;
- le plafond partagé avec `maintain` ;
- l'entretien éteint, ou une heure hors de la fenêtre.

- _Révision 61.4._ Fait :
  - `retroCandidates`, paginée, qui prend le dernier sujet mergé d'abord, puis les archivés sans merge ;
  - le plafond `maxPerNight` partagé avec `maintain`, les rétros passant en premier ;
  - un sujet dont la rétro a échoué trois nuits (`RETRO_MAX_FAILED_NIGHTS`) n'est plus repris : sans cette borne, une réponse toujours invalide aurait pris une place chaque nuit sans fin.

  Gate 4 720.

### 61.5 La vue et la santé (DM28)

La proposition `retro` dans la Boîte, avec les leçons à cocher, et `retros` dans la santé et dans `aid doctor`. Un e2e clique « Appliquer » avec une leçon décochée, et clique « Rejeter », aux deux formats.

- _Révision 61.5._ Fait :
  - `retros { manquantes, proposees, abandonnees }` dans la santé, avec des prédicats SQL partagés avec la passe de nuit (`retro-queries.ts`). Un sujet abandonné (note `seen`, ou plafond d'échecs) ne compte plus comme manquant ;
  - la ligne « Rétros » d'`aid doctor`, en avertissement s'il reste des rétros à écrire à la main ;
  - la carte de la Boîte : les sources, la rétro en texte, les leçons cochées par défaut et dépliables ;
  - l'e2e, qui applique avec une leçon décochée et rejette, à 390 et 1 280 px.

  Gate 4 723, `gate:e2e` 191.

### 61.6 Le noyau et la fiche de recette

- `kernel/policy/phases.md` dit que le daemon rédige la rétro si personne ne l'a fait.
- `kernel/roles/retro.md` dit qu'une rétro écrite par un agent passe avant celle du moteur.
- La fiche `docs/recette-chantier-61-retro-moteur.md` se fait sur la tour, avec Ollama : un vrai cycle mergé, puis la proposition du matin.

- _Révision 61.6._ Fait :
  - `phases.md` décrit le filet de nuit, `retro.md` fixe le slug du sujet, et le changelog est à jour. Les blocs rendus sont inchangés, faute de partie touchée ;
  - une ligne de journal « rétro de … non proposée : <raison> » donne la classe d'un refus, jamais le texte ;
  - la fiche de recette contient huit contrôles.

  Gate 4 723.

## 5. Pièges

- **Le récit n'est pas un journal.** Il ne contient que des pages déjà écrites en mémoire et des faits structurés. Y ajouter « juste un extrait » de terminal fait entrer des secrets dans un fichier poussé vers le miroir.
- **Le modèle local est petit.** Le prompt demande peu : une rétro de quinze lignes au plus et trois leçons au plus. Une réponse vide de leçons est normale.
- **Le slug de la rétro suit le sujet**, pas un nom choisi par le modèle.

## 6. Fini quand

- Un sujet mergé sans rétro reçoit une proposition `retro` dans la nuit qui suit.
- Appliquer écrit la rétro et les leçons cochées, tout ou rien. Rejeter ne revient pas.
- Aucun texte de terminal ni de conversation n'est envoyé au modèle.
- Les cycles passés sans rétro sont rattrapés sous le plafond de la nuit.
- La santé compte les rétros manquantes et proposées.
