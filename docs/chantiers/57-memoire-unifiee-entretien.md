# Chantier 57 : une seule mémoire, sans gbrain, avec un entretien sûr

| Champ | Valeur |
|---|---|
| État | **Révision 0, 16 novembre 2026.** D'après l'analyse du 16 novembre (lecture de `src/daemon/memory/`, relevé de `~/.aid` sur le poste Windows/WSL) et le choix de Julien du même jour : gbrain est retiré. À relire avant tout dev. |
| Emplacement final | `docs/chantiers/57-memoire-unifiee-entretien.md` sur `main` |
| Base | `main` (`e0191c2`, v0.7.2). |
| Numéro | 57 : le 56 est pris par la branche `feat/56-tests-interfaces`. |
| Dépend de | 06 (mémoire locale), 09 (noyau dans `kernel/`), 10 (décommission de gbrain, clos sur le Mac le 17 octobre). |
| Validation | Gate vert à chaque point. Les gestes machine du 57.3 et l'activation du 57.12 se font sur place, par Julien ou avec son accord explicite. |
| Rayon d'impact | **Non établi.** L'index structurel (`index_*`) ne répondait pas dans la session qui a écrit ce plan : les fichiers ont été lus directement. À établir par `index_impact` sur `MemoryMirror`, `scheduleMaintenance`, `runMaintainJob` et `applyProposal` avant le 57.4. |

**Révision — 2026-11-20** — Les propositions des leçons sont visibles dans la Boîte, où elles peuvent être décidées, et listées par `aid mem proposals`.

## 1. Pourquoi

La mémoire est la seule couche de la chaîne censée s'accumuler. Aujourd'hui elle ne le peut pas, pour trois raisons.

1. **Elle est éclatée.** Chaque machine a son miroir `~/.aid/memory`, que rien ne synchronise. Et sur le poste Windows, gbrain est encore installé, avec des pages qui n'ont jamais été récupérées.
2. **Les agents sont encore envoyés vers gbrain.** `CLAUDE.md` et `AGENTS.md` nomment `gbrain search` et `gbrain put`. Une phase qui suit le bloc écrit au mauvais endroit.
3. **L'entretien automatique n'est pas activable.** Il est codé (chantier 06.10), désactivé par défaut, et il a quatre défauts dont un qui peut écraser des pages.

## 2. État actuel

Relevé le 16 novembre 2026.

**Le dépôt**

- `CLAUDE.md` se dit « rendu depuis agent-kernel 0.7.1 » et `agent.yml` épingle `kernel.version: "0.7.1"`. Son bloc `memory` est l'adaptateur gbrain. Or le noyau vit dans `kernel/` depuis le chantier 09, et son adaptateur mémoire est `kernel/adapters/aid.md` (`aid mem …`).
- `kernel/adapters/gbrain.md` existe toujours dans le dépôt. Le chantier 10.5 l'avait supprimé dans l'ancien dépôt `agent-kernel` ; le rapatriement du 09.1 l'a ramené.
- `agent.yml` cite encore `.gbrain-source` en commentaire.

**Le poste Windows**

- `gbrain` 0.48.1 est dans le `PATH` (`~/.bun/bin/gbrain`), avec une base locale `~/.gbrain/brain.pglite`. Le chantier 10 a été exécuté sur le Mac ; ce poste n'a pas été traité.
- Sources locales : `lessons` 38 pages, `projet-b` 99, `projet-b-board` 46, `swairm` 22, `projet-a` 3. **`projet-b` et `projet-b-board` ne figurent pas dans le chantier 10** : elles n'ont jamais été triées.
- `~/.aid` est dans WSL (Ubuntu). Le miroir mémoire a 13 pages, toutes sous `aid/`, aucune leçon, 18 commits depuis le 12 novembre. Aucun job, aucune proposition, aucun vecteur : Ollama est injoignable depuis WSL.

**Le code de la mémoire**

