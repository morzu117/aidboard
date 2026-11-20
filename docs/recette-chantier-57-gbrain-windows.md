# Recette du chantier 57.3 — gbrain hors du poste Windows

Grille du point 57.3 du plan `docs/chantiers/57-memoire-unifiee-entretien.md` (DM10). Ce point est
un geste machine, sans code : tout se fait sur la tour de Julien, dans Ubuntu sous WSL2, où vit
`~/.aid`. Cette fiche sert aussi de compte rendu : on y coche les cases et on y remplit les relevés.

Rappels qui valent pour toute la fiche :

- **rien n'est supprimé avant d'être sauvegardé**. La copie brute de l'étape 1 est la garantie
  anti-perte : si le triage se trompe, la donnée reste récupérable ;
- la sauvegarde vit sous `~/.aid/backups/`, **jamais** sous `~/.aid/memory` (le miroir est un dépôt
  git qui peut pousser vers un distant) ;
- les `TRIAGE.md` restent dans la sauvegarde, sur la tour. Ils ne se collent ni dans cette fiche, ni
  dans un fil, ni dans un DM ;
- dans cette fiche, on note **la forme et les comptages** (« 38 pages, 31 écartées comme
  redondantes »), jamais un titre, un contenu de page, un nom de projet réel ou un chemin
  personnel. Les sources gardent les noms du plan (`lessons`, `projet-b`, …) ;
- les commandes `gbrain` ci-dessous sont celles du chantier 10 (version du Mac). La tour a gbrain
  0.48.1 : avant de commencer, `gbrain --help` confirme les sous-commandes. Si l'une diffère, on note
  la forme de celle qui a servi ;
- la suppression (étape 5) n'a lieu que sur l'**accord explicite de Julien**, une fois l'import
  vérifié.

## Couverture automatique

Aucune : le 57.3 ne touche pas au code. La partie dépôt du retrait est couverte par le 57.2 :
`test/sans-gbrain.test.ts` refuse le mot hors des chemins admis, et `CLAUDE.md` / `AGENTS.md`
prescrivent `aid mem`. Avant de commencer, AID Server doit tourner sur la tour (`aid doctor`), dans
une version qui contient le chantier 57.

## Recette réelle à cocher

### 0. Relevé de départ

- [ ] Dans Ubuntu, `command -v gbrain` trouve le binaire. S'il est absent, le chercher côté Windows
      (`Get-Command gbrain` dans PowerShell) et noter de quel côté il est installé.
- [ ] `gbrain sources list --json` : noter le nombre de pages par source. Le relevé du 16 novembre
      donnait `lessons` 38, `projet-b` 99, `projet-b-board` 46, `swairm` 22, `projet-a` 3. Tout écart
      se note, ainsi que toute source absente de cette liste.
- [ ] `aid mem list lesson/` et `aid mem list aid/` : noter les comptages avant import. Si le miroir
      a un distant (57.4), redémarrer AID Server d'abord pour que les leçons des autres machines
      soient tirées : le contrôle de redondance se fait contre elles.

| Source | Pages (gbrain) | Écart au relevé du 16 nov. |
| --- | --- | --- |
| `lessons` | | |
| `projet-b` | | |
| `projet-b-board` | | |
| `swairm` | | |
| `projet-a` | | |

### 1. Sauvegarde complète

- [ ] Fixer la date : `D=$(date +%F)`, puis `B=~/.aid/backups/gbrain-$D` et `mkdir -p "$B"`.
- [ ] Aucun processus gbrain ne tourne (`pgrep -a gbrain` ne rend rien). Copie brute :
      `cp -a ~/.gbrain "$B/brut"`.
- [ ] Vérifier la copie : `du -s ~/.gbrain "$B/brut"` donne la même taille, et
      `find ~/.gbrain | wc -l` le même nombre que `find "$B/brut" | wc -l`.
- [ ] Export lisible, par source : `gbrain list --source <id>` vers `"$B/<id>/liste.txt"`, puis
      chaque page lue une à une (la commande de lecture que donne `gbrain --help`) vers
      `"$B/<id>/pages/<page>.md"`. Le nombre de fichiers exportés égale le nombre de pages relevé à
      l'étape 0.

| Source | Pages exportées | Égal au relevé |
| --- | --- | --- |
| `lessons` | | [ ] |
| `projet-b` | | [ ] |
| `projet-b-board` | | [ ] |
| `swairm` | | [ ] |
| `projet-a` | | [ ] |

### 2. Triage, un `TRIAGE.md` par source

