<!-- agentkit:start 0.7.1 -->

## Chaîne agent — aidboard

Rendu depuis agent-kernel 0.7.1. Ne pas éditer à la main :
toute modification est écrasée au prochain `/sync`. Pour changer ce bloc,
modifier le noyau ou `agent.yml`.

### Routage de la connaissance

Pour une question donnée, il y a **exactement un** premier point d'entrée.
Interroger deux sources « au cas où » double le coût au lieu de le diviser.

| La question porte sur | Premier appel | Interdit |
|---|---|---|
| Ce que le code fait, où c'est défini, qui appelle quoi, impact d'un changement | `codegraph_explore` | grep, lecture de fichier, sous-agent d'exploration |
| Pourquoi une décision, ce qui a été tenté, l'état d'un cycle | `gbrain search` | relire l'historique git |
| Comment on travaille, quelle phase fait quoi | ce bloc | tout appel |
| Rien ne répond | lecture directe | — |

**Deux règles à ne pas violer :**

Le source rendu par `codegraph_explore` est **déjà lu**.
Ne pas le re-vérifier au grep.

**Ne jamais déléguer l'exploration du code à un sous-agent.** L'index n'aide
que s'il est interrogé directement ; un sous-agent qui lit des fichiers
annule le bénéfice. La phase qui doit comprendre le code l'interroge
elle-même.

### Quand une capacité ne répond pas

Ce bloc est **commité**. Il sera donc lu dans des environnements que le rendu
n'a pas inspectés : un worktree, un conteneur, une machine sans l'outillage.
La vérification faite au `/sync` vaut pour la machine qui a rendu, pas pour
celle qui lit.

La règle d'exclusivité vaut **là où la capacité répond**. Là où elle ne
répond pas, la table de routage retombe sur sa dernière ligne — lecture
directe. Deux conditions, non négociables :

**Dis-le.** Nomme la capacité absente dans ton handoff. Un agent qui retombe
silencieusement sur le grep rend un travail qui ressemble au travail normal
sans en avoir les garanties : le rayon d'impact déclaré n'en est plus un, et
la review vérifie un contrat qui n'existe pas.

**Ne fais pas semblant.** Ne présente pas une lecture de fichiers comme un
rayon d'impact. La phase plan dit explicitement qu'il n'a pas pu être établi ;
la review sait alors qu'elle n'a rien à comparer.

L'index momentanément en retard sur une écriture est un cas particulier de
capacité qui ne répond pas — même conduite.

### Règle d'hygiène mémoire

Si l'information est dérivable du code, elle n'a rien à faire en mémoire.
Une page qui décrit qui appelle quoi sera fausse dans deux semaines et
duplique ce que l'index donne à jour. La mémoire sert à ce qui n'est pas
dans le code : les intentions, les options écartées, les pièges appris.

Si la réponse obtenue est durable **et non dérivable du code**, elle remonte
en mémoire avant la fin de la phase.

### Phases

| Phase | Lit | Écrit |
|---|---|---|
| plan | la demande, `lesson/` pertinents, l'index structurel | `aid/plan/<task>` |
| dev | `aid/plan/<task>`, l'index structurel | `aid/dev-handoff/<task>` |
| review | `aid/plan/<task>`, `aid/dev-handoff/<task>`, le diff, l'index structurel | `aid/review/<task>` |
| triage | `aid/review/<task>` | rien — elle route |
| retro | les trois pages du cycle | `aid/retro/<cycle>`, et zéro ou plusieurs `lesson/<domaine>/<slug>` |

Les agents ne s'échangent rien latéralement — ils se coordonnent par les
pages mémoire, par git et par le document de plan. L'orchestrateur lance les
agents de phase ; c'est le seul appel direct de la chaîne.

### Definition of Done

Quatre points, tous obligatoires, avant de rendre la main :

**1. Le commit existe** sur la branche courante. Un point de plan est un
commit. Du travail non commité est du travail non rendu.

**2. Le gate de la couche touchée est vert**, lancé **en entier** — pas un
sous-ensemble, pas « les tests qui semblent pertinents ». Un gate partiel
rate les dérives d'artefacts générés.

**gate**

```bash
npm run gate
```

**e2e**