- Le miroir sait pousser (`memory.git.push`, faux par défaut) mais ne tire jamais (`src/daemon/memory/mirror.ts`, `pushIfConfigured`).
- L'entretien (`src/daemon/memory/maintain.ts`) :
  - **découpage** : `applyProposal` écrit chaque page proposée en mode `force`, sous un slug choisi par le modèle, sans vérifier qu'il est libre ni qu'il est sous `lesson/` ;
  - **doublons** : `runDuplicate` envoie la page seule, alors que le prompt parle des « leçons les plus proches » ; le schéma `DuplicatePayload` exige un `duplicateOf` non vide ; le slug rendu n'est pas vérifié ; toute leçon est éligible ;
  - **budget** : `scheduleMaintenance` plafonne à 20 jobs par appel, et `main.ts` l'appelle toutes les 15 minutes dans la fenêtre, soit jusqu'à 320 jobs par nuit ;
  - **périmètre** : toute page sans tags est éligible aux tags, quel que soit son namespace, et `store.all()` rend les pages par ordre de slug, donc `aid/…` avant `lesson/…`.
- Les vecteurs : `hybridOn` est décidé une fois au démarrage, et `onWrite` n'enfile aucun job d'embedding quand il est faux. Une page écrite pendant qu'Ollama est arrêté n'a jamais de vecteur, sauf `reindex` manuel.
- Rien ne purge les pages cycliques, rien ne journalise les recherches ni les lectures.

Les chiffres de l'analyse du 16 novembre sur un miroir de 431 pages (76 leçons, 169 pages cycliques) viennent d'une autre machine et n'ont pas été revérifiés ici.

## 3. Cible et hors-périmètre

**Cible**

- gbrain n'existe plus : ni dans le dépôt, ni sur le poste Windows, après récupération de ce qu'il contient.
- Les blocs rendus (`CLAUDE.md`, `AGENTS.md`) nomment `aid mem`.
- Un seul miroir mémoire, partagé entre les machines par un dépôt distant.
- L'entretien ne peut plus rien détruire, ne propose que sur les leçons, respecte un vrai plafond, et peut être activé.
- Les pages cycliques dont la rétro existe sont purgées, et l'usage de la mémoire est mesuré.

**Hors périmètre**

- Les liens typés entre pages (`precise`, `contredit`, `remplace`, `issu_de`).
- La rétro de rattrapage des cycles passés par un modèle distant.
- L'index structurel (`reindexRecommended`, checkpoint du WAL) : un chantier à part.
- Tout modèle distant dans l'entretien : ce chantier reste sur Ollama.

## 4. Décisions

### DM10. gbrain est retiré, après triage

- Rien n'est supprimé avant d'être sauvegardé : la base locale est exportée en entier sous `~/.aid/backups/gbrain-<date>/` avant tout triage.
- Le triage suit la règle du chantier 10 : ce qui est dérivable d'un dépôt git est écarté, ce qui est une page de cycle ou une leçon est importé par `aid mem import`, qui n'écrase jamais l'existant.
- Les 38 pages de `lessons` sont comparées aux leçons d'`aid mem` : le chantier 10 les avait trouvées redondantes sur le Mac, à un slug près. Le même contrôle est refait ici, page à page.
- `projet-b` et `projet-b-board` sont triées pour la première fois. Leur namespace cible est à confirmer (§8).
- Le retrait (`bun remove -g gbrain`, suppression de `~/.gbrain`) vient en dernier, sur l'accord de Julien, une fois l'import vérifié.

### DM11. Les blocs rendus viennent du noyau du dépôt

- `agent.yml` n'épingle plus un noyau externe en 0.7.1 : il suit `kernel/`.
- `CLAUDE.md` et `AGENTS.md` sont re-rendus par `/sync`, jamais édités à la main. Leur section `memory` devient celle de `kernel/adapters/aid.md`.
- `kernel/adapters/gbrain.md` est supprimé. Un test de garde refuse le mot `gbrain` dans le dépôt hors `docs/chantiers/`, `kernel/CHANGELOG.md` et `brief.md`.

