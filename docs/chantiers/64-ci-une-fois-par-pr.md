# Chantier 64 : la CI une fois par PR, et le gate avant le push

| Champ | Valeur |
|---|---|
| État | **Révision 0, 24 novembre 2026.** Sujet « sortir de GitHub » de la note d'idéation de Julien du 17 novembre (§3 et §6.4), réduit par son arbitrage du 24 novembre : on garde GitHub, on réduit. |
| Emplacement final | `docs/chantiers/64-ci-une-fois-par-pr.md` sur `main` |
| Base | `main` |
| Organisation | Comme au 63 : cell-gestion gère le chantier, Codex CLI écrit, cell-gestion relit, lance le gate, commite et ouvre la PR. |
| Validation | Le gate est vert. Le merge se fait sur le oui de Julien, CI verte. **Un réglage GitHub est à faire par Julien avant le merge** (DM40). |

## 1. Pourquoi

La note voulait sortir de GitHub pour le coût et la lenteur des Actions. Mais aidboard est public, et ses Actions ne coûtent rien. Julien a donc tranché : on garde GitHub, et on évite les runs qui ne servent à rien.

Ce qu'on mesure du 17 au 24 novembre :
- **CI** : 47 runs, dont 30 sur `pull_request` et 17 sur `push` vers `main`.
- **App** : 15 runs, dont 9 sur PR et 6 sur `push`.

Un run de CI fait quatre jobs : le gate sous Node 22, le gate sous Node 24, le labo serveur et l'e2e, ce dernier en 35 minutes.

Le run sur `push` reteste, après le merge, un arbre que la PR a déjà testé, **sauf quand `main` a bougé entre le dernier run de la PR et le merge.** C'est arrivé avec #202 (« BEHIND »). Faute de protection sur `main`, ce run est aujourd'hui le seul filet dans ce cas.

## 2. Décisions

### DM39. Plus de CI sur `push` vers `main`

- `ci.yml` ne se déclenche plus que sur `pull_request`, et sur `workflow_dispatch` pour une relance à la main.
- `app.yml` garde son déclenchement actuel. Il ne tourne que sur `app/**`, et ses runs sur `main` servent la publication de l'app : on n'y touche pas dans ce chantier.

### DM40. Le filet devient la protection de `main`

- Retirer le run sur `push` n'est sûr que si `main` ne reçoit qu'un arbre déjà testé. C'est ce que garantit la protection de branche avec « Require branches to be up to date before merging » :
  - une PR en retard sur `main` doit être mise à jour, ce qui relance sa CI ;
  - l'arbre mergé est alors celui que la CI a testé.
- Les checks requis : `gate (node 22)`, `gate (node 24)`, `labo serveur` et `e2e`.
- **C'est un réglage du dépôt, pas du code.** Julien le fait, ou il dit oui pour que cell-gestion le fasse par `gh api`. Il précède le merge de ce chantier.
- Aucun push direct sur `main` : c'est déjà la règle (« ce qui part sur GitHub passe par une PR », §6.4 de la note). La protection n'oblige pas d'approbation, puisque Julien est seul à merger.

### DM41. Le gate avant le push, sur option

- `.githooks/pre-push` est un hook git, versionné et facultatif. Pour l'activer : `git config core.hooksPath .githooks`. Il n'est pas dans `scripts/git`, livré dans le paquet npm pour les scripts de sujets du daemon : un hook de développement d'aidboard n'a rien à faire chez un utilisateur.
- Il lance `npm run gate` quand on pousse une branche autre que `main` et que la poussée change autre chose que `docs/**` ou `*.md`. Il refuse la poussée si le gate échoue.
- `git push --no-verify` reste possible : c'est un raccourci, pas une garde. La garde, c'est la CI requise.
- Il ne lance pas l'e2e (35 minutes). Ce dernier reste en CI.
- La règle de cell-gestion ne change pas : le gate local passe avant chaque push, avec ou sans le hook.

## 3. Points

### 64.1 Le plan

Ce document, et une ligne dans `docs/chantiers/README.md`.

### 64.2 La CI et le hook (DM39, DM41)

Fait :
- `ci.yml` perd son déclenchement sur `push` et gagne `workflow_dispatch`. Son groupe de `concurrency` reste par ref.
- `.githooks/pre-push`, avec son test. Le test passe par un faux dépôt dans un répertoire temporaire et un faux `npm` dans le `PATH`. Il couvre :
  - une poussée de code, qui lance le gate ;
  - une poussée de docs seulement, qui ne le lance pas ;
  - une poussée sur `main`, qui ne le lance pas ;
  - un gate rouge, qui refuse la poussée.
- Une ligne pour activer le hook, dans la section du README qui parle du développement.

### 64.3 La protection (DM40)

C'est le réglage GitHub, après le oui de Julien. Il est relu par `gh api repos/<dépôt>/branches/main/protection`.

## 4. Pièges

- **Ne pas retirer le `push` sans la protection.** Sans elle, un merge d'une PR en retard sur `main` ne serait plus testé du tout.
- **Les noms des checks requis** doivent être exactement ceux des jobs (`gate (node 22)`…). Un nom qui ne correspond à aucun job bloque tout merge.
- **Le hook n'est pas une garde.** Personne ne doit compter sur lui pour la sécurité.

## 5. Fini quand

- Un merge sur `main` ne relance plus la CI.
- Une PR en retard sur `main` ne peut pas être mergée sans être mise à jour et repassée en CI.
- Le gate peut tourner automatiquement avant le push.
