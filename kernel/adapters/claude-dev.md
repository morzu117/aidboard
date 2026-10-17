# Adaptateur — capacité `dev_agent`

Implémentation : Claude Code CLI (Anthropic) en mode `-p`, permissions
contournées dans le worktree. Agent de développement non-interactif, lancé en
sous-processus par l'orchestrateur.

## Pourquoi celui-là

Choix opérateur (2026-09-01) : un seul fournisseur pour le dev et la review,
Codex ayant montré des quotas trop courts pour une slice (« usage limit » en
plein cycle, run sans effet). Le prix est connu et assumé : le `review_agent`
Claude n'est plus d'un fournisseur distinct — sa review vaut **repli**, pas
l'équivalent (voir `adapters/claude.md`). Ce qui compense : la review reste
une **instance neuve, sans outil, diff en ligne** — elle ne partage ni le
contexte ni les fichiers du dev, seulement le modèle.

## Appel

Le brief passe par un fichier : il contient des backticks, des guillemets et
des dollars qui se font manger au passage du shell.

```bash
claude -p "$(cat /tmp/brief.txt)" --permission-mode bypassPermissions --strict-mcp-config --mcp-config .mcp.json --model <MODEL> --max-budget-usd <BUDGET> --output-format json --no-session-persistence < /dev/null
```

| Flag                                         | Rôle                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p`                                         | one-shot programmatique ; `claude` lit `CLAUDE.md` du projet nativement (le bloc rendu)                                                                           |
| `--permission-mode bypassPermissions`        | miroir du `--dangerously-bypass-approvals-and-sandbox` de Codex : aucun prompt en mode `-p`, sinon chaque `Bash` est refusé et le dev rend un travail à moitié    |
| `--strict-mcp-config --mcp-config .mcp.json` | seuls les serveurs MCP du **projet** (l'index structurel) ; sans lui les ~150 outils MCP de l'opérateur entrent dans chaque tour (mesuré : 0,58 $ le tour à vide) |
| `--model <MODEL>`                            | `models.trivial` / `standard` / `complex` du manifeste                                                                                                            |
| `--max-budget-usd <BUDGET>`                  | garde-fou budget : trivial 2, standard 8, complexe 15 (dépassé ⇒ `subtype: error_max_budget_usd`, travail partiel commité ou non — relire `git status`)           |
| `--output-format json`                       | `result` = compte rendu final du dev, `total_cost_usd` = coût réel                                                                                                |
| `--no-session-persistence`                   | rien dans `~/.claude`                                                                                                                                             |

**Le `< /dev/null` n'est pas optionnel** : stdin fermé, comme pour Codex.
**Pas de `--bare`** : il saute le trousseau, le CLI répond « Not logged in ».

## Routage modèle

Le modèle se choisit à la difficulté déclarée de la sous-tâche, pas au
confort. C'est le premier levier de coût de la chaîne.

| Difficulté                                | Modèle                        |
| ----------------------------------------- | ----------------------------- |
| trivial — rename, config, doc, one-liner  | `models.trivial` du manifeste |
| standard — feature classique et ses tests | `models.standard`             |
| complexe — logique fine, transverse, perf | `models.complex`              |

L'orchestrateur propose le routage dans le plan ; l'humain le voit et peut
l'écraser au GO.

## Contenu obligatoire du brief

1. La sous-tâche précise — fichiers visés, comportement attendu, critère
   d'acceptation.
2. La référence à la page de plan.
3. La DoD de `policy/orchestration.md`.
4. **La contrainte de périmètre, mot pour mot** : « add ONLY X ; do NOT
   reformat or touch unrelated code ; insertion-only diff ».

Sans le point 4, l'agent reformate hors cible. La contrainte dans le brief se
double du contrôle mécanique décrit dans `policy/orchestration.md`.

## Contraintes

**Aucun credential GitHub.** L'agent de dev ne pousse pas, n'ouvre pas de PR,
ne merge pas. Il commite en local sur la branche courante. Le brief le
répète ; `bypassPermissions` ne l'en dispense pas.

**Ne conçoit pas.** Si le brief est ambigu sur une décision de conception, il
s'arrête et le signale dans son handoff. Inventer une architecture est une
escalade humaine manquée.

**Même fournisseur que la review.** Le manifeste le dit ; la PR le dit.

## Par phase

| Phase | Usage                     |
| ----- | ------------------------- |
| dev   | l'intégralité de la phase |

## Santé

```bash
claude -p "PONG" --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --model claude-haiku-4-5-20251001 --max-budget-usd 0.10 --no-session-persistence < /dev/null
```
