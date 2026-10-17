---
description: Synchronise le projet avec le noyau agent
---

Noyau : `~/.agent-kernel`

Tu es un **moteur de rendu**, pas un rédacteur. Le gabarit est la source.
Ta valeur ajoutée est le jugement sur les cas limites — manifeste absent,
migration à appliquer, conflit — pas la formulation du bloc.

## 1. Manifeste

Trois sources, résolues du plus faible au plus fort :

```
~/.agent-kernel/defaults.yml   <   détection du repo   <   agent.yml
```

Lis `agent.yml` à la racine du projet, s'il existe. **Ne demande jamais à
l'humain ce que tu peux détecter ou hériter.** Un champ absent n'est pas un
champ manquant : c'est un champ à résoudre.

### Détection

| Champ                             | Détecté depuis                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `project.name`                    | `[project] name` de `pyproject.toml`, `name` de `package.json`, sinon le nom du dossier                 |
| `project.namespace`               | slug de `project.name`                                                                                  |
| `project.languages`               | présence de `pyproject.toml`, `package.json`, `tsconfig.json`, `Cargo.toml`, `go.mod`                   |
| `capabilities.memory.source`      | `project.namespace`. Un `.gbrain-source` présent n'est plus lu : le signaler et proposer sa suppression |
| `commands.test` / `commands.lint` | scripts de `package.json` ; `[tool.pytest]` / `[tool.ruff]` de `pyproject.toml`                         |
| `gates`                           | une entrée par couche testable détectée                                                                 |

**Un `AGENTS.md` ou `CLAUDE.md` déjà présent dans le repo est ta meilleure
source pour les gates.** S'il en documente un, reprends-le **verbatim** : il
a été validé par l'usage, ta reconstruction ne l'a pas été. Ça vaut aussi
pour les faits de `stack`.

### Ce qui reste à l'humain

Après détection et héritage, il ne devrait rester que `stack` — des faits en
prose qu'aucune inspection ne donne. **Propose-le rempli** depuis ce que tu
as lu du repo, et demande validation.

Si un champ non détectable manque vraiment, demande-le. Un seul, pas une
liste : chaque question de plus est une détection que le noyau aurait dû
savoir faire.

### Écriture du manifeste

N'écris `agent.yml` qu'après validation explicite, et **n'y écris que ce qui
s'écarte** des défauts et de la détection. Un manifeste qui recopie
`defaults.yml` est une copie de plus à maintenir — et elle dérivera.

En pratique, un manifeste sain tient en une dizaine de lignes.

## 2. Version

Compare `kernel.version` du manifeste à la version du paquet `aid` installé
(`aid --version`). Depuis la fusion (chantier 09), le noyau n'a plus de
numéro de version propre : `kernel.version` se confond avec celui d'aidboard.

- **Migration de fusion d'abord, si besoin.** Si `kernel.version` est une
  version pré-fusion (listée dans l'entrée « Fusion » en tête de
  `~/.agent-kernel/CHANGELOG.md` — par exemple `0.9.0`, `0.7.1`, ou toute
  version au format de l'ancien dépôt `agent-kernel`), applique **d'abord**
  cette migration, quel que soit l'ordre numérique apparent avec la version
  d'aidboard : une comparaison numérique directe serait trompeuse (le pin
  peut être numériquement plus grand que la version d'aidboard installée
  sans que le noyau installé soit plus ancien). Une fois la migration faite,
  réécris `kernel.version` à la version d'aidboard installée et continue
  normalement.
- **Identiques**, ou le pin est `main` : continue.
- **Le noyau est en avance** : affiche les entrées de
  `~/.agent-kernel/CHANGELOG.md` comprises entre les deux versions, puis
  demande confirmation avant de continuer.
- **La majeure a changé** : applique d'abord la migration décrite dans ce
  `CHANGELOG.md` pour cette version. Si elle touche `agent.yml`, montre le
  diff du manifeste et fais valider avant d'écrire.
- **Le pin est en avance sur le noyau** : le noyau local est périmé.
  Arrête-toi et dis-le — c'est mettre à jour le paquet `aid` puis lancer
  `aid kernel install`, pas quelque chose que tu résous ici.

## 2 bis. Capacités réellement disponibles

