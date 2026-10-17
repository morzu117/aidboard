# Adaptateur — capacité `review_agent`

Implémentation : Claude Code CLI (Anthropic), en mode `-p` sans outil ni MCP.
Reviewer indépendant, borné.

## Pourquoi celui-là

Le critère de choix n'est pas la qualité brute du modèle, c'est la
**bornabilité**. Un reviewer qui peut partir explorer le repo et lancer la
suite de tests n'est plus un reviewer : c'est un second agent de dev, plus
lent et non déterministe. `--tools ""` retire tout outil : sans outil, il
n'y a qu'un tour — le dérapage est impossible par construction, pas par
consigne.

Second critère : le **provider distinct** de celui de l'agent de dev. Un
reviewer du même moteur partage les angles morts de l'auteur. Avec un
`dev_agent` Codex (OpenAI), Claude (Anthropic) satisfait la règle. Depuis le
2026-09-01 le `dev_agent` par défaut est aussi Claude (`adapters/claude-dev.md`) :
cet adaptateur est alors un **repli déclaré**, pas l'équivalent. Ce qui reste
vrai : instance neuve, sans outil, diff en ligne — elle ne partage ni le contexte
ni les fichiers du dev, seulement le modèle. Le manifeste et la PR le disent.

## Appel

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

## Format de sortie attendu

`CLEAN`, ou une liste de findings :

```
{ sévérité: bloquant|majeur|mineur,
  catégorie: bug|design|test-gap|nit|scope-creep,
  fichier:ligne,
  issue,
  action }
```

La catégorie n'est pas décorative — c'est elle qui pilote le triage dans
`policy/orchestration.md`. Une review qui rend de la prose au lieu de ce
schéma est à relancer.

## Contraintes

**Ne réécrit pas le code.** Il juge le diff qu'on lui donne.

**Reçoit le diff en ligne.** On ne lui donne pas accès au repo pour qu'il
aille chercher : c'est précisément ce qu'on borne.

**Aucun outil, aucun MCP.** `--tools ""` et le MCP vide ne sont pas
optionnels : avec des outils, `claude` lit des fichiers, lance des tests, et
le reviewer redevient un agent de dev.

## Par phase

| Phase | Usage |
|---|---|
| review | l'intégralité de la phase |

## Santé

```bash
claude -p "PONG" --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --model claude-haiku-4-5-20251001 --max-budget-usd 0.10 --no-session-persistence < /dev/null
```
