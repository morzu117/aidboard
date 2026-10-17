# Adaptateur — capacité `memory`

Implémentation : A-I-D, daemon local ; pages markdown dans `~/.aid/memory/`
(dépôt git, source de vérité), index SQLite FTS5 reconstructible, vecteurs
facultatifs par Ollama. Rien ne sort de la machine.

## Appel

```bash
aid mem get <slug>                                   # lire une page
echo "<contenu>" | aid mem put <slug> --append       # compléter une page de phase
echo "<contenu>" | aid mem put <slug>                # créer (refus si elle existe)
aid mem search "<termes>" --scope <namespace>        # <namespace> + lesson/
aid mem search "<termes>" --scope all                # tous projets
aid mem list <namespace>/plan/                       # énumérer
```

MCP : `aid mcp` expose `memory_get`, `memory_put`, `memory_search`,
`memory_list` ; l'agent principal l'utilise quand il est déclaré, les agents
sans MCP utilisent le CLI. Les deux appellent le même daemon ; **n'utiliser
qu'un seul des deux dans une même phase**.

| Code | Signification                                                                       |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Succès                                                                              |
| 2    | Conflit de révision (`put` sans option sur une page existante)                      |
| 3    | Page absente (`get`, `rm`)                                                          |
| 4    | Daemon injoignable                                                                  |
| 5    | Écriture interdite (hors du namespace du workspace, ou `lesson/` hors rôle `retro`) |

## Par phase

| Phase  | Lit                                                                                    | Écrit                                                                             |
| ------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| plan   | `aid mem search "<domaine>" --scope <namespace>` (leçons), puis `get` des pages citées | `put <namespace>/plan/<task>` (`--append` si elle existe)                         |
| dev    | `get <namespace>/plan/<task>`                                                          | `put <namespace>/dev-handoff/<task> --append`                                     |
| review | `get` plan et dev-handoff                                                              | `put <namespace>/review/<task> --append`                                          |
| retro  | `get` des trois pages                                                                  | `put <namespace>/retro/<cycle>` ; zéro ou plusieurs `put lesson/<domaine>/<slug>` |

## Contraintes

**Une page de phase se complète, elle ne se remplace pas.** Une même tâche
connaît plusieurs lancements de la même phase — re-dev après review, point du
plan livré par un second agent. Sans option, `aid mem put` sur une page
existante refuse (`revision_conflict`) : c'est voulu. `--append` est le geste
normal, il ajoute le contenu à la fin, atomiquement, sans toucher à ce qu'un
lancement précédent a écrit. `--force` est réservé à l'humain — un agent qui
l'utilise réécrit le travail d'un autre lancement sans rien demander
(incident constaté sous gbrain le 2026-09-24, cycle `site-commercialisation` :
un `--force` avait effacé le handoff du lancement précédent).

**Rien de dérivable du code.** Voir `policy/routing.md`.

**Écriture aux frontières de phase seulement.** Pas d'écriture opportuniste en
cours de travail — ça produit du volume sans validation.

**`lesson/` en rétro uniquement**, et au format atomique de
`policy/namespace.md` : une affirmation, un frontmatter, quinze lignes au
plus.

**Scope à l'appel.** `--scope <namespace>` est le défaut d'une phase : il
cherche dans `<namespace>` et dans `lesson/`. `--scope all` se justifie dans
le handoff — il coûte plus et ramène du bruit.

**Repli déclaré.** Code 4 (daemon injoignable) : lire
`~/.aid/memory/<slug>.md` directement, pas de recherche, le dire dans le
handoff. Ne jamais écrire ce fichier à la main : une écriture hors daemon
n'est pas indexée et sera écrasée au prochain `aid mem reindex` si elle n'est
pas commitée.

## Limites connues

- La recherche vectorielle dépend d'Ollama : absent, `search` rend du FTS5
  seul et le dit dans sa sortie (`"mode": "fts"`). Un résultat FTS5 vide ne
  signifie pas « rien d'appris » quand la question est formulée loin des mots
  de la page : reformuler une fois avec les termes du domaine avant de
  conclure.
- Un seul écrivain : le daemon. Les autres postes passent par son MCP via
  Tailscale, ou travaillent sur un clone de `~/.aid/memory` en lecture (voir
  `SETUP.md`, chantier 03).

## Installation

Renvoi vers `SETUP.md` : `bootstrap-machine.sh` installe A-I-D, déclare le
MCP, tire les modèles. Vérification : `aid --version`, `aid doctor`.

## Santé

`aid doctor` vérifie : daemon, base, dépôt `~/.aid/memory` propre, Ollama et
modèles (avertissement seulement), nombre de pages par namespace. `aid mem
reindex` si l'index et les fichiers divergent.