Pour chaque capacité déclarée non nulle, vérifie que son implémentation
existe sur la machine — la commande d'appel de l'adaptateur, lancée à vide ou
en `--version`.

Pour `memory`, la commande est `aid --version`. Un daemon arrêté n'empêche pas le
rendu : c'est un repli déclaré à l'exécution (`adapters/aid.md`, « Repli »).

Si le manifeste déclare `adapter: gbrain`, avertis : cet adaptateur est déprécié
depuis 0.9.0 et retiré en 1.0 ; la migration est décrite dans
`~/.agent-kernel/CHANGELOG.md`. Rends quand même, avec `adapters/gbrain.md`.

**Si elle manque, arrête-toi.** Ne rends pas le bloc. Une capacité déclarée
mais absente est pire que `null` : la table de routage interdit le grep et
les sous-agents d'exploration au profit d'un outil qui n'existe pas, donc
elle retire le repli sans rien donner en échange. Dis ce qui manque et
propose soit l'installation décrite dans l'adaptateur, soit le passage de la
capacité à `null`.

## 3. Rendu

Prends `~/.agent-kernel/templates/instructions.tmpl.md` et substitue :

- `{{project.name}}`, `{{project.namespace}}`, `{{kernel.version}}`,
  `{{commands.test}}`, `{{commands.lint}}`, `{{guardrails.redev_cap}}` —
  directement depuis `agent.yml`.
- `{{memory.source}}` et `{{memory.lessons_source}}` — depuis
  `capabilities.memory`. Si les deux sont identiques, **signale-le** : la
  couche transverse ne traversera rien (`policy/namespace.md`).
- `{{capabilities.structural_index.call}}` et `{{capabilities.memory.call}}`
  — la commande d'appel documentée dans l'adaptateur correspondant sous
  `~/.agent-kernel/adapters/`.
- `{{phases.table}}` — un tableau des phases listées dans `phases`, avec
  pour chacune ce qu'elle lit et ce qu'elle écrit, repris de
  `~/.agent-kernel/policy/phases.md`. Seulement les phases déclarées.
- `{{gates.block}}` — un bloc de code par entrée de `gates`, préfixé du nom
  de la couche. Une seule entrée : un seul bloc, sans nom de couche.
- `{{capabilities.block}}` — pour chaque capacité déclarée non nulle, la
  section « Appel », « Par phase » et « Contraintes » de son adaptateur.
  Reprises telles quelles. Une capacité à `null` n'apparaît pas.
- `{{stack.block}}` — les faits de `stack` pertinents pour l'agent, sous
  forme de puces courtes. **Fusion** du `stack` de `defaults.yml` (faits de
  machine) et de celui du manifeste (faits de projet), les faits de machine
  d'abord ; une clé homonyme du projet gagne. Si les deux sont vides, écris
  « Rien de particulier. »

**SUBSTITUTION UNIQUEMENT.** N'ajoute pas de section, ne reformule pas,
ne résume pas, ne « améliore » pas la formulation. Deux exécutions
consécutives sans changement de manifeste ni de noyau doivent produire un
fichier **identique à l'octet près**. Si tu es tenté d'ajouter une
précision, c'est le noyau qu'il faut modifier, pas ce rendu.

## 4. Écriture

Écris le résultat dans `CLAUDE.md` **et** `AGENTS.md`, entre :

```
<!-- agentkit:start VERSION -->
<!-- agentkit:end -->
```

où `VERSION` est la version du noyau effectivement rendue.

- Fichier absent : crée-le avec le bloc seul.
- Bloc absent : ajoute-le en fin de fichier.
- Bloc présent : remplace **uniquement** ce qui est entre les marqueurs.

**Ne touche jamais à une ligne hors des marqueurs.** Le reste de ces fichiers
appartient au projet.

## 5. Rapport

Trois lignes maximum :

- version avant → après
- fichiers écrits
- migration appliquée, le cas échéant
- adaptateur `memory` déprécié rencontré, le cas échéant

Puis, si `capabilities.structural_index` est déclaré et qu'aucun index
n'existe encore dans le projet, rappelle la commande d'initialisation de
l'adaptateur. Ne la lance pas toi-même.