```bash
npm run gate:e2e
```

**3. Le diff est resté dans le périmètre** — voir ci-dessous.

**4. Le handoff est écrit**, selon la phase.

### Contrainte de périmètre (stricte)

**Insertion-only.** N'ajoute que ce que la sous-tâche demande. Ne reformate
pas, ne réindente pas, ne touche à aucune ligne existante hors cible.

Le contrôle est mécanique, pas déclaratif :

```bash
git --no-pager show <COMMIT> | grep -E "^-" | grep -vE "^---" | wc -l
```

Proche de zéro. Toute suppression de ligne existante hors en-têtes est un
dépassement — reformatage automatique, refactor non demandé — et vaut revert
ou escalade.

Ne modifie ni le manifeste, ni la configuration du projet, ni la CI sans que
le brief le demande. Ne bump aucune version.

### Échec pré-existant

Un gate rouge sur quelque chose que ton diff ne touche pas ne te bloque pas.
Trois conditions, toutes obligatoires :

**Le prouver** — rejouer le test sur la base, sans ton diff. Sans la
démonstration, l'échec est le tien.

**Le signaler** — fichier, message exact, depuis quand. Dans le handoff. Un
échec remarqué et non signalé est un échec de DoD.

**Ne pas le contourner** — aucun `skip`, aucun test exclu, aucun seuil
abaissé, aucune assertion retirée. Rendre un test vert en supprimant ce qu'il
vérifiait n'est pas un raccourci.

### Escalade

Remontent à l'humain, et rien d'autre : un finding de conception ou
d'architecture, un dépassement de périmètre, une sous-tâche encore rouge
après 2 re-dev, un garde-fou budget atteint, une
ambiguïté irréductible du besoin ou du plan.

Le reste se déroule et se présente à la fin.

### Pages mémoire

```
aid — pages cycliques du projet
  aid/plan/<task>
  aid/dev-handoff/<task>
  aid/review/<task>
  aid/retro/<cycle>

lessons — espace partagé, transverse
  lesson/<domaine>/<slug>
```

`<task>` est un slug stable sur tout le cycle : il relie les quatre pages.

Les pages préfixées `aid/` sont cycliques et se purgent une
fois la rétro faite. Les pages `lesson/` sont **transverses, sans préfixe
projet, et écrites dans un espace partagé** — c'est la seule couche qui
s'accumule, et la seule façon qu'une leçon apprise ici serve ailleurs. Une
`lesson/` écrite dans l'espace du projet est une leçon perdue. Seule la phase
retro y écrit.

### Capacités

#### `structural_index` — `index_*` (serveur MCP `aid`)

**Appel**

```
index_explore { query }               (MCP « aid », agent principal)
codegraph explore <recherche>         (CLI, sous-agents et harnais sans MCP)
```

`index_explore` rend un texte libre (jamais du JSON) : le sens du code plutôt qu'un nom
exact. Derrière, le daemon porte la capacité `structural_index` du kernel pour le worktree
du sujet courant — un seul serveur MCP (`aid`) pour la mémoire et l'index, plus besoin
d'installer le MCP `codegraph` tiers. Celui-ci (`codegraph_explore` et le reste de sa
surface) reste toléré en transition, worktree par worktree, tant qu'il est déjà enregistré
quelque part.

Le reste de la surface, par ordre d'utilité :

```
index_impact { symbol, depth? }        # ce qu'un changement de ce symbole touche
index_affected { files }               # les fichiers de test concernés
index_callers { symbol, limit? }       # qui l'appelle
index_symbols { query, kind?, limit? } # trouver un symbole par son nom
index_status {}                        # moteur, fraîcheur, nombre de fichiers en retard
```

Les relations rendues portent `provenance` : `candidate` pour codegraph (tree-sitter, pas
de type-checker — homonymes fusionnés dans `callers`), `heuristic` pour ce qu'il synthétise
par convention. Un futur moteur fondé sur le type-checker rendra `exact`.

**Par phase**

| Phase | Usage |
|---|---|
| plan | `index_impact` → le rayon d'impact va dans la page de plan |
| dev | `index_explore` pour comprendre avant de modifier |
| review | `index_affected` → les tests à faire tourner ; comparaison du diff au rayon déclaré |