Règle du chantier 10 (DO1) et de DM10 : chaque page reçoit un statut explicite, **à extraire** ou
**écartée** avec sa raison. Il n'y a pas de troisième statut. Ce qui se retrouve dans un dépôt git
est écarté ; une page de cycle (`plan`, `dev-handoff`, `review`, `retro`) ou une leçon est extraite,
sauf si elle est redondante.

- [ ] `lessons` : comparer **page à page** avec `aid mem list lesson/` et `aid mem search`. Le
      chantier 10 les avait trouvées redondantes sur le Mac, à un slug près. Une leçon déjà présente
      est écartée (« redondante »), une leçon absente est extraite sous le namespace `lesson`.
- [ ] `swairm` et `projet-a` : le Mac les a déjà traitées au chantier 10. Comparer avec les pages
      `swairm/` et `projet-a/` d'`aid mem` ; n'extraire que ce qui manque.
- [ ] `projet-b` et `projet-b-board` : triées pour la première fois. **Décision de Julien avant
      l'import** (question 3 du §8 du plan) : ces projets vivent-ils encore, et sous quel namespace
      vont leurs pages de cycle ? Noter la forme de la décision (« namespace du projet »,
      « tout écarté »), pas le nom réel.
- [ ] Chaque `TRIAGE.md` est écrit dans `"$B/<id>/"` et compte autant de lignes de page que
      l'export de la source.
- [ ] Les pages à extraire sont copiées sous `"$B/<id>/retenues/"` avec l'arborescence du slug
      voulu, sans le namespace : `retenues/<type>/<nom>.md` deviendra `<namespace>/<type>/<nom>`.
      Chaque segment respecte la règle des slugs : `[a-z0-9._-]`, au moins deux segments une fois
      le namespace ajouté, 200 caractères au plus.

| Source | Extraites | Écartées | Principales raisons d'écart (forme) |
| --- | --- | --- | --- |
| `lessons` | | | |
| `projet-b` | | | |
| `projet-b-board` | | | |
| `swairm` | | | |
| `projet-a` | | | |

### 3. Import dans `aid mem`

- [ ] Pour chaque source qui a des pages retenues :
      `aid mem import --dir "$B/<id>/retenues" --namespace <namespace>`. La commande n'écrase
      jamais : une page existante est « refusée, existe déjà », un slug invalide est « refusée,
      slug invalide ». Noter la ligne de bilan (`N importée(s), N existante(s), N invalide(s)`).
- [ ] Une page refusée pour slug invalide est renommée dans `retenues/`, puis réimportée. Une page
      « existante » est relue : si elle diffère vraiment de la page en mémoire, la décision revient à
      Julien. On ne force jamais.
- [ ] `aid mem list <namespace>/` : le nombre de pages a augmenté du nombre d'importées.
- [ ] Échantillon : pour chaque source, deux pages importées relues avec `aid mem get` et
      retrouvées par `aid mem search`.
- [ ] Si le miroir a un distant avec `memory.git.push: true`, le commit d'import est poussé
      (`/api/memory/health` : `mirrorSync` sans retard).

| Source | Importées | Existantes | Invalides, puis corrigées |
| --- | --- | --- | --- |
| `lessons` | | | |
| `projet-b` | | | |
| `projet-b-board` | | | |
| `swairm` | | | |
| `projet-a` | | | |

### 4. Contrôle avant retrait

- [ ] Toutes les sources du relevé ont un `TRIAGE.md` complet et un import vérifié.
- [ ] La copie brute `"$B/brut"` est intacte (même taille qu'à l'étape 1).
- [ ] **Accord de Julien pour le retrait** : date et forme de l'accord (« oui en session »).

### 5. Retrait, sur l'accord de Julien seulement

- [ ] `bun remove -g gbrain` (du côté où il était installé à l'étape 0).
- [ ] `rm -rf ~/.gbrain`, après une dernière vérification que `"$B/brut"` existe.
- [ ] Ouvrir un nouveau shell : `command -v gbrain` ne rend plus rien, et `~/.gbrain` n'existe plus.
      Ce sont deux critères « Fini quand » du §7 du plan.
- [ ] `aid doctor` est vert sur la mémoire. Un agent lancé depuis AID Server n'a plus que `aid mem`
      comme mémoire (bloc `memory` de `CLAUDE.md`, rendu au 57.2).

### 6. Clôture

- [ ] Cette fiche est remplie (comptages, formes, dates), sans contenu de page ni chemin personnel.
- [ ] Le 57.3 est marqué fait dans le plan. La sauvegarde `~/.aid/backups/gbrain-<date>/` est gardée.
      Sa durée de conservation est une décision de Julien.