**Complément (décision de l'orchestrateur, 2026-11-19) :** chemins admis : `docs/chantiers/`, `docs/recette-chantier-*.md`, `design/`, `kernel/CHANGELOG.md`, `brief.md` et `test/sans-gbrain.test.ts`. La garde cherche `gbrain` en minuscules, avec une comparaison sensible à la casse : un nom de variable d'environnement en majuscules n'est pas une prescription d'outil.

### DM12. Un miroir, un distant, et il tire

- Quand `memory.git.push` est vrai et qu'un `origin` existe, le miroir **tire avant de pousser** et **au démarrage** : `fetch`, puis avance rapide.
- Si l'avance rapide est impossible, le miroir fait un `rebase`. Deux machines qui écrivent des pages différentes ne se gênent pas : une page est un fichier.
- Un vrai conflit (la même page modifiée des deux côtés) arrête la synchronisation, garde les deux versions (`<slug>.md` et `<slug>.conflit-<machine>.md`), et le signale dans `aid doctor` et dans la santé mémoire. Il ne se résout jamais seul.
- Après un tirage qui change des fichiers, les pages touchées sont relues dans la base (pas un `reindex` complet).
- Le distant est un dépôt privé. Son emplacement est à confirmer (§8).

### DM13. Le découpage ne peut rien écraser

- Chaque page proposée est écrite en mode `create`. Un slug déjà pris fait échouer l'application de la proposition, sans écriture partielle : les slugs sont tous vérifiés avant la première écriture.
- Un slug proposé hors de `lesson/` est refusé dès la création de la proposition.
- Le `frontmatter` rendu par le modèle est filtré : seuls `tags` et `title` sont gardés. `issu_de: <slug d'origine>` est posé par le code.

### DM14. Les doublons se cherchent par paires

- Les candidats viennent des vecteurs : les 3 leçons les plus proches, sous un seuil de distance. Sans vecteurs, il n'y a pas de recherche de doublons.
- Le modèle reçoit la leçon et **un** candidat, et répond `{ "doublon": true | false, "rationale": "…" }`. La réponse « non » est la réponse normale.
- Une proposition n'est créée que sur un « oui », et `duplicateOf` est le slug du candidat, jamais un texte du modèle.
- Une paire déjà jugée n'est pas rejugée tant qu'aucune des deux pages n'a changé de révision.

### DM15. L'entretien ne touche qu'aux leçons, sous un vrai plafond

- Les trois tâches ne s'appliquent qu'au namespace `lesson`. Les pages cycliques sont destinées à la purge : les taguer gaspille le budget.
- Le plafond est par nuit : `scheduleMaintenance` compte les jobs `maintain` créés depuis le début de la fenêtre courante. `memory.maintenance.maxPerNight`, 20 par défaut.
- Le seuil de découpage passe de 15 à 40 lignes non vides, réglable (`memory.maintenance.splitLines`). Le drapeau `a_decouper: true` reste prioritaire.
- Les tags sont pris dans un vocabulaire fermé : les tags déjà présents dans `lesson/`. Un tag hors vocabulaire fait échouer la proposition. Le vocabulaire s'étend à la main.

**Complément (décision de l'orchestrateur, 2026-11-18).** La table locale `memory_maintenance_seen` (slug, kind, revision, clé) reste hors miroir. Une tâche terminée sans proposition n'est pas reprise tant que la révision de la page, le vocabulaire (tags), le seuil (duplicate) ou un partenaire jugé n'a pas changé. Le modèle de découpage peut répondre par une liste vide (« rien à découper »).

### DM16. Les vecteurs se rattrapent

- La disponibilité d'Ollama est revérifiée à chaque passage du planificateur, plus seulement au démarrage.
- Quand elle passe à vrai, les pages sans vecteur sont enfilées. Une écriture faite pendant une panne laisse un job en attente, au lieu de rien.

### DM17. Les pages cycliques se purgent quand la rétro existe

- Une tâche est close quand une page `<ns>/retro/<cycle>` la cite. La purge retire alors ses pages `plan`, `dev-handoff` et `review`.
- La purge passe par `MemoryService.remove` : le miroir git garde l'historique, rien n'est perdu.
- Elle est manuelle d'abord : `aid mem purge --dry-run` liste, `aid mem purge` exécute. Son automatisation est une décision à prendre après un mois d'usage.
- `aid mem purge --orphelines` liste, sans rien retirer, les tâches qui ont des pages de cycle et pas de rétro.

### DM18. L'usage se mesure

- Une table `memory_usage (slug, op, role, at)` reçoit une ligne par page rendue dans une recherche (`op: search`) et par page lue (`op: get`). `role` est celui du run quand il y en a un.
- `aid mem usage` rend, par page, le nombre de lectures et la date de la dernière.
- Rien n'est supprimé sur la foi de ces chiffres : ils servent à décider.

## 5. Points

Un point est un commit, gate vert.

### 57.1 Le plan

Ce document et sa ligne dans `docs/chantiers/README.md`.

### 57.2 gbrain hors du dépôt (DM11)

- `agent.yml` suit `kernel/` ; le commentaire sur `.gbrain-source` disparaît.
- `/sync` : `CLAUDE.md` et `AGENTS.md` re-rendus, section `memory` en `aid mem`.
- `kernel/adapters/gbrain.md` supprimé ; références mises à jour dans `kernel/`.
- `test/sans-gbrain.test.ts` : le mot n'apparaît plus hors des trois chemins admis.

Ce point modifie le manifeste et les blocs rendus : c'est demandé par ce plan, c'est son objet.

### 57.3 gbrain hors du poste Windows (DM10)

Geste machine, sans commit de code. Le compte rendu [`docs/recette-chantier-57-gbrain-windows.md`](../recette-chantier-57-gbrain-windows.md) en garde la trace, sans contenu de page ni chemin privé : la fiche est prête, on la remplit sur place.

1. Export complet de `~/.gbrain` sous `~/.aid/backups/gbrain-<date>/`.
2. Triage par source, avec un fichier `TRIAGE.md` par source dans la sauvegarde.
3. `aid mem import` des pages retenues, puis contrôle par `aid mem list`.
4. Sur l'accord de Julien : `bun remove -g gbrain`, suppression de `~/.gbrain`.

### 57.4 Le miroir tire (DM12)

- `MemoryMirror` : `pull()` au démarrage et avant `push`, avance rapide puis `rebase`.
- Conflit : arrêt, copie `.conflit-<machine>.md`, état remonté.
- Relecture en base des pages touchées par un tirage.
- Tests avec deux dépôts temporaires et un distant nu, jamais le vrai `~/.aid`.

### 57.5 La santé le dit (DM12)

`aid doctor` et `/api/memory/health` : distant absent alors que `push` est vrai, avance et retard sur le distant, conflit en attente.

### 57.6 Le découpage en création seule (DM13)

`applyProposal` et `runSplit`. Tests : slug pris, slug hors `lesson/`, échec sans écriture partielle.

### 57.7 Les doublons par paires (DM14)

`runDuplicate` reçoit `VectorIndex` et `MemoryStore`. Tests avec un faux modèle : « non » ne crée rien, « oui » crée une proposition vers le candidat, absence de vecteurs ne lance rien.

### 57.8 Le périmètre et le plafond (DM15)

`eligibleKind`, `scheduleMaintenance`, `config.ts` (`maxPerNight`, `splitLines`), vocabulaire fermé des tags. Tests : une page `aid/plan/…` n'est jamais éligible ; 21e job de la nuit refusé ; tag hors vocabulaire refusé.

### 57.9 Le rattrapage des vecteurs (DM16)

`main.ts` et `worker.ts`. Tests : Ollama absent au démarrage puis présent, les pages écrites entre-temps reçoivent leur vecteur.

### 57.10 La purge (DM17)

`aid mem purge`, `--dry-run`, `--orphelines`. Route et commande. Tests sur un `AID_HOME` temporaire.

### 57.11 Le journal d'usage (DM18)

Migration `memory_usage`, écriture dans `search` et `get`, `aid mem usage`.

### 57.12 L'activation et la recette

Suivre la [fiche de recette](../recette-chantier-57-memoire.md) sur la tour de Julien. AID Server et Ollama tournent dans Ubuntu sous WSL2 (décision du 2026-11-20). Activer `memory.maintenance.enabled: true` pour une nuit. Le matin, lister les propositions avec `aid mem proposals`, puis les relire et les décider dans la section « Entretien de la mémoire » de la Boîte. Le chantier n'est pas clos avant cette nuit.

## 6. Pièges

- **`AID_HOME` temporaire dans tout test**, jamais le vrai `~/.aid`. Jamais de vrai Ollama dans un test : `memory.embeddings.provider: off` explicite, ou un faux `Embedder` (piège déjà rencontré au 10.5).
- **Ollama depuis WSL** : Julien a décidé le 2026-11-20 d'installer Ollama dans Ubuntu sous WSL2 sur la tour. AID Server y accède sur `http://127.0.0.1:11434`. Vérifier la réponse depuis WSL avant d'activer l'entretien.
- **`store.all()` garde un curseur ouvert** : matérialiser la liste avant d'enfiler des jobs (commentaire existant dans `scheduleMaintenance`).
- **Le miroir fait foi, pas la base.** Après un tirage, c'est la base qui se met à jour depuis les fichiers, jamais l'inverse.
- **Ne pas lancer `reindex` pour rattraper les vecteurs** : il vide la base et la relit en entier.
- **La purge et la synchronisation** : une page purgée sur une machine disparaît sur les autres au tirage suivant. C'est voulu, et c'est la raison du `--dry-run`.
- **`/sync` écrase `CLAUDE.md`** : toute correction faite à la main dans le bloc est perdue. Corriger `kernel/` ou `agent.yml`.

## 7. Fini quand

- `git grep -i gbrain` ne rend plus rien hors de `docs/chantiers/`, `kernel/CHANGELOG.md` et `brief.md`, et le test de garde est vert.
- `gbrain` n'est plus dans le `PATH` du poste Windows, et `~/.gbrain` n'existe plus.
- Deux machines qui partagent le même distant voient les mêmes leçons après un démarrage.
- Aucune proposition d'entretien ne peut écraser une page, et aucune ne vise une page hors de `lesson/`.
- Une nuit d'entretien crée au plus `maxPerNight` jobs.
- `aid mem purge --dry-run` et `aid mem usage` rendent un résultat.
- `npm run gate` et `npm run gate:e2e` sont verts, sous Node 22 et Node 24.

## 8. À confirmer avant le dev

1. **Le distant du miroir** : un dépôt GitHub privé, ou un dépôt nu sur une de tes machines ?
2. **La machine de référence** : laquelle porte le miroir le plus complet (celui de 431 pages) ? C'est elle qui pousse la première.
3. **`projet-b` et `projet-b-board`** : ces projets vivent-ils encore ? Si oui, sous quel namespace `aid mem` vont leurs pages de cycle ?
4. **Le seuil de découpage à 40 lignes** : valeur proposée sans mesure sur les vraies leçons. À ajuster sur la distribution réelle, que seule la machine de référence peut donner.
5. **Le contrat d'acceptation** de ce chantier reste à écrire avec le skill `contrat-acceptation`, une fois ce plan relu.
