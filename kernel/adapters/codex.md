# Adaptateur — capacité `dev_agent`

Implémentation : Codex CLI (OpenAI). Agent de développement non-interactif,
lancé en sous-processus par l'orchestrateur.

## Appel

```bash
codex exec -m <MODEL> --dangerously-bypass-approvals-and-sandbox "<BRIEF>" < /dev/null
```

**Le `< /dev/null` n'est pas optionnel.** Sans stdin fermé, `codex exec` bloque
indéfiniment et laisse un run zombie. C'est le piège le plus coûteux de la
chaîne parce qu'il ne produit aucune erreur — juste une attente.

## Routage modèle

Le modèle se choisit à la difficulté déclarée de la sous-tâche, pas au
confort. C'est le premier levier de coût de la chaîne, loin devant les autres.

| Difficulté                                | Modèle                        |
| ----------------------------------------- | ----------------------------- |
| trivial — rename, config, doc, one-liner  | `models.trivial` du manifeste |
| standard — feature classique et ses tests | `models.standard`             |
| complexe — logique fine, transverse, perf | `models.complex`              |

L'orchestrateur propose le routage dans le plan ; l'humain le voit et peut
l'écraser au GO.

## Contenu obligatoire du brief

Un brief incomplet produit un diff à reprendre. Les quatre éléments :

1. La sous-tâche précise — fichiers visés, comportement attendu, critère
   d'acceptation.
2. La référence à la page de plan.
3. La DoD de `policy/orchestration.md`.
4. **La contrainte de périmètre, mot pour mot** : « add ONLY X ; do NOT
   reformat or touch unrelated code ; insertion-only diff ».

Sans le point 4, l'agent reformate hors cible — il lance le formateur du
projet et rend un diff illisible. La contrainte dans le brief ne suffit pas
seule : elle se double du contrôle mécanique décrit dans
`policy/orchestration.md`.

## Contraintes

**Aucun credential.** L'agent de dev ne pousse pas, n'ouvre pas de PR, ne
merge pas. Il commite en local sur la branche courante. C'est structurel, pas
une politesse.

**Ne conçoit pas.** Si le brief est ambigu sur une décision de conception, il
s'arrête et le signale dans son handoff. Inventer une architecture est une
escalade humaine manquée.

## Par phase

| Phase | Usage                     |
| ----- | ------------------------- |
| dev   | l'intégralité de la phase |

## Notes

`codex` lit `AGENTS.md` nativement et n'a pas de commandes slash. C'est la
raison pour laquelle le bloc rendu est commité dans le repo plutôt que servi
par un serveur MCP.