**Contraintes**

**Le résultat est dérivé du code : il ne se note jamais en mémoire.** Règle du kernel,
reprise dans la description de chaque outil `index_*`.

**Ne jamais déléguer l'exploration à un sous-agent.** L'outil n'aide que
s'il est interrogé directement.

**Index indisponible.** Moteur coupé, binaire absent ou délai dépassé rendent tous le même
texte, `isError` « index indisponible : lecture directe » — lire le fichier directement
plutôt qu'insister. `index_status` porte `stale` et le nombre de fichiers en retard quand
l'index n'a pas rattrapé une écriture récente.

#### `memory` — gbrain

**Appel**

```bash
gbrain search "<termes>" --source <source>          # recherche par mots-clés
gbrain query "<question>" --source <source>         # recherche hybride
gbrain put <slug> --content "…" --source <source> --force   # écrire une page
echo "<contenu>" | gbrain put <slug> --source <source> --force
```

**`--force` n'est pas optionnel.** Depuis gbrain 0.52, remplacer une page
existante exige sa révision (`--expected-revision`) ou `--force` ; sans l'un
ni l'autre, `put` et `capture` ne savent que créer, et la mise à jour d'une
page de plan ou de handoff échoue en `revision_conflict`. Les phases
réécrivent leur page en entier : `--force` est le bon contrat.

**Mais une page de phase se complète, elle ne se remplace pas.** Une même
tâche connaît plusieurs lancements de la même phase — re-dev après review,
point du plan livré par un second agent. `--force` écrase sans rien
demander : le lancement suivant efface alors le handoff du précédent, et la
review compare le diff à un compte rendu amputé (constaté le 2026-09-24,
cycle `site-commercialisation`). Avant d'écrire, lire la page
(`gbrain get <slug> --source <source>`) ; si elle existe, la réécrire
**en entier, en ajoutant sa section à la fin**, titrée du lancement
(`## Re-dev 1/2`, `## Point 5`…). Ne jamais retirer une section écrite par
un autre lancement.

**Le slug est en `/`, jamais en `:`.** gbrain 0.52 refuse tout slug hors
`[lettres chiffres . _ -]` séparés par `/` (`invalid_params`).

Avant d'écrire, chercher : une page existante sur le même sujet se met à jour
plutôt que de se dupliquer.

**Contraintes**

**Rien de dérivable du code.** C'est la règle qui détermine si la mémoire
reste utile ou pourrit. Voir `policy/routing.md`.

**Écriture aux frontières de phase seulement.** Pas d'écriture opportuniste
en cours de travail — ça produit du volume sans validation.

**`lesson/` en rétro uniquement.** Aucune autre phase ne touche à l'espace
transverse.

#### `dev_agent` — claude-dev

**Appel**

Le brief passe par un fichier : il contient des backticks, des guillemets et
des dollars qui se font manger au passage du shell.

```bash
claude -p "$(cat /tmp/brief.txt)" --permission-mode bypassPermissions --strict-mcp-config --mcp-config .mcp.json --model <MODEL> --max-budget-usd <BUDGET> --output-format json --no-session-persistence < /dev/null
```

