# Recette des onglets Git / Fichiers

Grille du plan 11, point 11.12. Suit l'export `design/aid-export-git-flow/` écran par
écran, de 3.1 à 3.6. Contrairement à la v0.3 (`recette-v0.3.md`), ce chantier n'appelle
aucun service externe (pas de `gh`) — les actions git (fetch, push, changer de branche,
rattacher) sont exercées contre de vrais dépôts locaux dans `test/`, avec le vrai binaire
`git`, jamais un faux. Ce qu'aucune session automatisée ne peut vérifier, c'est le rendu
visuel dans un vrai navigateur : le graphe de commits (voies, nœuds, WIP en pointillé),
la visionneuse Markdown (blocs, sommaire, cases à cocher), la couche flottante du
sélecteur de branche, et le bandeau de dérive — tout cela demande un sujet réel ouvert à
l'écran sur le poste de recette. Les lignes « couverture automatique » listent ce que
`npm run gate` vérifie déjà sur le même chemin.

## Préalable

- [ ] Un sujet A-I-D actif, avec quelques commits sur sa branche, une branche extraite
  dans un second worktree (pour les cas « branche déjà prise ailleurs »), et au moins un
  fichier `.md` modifié non commité (pour l'explorateur et la visionneuse).
- [x] `aid doctor` n'a aucune dépendance propre à ce chantier à vérifier (aucun nouveau
  binaire externe requis — pas de `gh`, pas de Shiki/Monaco, D31).

## Poste : macOS (M5)

- [ ] 3.1 Onglet Agents : barre d'onglets `agents/git/fichiers` au-dessus de la zone de
  contenu, `agents` sélectionné par défaut, comportement des terminaux inchangé ; changer
  d'onglet puis revenir ne perd pas l'agent sélectionné, l'URL reflète l'onglet actif —
  couverture automatique : `test/web/sujet.test.tsx`
- [ ] 3.2 Onglet Git : graphe (voies, nœuds, commit WIP en pointillé, commits absents de
  HEAD en opacité réduite), liste des commits, panneau de détail au clic (fichiers
  modifiés, stat, parents, refs), filtre, portée, recherche, « Voir la base », fetch et
  push (le bouton Pousser désactivé sans avance) — couverture automatique :
  `test/git-log.test.ts` (forme des commits et `onTopicBranch` côté backend),
  `test/topic-fetch.test.ts`, `test/topic-push.test.ts` (fetch/push) ; **aucune couverture
  automatique du rendu du graphe, du panneau de détail, du filtre, de la portée ou de la
  recherche côté UI** — `OngletGit.tsx` n'a pas de fichier de test dédié, seul le
  placement de l'onglet est vérifié (voir 3.1). À dérouler en navigateur en priorité.
- [ ] 3.3 Changer de branche : couche flottante ancrée sous l'en-tête, filtre, groupes
  (branche du sujet / liées / autres), confirmation avec commande affichée avant le
  changement effectif, branche déjà extraite ailleurs non activable (`aria-disabled`,
  visible mais grisée) — couverture automatique : `test/topic-switch.test.ts` (backend :
  chemin heureux, refus sur dirty, `stash`, 409 branche prise ailleurs, `branche.creer` /
  `branche.creer-ici`), `test/git-branches.test.ts` (liste des branches), `test/web/
  selecteur-branche.test.tsx` (chemin heureux, refus non commité + stash, branche prise
  ailleurs, filtre sans correspondance). **Pas câblé côté UI** : créer une branche (ici ou
  depuis la base) n'a aucun bouton dans `SelecteurBranche.tsx` — seul le backend (11.5)
  existe ; voir « Points ouverts ».
