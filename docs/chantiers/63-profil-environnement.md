# Chantier 63 : un profil d'environnement vérifié avant le travail

| Champ | Valeur |
|---|---|
| État | **Révision 0, 24 novembre 2026.** Sujet « profil d'environnement » de la note d'idéation de Julien du 17 novembre (§3 sexies, et la ligne « Procédurale » de la grille du §9.1). |
| Emplacement final | `docs/chantiers/63-profil-environnement.md` sur `main` |
| Base | `main` (indépendant des chantiers 61 et 62) |
| Organisation | Comme au 60 : cell-gestion gère le chantier, Codex CLI écrit le code et les tests, cell-gestion relit, lance le gate, commite et ouvre la PR. |
| Validation | Le gate est vert à chaque point, puis `gate:e2e`. Le chantier ne touche pas au contrat swarph. Le merge se fait sur le oui de Julien, CI verte. |

## 1. Pourquoi

La note tire une leçon de Swairm (§3 sexies). Sur un projet multiplateforme, Swairm a buté sur l'outillage : chaque agent supposait un environnement différent, ou un outil absent. « Un agent qui découvre l'absence d'un outil au milieu d'une tâche est le symptôme à éliminer. »

La grille du §9.1 donne l'état d'A-I-D :
- la partie procédurale existe : `stack`, `gates` et `commands` de `agent.yml`, rendus dans le bloc du noyau ;
- **mais rien ne vérifie à l'exécution que les outils déclarés sont présents.** `stack` est de la prose. La version de Node, par exemple, n'existe que comme une phrase.

## 2. Cible et hors-périmètre

**Cible.**
- Un projet déclare ses outils et leurs versions sous une forme structurée.
- Une commande les vérifie dans la cell réelle, en quelques secondes.
- Le plan et le dev la lancent avant tout travail, et s'arrêtent explicitement si elle échoue.
- Le daemon de chaque cell déclare ce qu'il a, pour qu'on le voie.

**Hors-périmètre.**
- Installer les outils manquants. La commande dit quoi faire, elle n'installe rien.
- Router une étape vers la cell qui a les bons outils. C'est le travail de la boucle dans le daemon, un autre sujet de la note, et ce chantier lui prépare la donnée.
- L'écran Machines. La donnée est exposée et montrée par `aid doctor` ; un écran viendra si le besoin s'en fait sentir.
- Le choix de la stack d'un projet neuf, avec challenge : ce sera une décision `decide` du chantier 60, prise par le rôle plan.

## 3. Décisions

### DM35. Le profil vit dans `agent.yml`, pas dans la mémoire

- La note propose de le ranger dans AID Memory. La règle d'hygiène de la mémoire l'interdit pourtant : rien de dérivable du dépôt ne doit y entrer. Les outils d'un projet changent avec son code, et doivent donc être versionnés avec lui.
- Le profil prend la forme d'une section `outils` du manifeste :

  ```yaml
  outils:
    node: { version: ">=22.12 <25" }
    npm: {}
    git: {}
    mise: { requis: false }
  ```

  - `version` : une plage semver, facultative. Sans elle, seule la présence de l'outil est vérifiée.
  - `verifier` : la commande qui donne la version, en argv sans shell. Par défaut, c'est `<nom> --version`.
  - `requis` : `true` par défaut. Un outil non requis donne un avertissement, jamais un échec.
- `aid env check` ne lit que le manifeste. Rien n'est déduit au moment du contrôle : ce qu'on vérifie est ce qui est écrit. `outils` est donc, comme `stack`, un fait **écrit** dans `agent.yml`. *(Cette décision révise la version 0 de ce plan, qui le voulait détecté et non écrit.)*
- `/sync` le **propose rempli**, à partir du dépôt :
  - `engines` de `package.json` ;
  - les outils de `mise.toml` ;
  - `packageManager` ;
  - `git` toujours.

  Il l'écrit après validation explicite, comme toute écriture du manifeste.
- `kernel/manifest.schema.yml` décrit la section.

### DM36. `aid env check`

- Elle lit le `agent.yml` du dossier courant, ou celui donné par `--root`.
- Pour chaque outil, elle lance `verifier` :
  - sans shell, avec un délai de 5 s par outil ;
  - l'environnement est celui de l'appelant ;
  - elle lit la première version semver de la sortie.
- Chaque outil reçoit un des quatre états `ok`, `absent`, `hors-plage` ou `illisible`. Une version qu'aucun motif ne reconnaît est `illisible`.
- Sortie texte : une ligne par outil. Avec `--json` : un objet stable.
- Codes de sortie :
  - 0 : tout est bon ;
  - 7 : un outil requis est `absent` ou `hors-plage` ;
  - 2 : manifeste illisible.
- Un outil absent reçoit une indication, jamais exécutée. Si `mise.toml` existe et que l'outil y figure, c'est « `mise install` ». Sinon, rien.
- La commande ne lance que les `verifier` du manifeste du dépôt. Comme un script `npm`, c'est du code du projet. Le rendu texte l'écrit.

### DM37. L'amorçage est la première étape du plan et du dev

- Les rôles `plan` et `dev` lancent `aid env check` avant tout le reste. Sur un code 7, ils s'arrêtent. Ils écrivent l'outil fautif dans leur handoff, sans continuer « en contournant ».
- Le bloc rendu de `CLAUDE.md` et `AGENTS.md` liste les outils du profil, à côté des gates.
- Pour un projet neuf, le plan fait du squelette une étape à part entière, avec un critère : le build vide passe.