| Flag | Rôle |
|---|---|
| `-p` | one-shot programmatique ; `claude` lit `CLAUDE.md` du projet nativement (le bloc rendu) |
| `--permission-mode bypassPermissions` | miroir du `--dangerously-bypass-approvals-and-sandbox` de Codex : aucun prompt en mode `-p`, sinon chaque `Bash` est refusé et le dev rend un travail à moitié |
| `--strict-mcp-config --mcp-config .mcp.json` | seuls les serveurs MCP du **projet** (l'index structurel) ; sans lui les ~150 outils MCP de l'opérateur entrent dans chaque tour (mesuré : 0,58 $ le tour à vide) |
| `--model <MODEL>` | `models.trivial` / `standard` / `complex` du manifeste |
| `--max-budget-usd <BUDGET>` | garde-fou budget : trivial 2, standard 8, complexe 15 (dépassé ⇒ `subtype: error_max_budget_usd`, travail partiel commité ou non — relire `git status`) |
| `--output-format json` | `result` = compte rendu final du dev, `total_cost_usd` = coût réel |
| `--no-session-persistence` | rien dans `~/.claude` |

**Le `< /dev/null` n'est pas optionnel** : stdin fermé, comme pour Codex.
**Pas de `--bare`** : il saute le trousseau, le CLI répond « Not logged in ».

**Par phase**

| Phase | Usage |
|---|---|
| dev | l'intégralité de la phase |

**Contraintes**

**Aucun credential GitHub.** L'agent de dev ne pousse pas, n'ouvre pas de PR,
ne merge pas. Il commite en local sur la branche courante. Le brief le
répète ; `bypassPermissions` ne l'en dispense pas.

**Ne conçoit pas.** Si le brief est ambigu sur une décision de conception, il
s'arrête et le signale dans son handoff. Inventer une architecture est une
escalade humaine manquée.

**Même fournisseur que la review.** Le manifeste le dit ; la PR le dit.

#### `review_agent` — claude

**Appel**

Le prompt passe par un fichier, pas en argument direct : le diff contient des
guillemets et des dollars qui se font manger au passage du shell.

```bash
{ echo "<INSTRUCTIONS DE REVIEW>"; echo; echo "DIFF:"; git --no-pager show <COMMIT>; } > /tmp/rev.txt
claude -p "$(cat /tmp/rev.txt)" --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --model <MODEL> --output-format json --max-budget-usd 0.50 --no-session-persistence < /dev/null
rm -f /tmp/rev.txt
```

| Flag | Rôle |
|---|---|
| `-p` | one-shot programmatique |
| `--tools ""` | aucun outil intégré : un seul tour, garde-fou anti-exploration |
| `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` | aucun serveur MCP : sans lui, les schémas d'outils MCP de l'opérateur (gbrain, codegraph…) entrent dans le contexte et font exploser le budget avant le premier mot (mesuré : 0,58 $ pour un « PONG », contre 0,04 $) |
| `--model <MODEL>` | `claude-sonnet-5` pour une review standard (~0,07 $ pour un commit de taille courante) ; `claude-opus-5` sur un diff transverse |
| `--output-format json` | enveloppe JSON ; les findings sont dans le champ `result`, le coût dans `total_cost_usd` |
| `--max-budget-usd` | garde-fou budget (`guardrails.max_price` du manifeste) — dépassé, `subtype` vaut `error_max_budget_usd` et `result` est nul : relancer avec un diff plus court, pas un budget plus haut |
| `--no-session-persistence` | rien n'est écrit dans `~/.claude` |

**Pas de `--bare`** : il saute la lecture du trousseau et la session OAuth
avec — le CLI répond « Not logged in ».

Instruction utile dans le prompt : « tu as tout en ligne, tu n'as aucun
outil, juge ».

**Par phase**

| Phase | Usage |
|---|---|
| review | l'intégralité de la phase |

**Contraintes**

**Ne réécrit pas le code.** Il juge le diff qu'on lui donne.

**Reçoit le diff en ligne.** On ne lui donne pas accès au repo pour qu'il
aille chercher : c'est précisément ce qu'on borne.

**Aucun outil, aucun MCP.** `--tools ""` et le MCP vide ne sont pas
optionnels : avec des outils, `claude` lit des fichiers, lance des tests, et
le reviewer redevient un agent de dev.

### Commandes

```
test   npm test
lint   npm run lint
```

### Contexte projet

- Charge des extraits ciblés, jamais des fichiers entiers. C'est un levier de coût, et sur une machine à mémoire contrainte c'est aussi ce qui décide si la session tient ou se fait tuer.
- Node 22 requis (engines >=22.12 <25, épinglé par mise.toml) ; le gate tourne aussi sous Node 24 avant chaque livraison de chantier.
- node-pty et better-sqlite3 sont en external dans tsup : jamais embarqués dans le bundle.
- AID_HOME temporaire dans tout test, jamais le vrai ~/.aid ; jamais claude ni codex dans un test automatique (faux agent test/fixtures/fake-agent.sh).
- design/maquettes/ est lu par programme : ne jamais le reformater (Prettier l'ignore).
- Le daemon n'écoute que sur 127.0.0.1.
- docs/chantiers/ : un plan par chantier, un point = un commit.

<!-- agentkit:end -->