- [ ] 3.4 Onglet Fichiers : explorateur (arbre + badges de statut), filtre tout/modifiés,
  rafraîchir, compteur, visionneuse Markdown (blocs typés, cases à cocher, bloc de code
  avec Copier, sommaire des H2), fil d'Ariane, copier le chemin, mentionner à l'agent,
  ouvrir dans l'éditeur — couverture automatique : `test/topic-files.test.ts` (arbre +
  statut, portée, traversée `../` rejetée, binaire rejeté, fichier supprimé en cours de
  lecture), `test/web/visionneuse-markdown.test.tsx` (rendu des tokens, sommaire, cases à
  cocher, code + tableau, liens, portée/filtre/état vide, mentionner à l'agent). **Pas
  câblé** : « révéler dans le Finder » (`fichier.reveler`) n'a aucun contrat backend dans
  ce chantier (documenté dans `OngletFichiers.tsx`) ; voir « Points ouverts ».
- [ ] 3.5 Fichier en source : numéros de ligne, police monospace, bascule aperçu/source
  visible seulement pour un `.md`, tout autre fichier en source directe, état fichier vide
  et état erreur (binaire/trop gros) — couverture automatique :
  `test/web/visionneuse-source.test.tsx`
- [ ] 3.6 Bandeau de dérive : branche différente ou HEAD détachée, « Revenir » (et sa
  variante « mettre de côté et revenir » sur refus non commité), « Rattacher » (absent en
  HEAD détachée) — couverture automatique : `test/topic-rattacher.test.ts` (backend :
  `onTopicBranch`/`headBranch`, `sujet.rattacher-branche`, `branche.revenir` chemin
  heureux + 409 branche prise ailleurs + 409 worktree manquant), `test/web/sujet.test.tsx`
  (bandeau affiché selon la dérive, les deux actions, absence de « Rattacher » en HEAD
  détachée)
- [ ] Un même sujet traverse les trois onglets sans recharger la page, du graphe (3.2)
  jusqu'au bandeau de dérive (3.6) si son worktree dérive entre-temps

## Ce que la recette a révélé (corrigé)

Aucun parcours manuel en navigateur n'a été mené cette session (pas d'accès à un poste
macOS avec affichage depuis cet environnement d'exécution). Contrairement à la recette
v0.3, piloter le démon en HTTP direct n'aurait rien ajouté ici : ce chantier n'appelle
aucun service externe à simuler (pas de `gh`), et les actions git sont déjà exercées
contre un vrai `git` par les tests listés ci-dessus — le seul écart réel entre « testé » et
« vérifié » porte sur le rendu visuel (3.2 à 3.6), qu'une requête HTTP ne peut pas juger.
Un humain doit dérouler la grille ci-dessus en navigateur ; les trois lacunes trouvées
pendant le développement (11.3, 11.6, 11.8 — voir « Points ouverts ») l'ont été par lecture
du code, pas par un essai manuel, et restent donc à confirmer visuellement elles aussi.

## Points ouverts pour la suite

- **Onglet Git (3.2) sans test UI dédié** : `OngletGit.tsx` (graphe, panneau de détail,
  filtre, portée, recherche) n'est exercé par aucun test au-delà du placement de l'onglet
  (`test/web/sujet.test.tsx`). C'est l'écran le plus complexe de l'export (algorithme de
  voies du graphe, D24) et celui qui a le moins de garde-fou automatique — à traiter en
  priorité lors du parcours manuel, et candidat naturel à un futur
  `test/web/onglet-git.test.tsx` si ce chantier est repris.
- **Créer une branche non câblé côté UI (3.3)** : le backend (`branche.creer`,
  `branche.creer-ici`, 11.5) existe et est testé, mais `SelecteurBranche.tsx` n'offre
  aucun bouton pour le déclencher — décision de périmètre prise au point 11.10 (reclassé
  comme gap pré-existant, pas comme un oubli de ce point).
- **`branche.recreer` sans contrat backend (3.3)** : une branche du sujet déjà extraite
  ailleurs propose, dans l'export, de la « recréer » ; faute de contrat backend dans ce
  chantier, l'UI mène plutôt vers le sujet propriétaire quand il est connu (repli
  documenté dans `SelecteurBranche.tsx`, pas une action manquante silencieuse).
- **`fichier.reveler` sans contrat backend (3.4)** : « révéler dans le Finder/Explorer »
  n'a de contrat ni en 11.7 ni en 11.11 ; omis plutôt que fabriqué (documenté dans
  `OngletFichiers.tsx`), à la différence de « mentionner à l'agent » qui réutilise
  `POST /api/agents/:id/input`, déjà existant.
- Aucun écran e2e Playwright (`e2e/`) dédié à ce chantier n'existe à ce jour — la grille
  manuelle ci-dessus et les tests listés par point restent le seul filet pour 3.1 à 3.6.