### DM38. La cell déclare ce qu'elle a

- `GET /api/machines/local`, la route de l'écran Machines du chantier 29, gagne un champ `environnement`. Il n'y a pas de nouvelle route, et les droits restent ceux de la route. Le champ contient :
  - `os` et `arch` ;
  - une liste fixe d'outils courants, chacun avec sa version, ou `null` s'il est absent : `node`, `npm`, `git`, `mise`, `docker`, `python3`, `cargo`, `ollama`. La liste est fermée, dans le code : jamais une saisie, jamais le manifeste ;
  - les modèles Ollama présents, si l'API locale d'Ollama répond (l'URL est celle de `memory.embeddings.url`). On ne rend que leurs noms, jamais leurs chemins.
- Le calcul se fait à l'appel, et reste en cache 10 minutes. Rien ne tourne en fond (D160).
- `aid doctor` montre une ligne « Environnement » avec l'OS et les outils présents.
- L'écran Machines n'est pas touché dans ce chantier.

## 4. Points

### 63.1 Le plan

Ce document, et une ligne dans `docs/chantiers/README.md`.

### 63.2 Le schéma et `aid env check` (DM35, DM36)

Le schéma TypeBox de la section `outils`, la lecture du manifeste, la commande et ses codes.

Les tests couvrent :
- un outil `ok`, `absent`, `hors-plage` ou `illisible` ;
- un outil non requis ;
- un délai dépassé ;
- un manifeste sans `outils`, qui donne seulement `git` ;
- un manifeste invalide ;
- `--json` ;
- l'indication `mise install`.

Les tests passent par de faux exécutables dans un `PATH` temporaire, jamais par les vrais outils.

- _Révision 63.2._ Fait :
  - `src/shared/outils.ts`, le schéma ;
  - `src/shared/plage-version.ts`, les plages sans dépendance : `>=`, `>`, `<=`, `<`, `=`, préfixe, `^`, `~`, ET par espace, OU par `||` ;
  - `src/cli/commands/env.ts`, la commande `aid env check`, avec les codes 0, 7 et 2.

  `git` est ajouté d'office. `git: { requis: false }` le retire du contrôle. Un délai dépassé vaut `absent` (« délai dépassé »).

  35 tests. Gate 4 719. Sur le VPS, `aid env check` dans aidboard rend `✓ git 2.47.3`, puisque le manifeste n'a pas encore d'`outils`.

### 63.3 L'environnement de la cell (DM38)

La route, le cache, les droits et la ligne d'`aid doctor`.

Les tests couvrent :
- un faux `PATH` ;
- Ollama absent, et Ollama simulé avec deux modèles ;
- le refus sur le port des appareils.

- _Révision 63.3._ DM38 est révisé avant le point : le champ `environnement` va dans `GET /api/machines/local`, et il n'y a pas de nouvelle route.

  Fait :
  - `src/daemon/machines/environnement.ts` : huit outils lancés sans shell, avec un délai de 3 s. Il lit aussi les noms des modèles Ollama, et WSL par `/proc/version`. Le cache dure 10 minutes, et deux appels simultanés partagent un seul calcul ;
  - la ligne « Environnement » d'`aid doctor`, en information, omise sur un daemon ancien.

  Un outil qui sort en erreur vaut `null`, même s'il a écrit une version. Gate 4 730.

### 63.4 Le noyau, `/sync` et la fiche (DM35, DM37)

- `kernel/manifest.schema.yml` décrit `outils`.
- `kernel/commands/sync.md` détecte les outils et rend la liste dans le bloc.
- Les rôles `plan` et `dev` ajoutent l'étape d'amorçage, et le changelog est mis à jour.
- Le `agent.yml` d'aidboard déclare son profil, et ses blocs sont re-rendus.
- La fiche `docs/recette-chantier-63-profil-environnement.md` se fait sur la tour et sur le VPS. On y lance `aid env check` sur aidboard, puis on rompt un outil (un `PATH` sans `mise`, par exemple) pour voir l'arrêt.

- _Révision 63.4._ DM35 est révisé avant le point : `outils` est écrit dans le manifeste. Fait :
  - le schéma ;
  - dans `/sync`, la détection proposée et l'emplacement `{{outils.block}}`, avant les gates. Un outil `requis: false` y est marqué « (facultatif ») ;
  - l'étape 0 des rôles plan et dev, et le squelette d'un projet neuf ;
  - le changelog ;
  - le profil d'aidboard : la plage de Node quitte `stack` ;
  - la fiche, avec sept contrôles.

  Gate 4 731. Sur le VPS, `aid env check` rend `node`, `npm`, `git` et `mise` en ✓, avec le code 0.

## 5. Pièges

- **Le profil n'est pas de la prose.** Une phrase « Node 22 requis » qui reste dans `stack` à côté de `outils.node` fait doublon. Le point 63.4 la retire au profit de la section structurée.
- **Ne rien installer.** Un agent qui installe un outil pour passer le contrôle modifie la machine de Julien. La commande dit quoi faire, et elle s'arrête là.
- **Le `verifier` est du code.** Il ne vient que du manifeste du dépôt, jamais d'une page mémoire ni d'un DM.

## 6. Fini quand

- `aid env check` sur aidboard dit en quelques secondes si la cell a Node, npm, git et mise dans les bonnes versions.
- Un plan ou un dev qui démarre sans les outils s'arrête dès sa première étape et nomme l'outil.
- `aid doctor` montre l'environnement de la cell.
