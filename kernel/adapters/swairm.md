# Adaptateur — ruche SWAIRM (`dev_agent` + `review_agent`, orchestration comprise)

Implémentation : SWAIRM, ruche d'agents pilotée depuis GitHub. L'Overmind
(daemon) orchestre ; les drones (`claude -p` en worktree) codent ; la Reine
juge ; le creep (gbrain) mémorise. Un projet qui se développe par la ruche
déclare `dev_agent: swairm` et `review_agent: swairm` dans son manifeste :
les deux capacités viennent ensemble, avec l'orchestration — la ruche ne se
découpe pas.

## Pourquoi celui-là

L'orchestration du noyau suppose un opérateur qui lance les agents de phase
en sous-processus depuis une session. La ruche déplace ce rôle dans un daemon
piloté par les issues GitHub : la carte est le besoin, le GO est un label,
l'escalade est un commentaire. Ce que la chaîne perd en contrôle direct, elle
le gagne en continuité — elle tourne sans session ouverte.

Ce qui rend l'adaptation naturelle : le drone lit nativement le `CLAUDE.md`
de son worktree, donc le bloc rendu. La couche normative atteint la ruche par
le commit, sans câblage.

## Correspondance ruche ↔ chaîne

| Pièce de la ruche                 | Rôle dans la chaîne                   |
| --------------------------------- | ------------------------------------- |
| Overmind (daemon, tick)           | orchestrateur                         |
| triage de l'Oracle → `context.md` | phase plan (le brief)                 |
| drone (`claude -p` en worktree)   | `dev_agent`                           |
| Reine (`max_rounds`)              | `review_agent`, cap de re-dev compris |
| labels et commandes d'issue       | phase triage                          |
| assimilation (learning au creep)  | phase retro                           |
| creep (`gbrain`, `brain_source`)  | capacité `memory`, lue au triage      |

## Appel

La chaîne ne s'appelle pas : elle se **saisit**. Une sous-tâche est une issue
GitHub du repo cible ; l'Overmind la prend au poll, écrit le `context.md`
dans un worktree neuf et spawne le drone :

```bash
claude -p "$(cat context.md)" --permission-mode acceptEdits \
  --model <runner.model> --max-budget-usd <runner.max_budget_usd> \
  --strict-mcp-config --mcp-config <runner.mcp_config>
```

Le réglage (modèle épinglé, budget, MCP, morphs, provision) vit dans le
`swairm.yml` du repo cible, pas ici.

## Par phase

| Phase  | Dans la ruche                                                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| plan   | triage de l'Oracle : critères d'acceptation vérifiables, extraits du creep cités avec leur source, plan d'attaque — dans le commentaire de triage et le `context.md` |
| dev    | le drone, sous le bloc du worktree ; handoff = `swairm-result.json` (voir Contraintes)                                                                               |
| review | la Reine ; verdicts bornés par `max_rounds`                                                                                                                          |
| triage | l'Overmind route par labels ; l'escalade est un commentaire d'issue                                                                                                  |
| retro  | l'assimilation écrit le learning au creep à la fermeture de la carte                                                                                                 |

## Contraintes

**Le handoff du drone n'est pas une page mémoire.** Le drone n'a ni
credential ni accès au creep : environnement en liste blanche, HOME jetable.
Son handoff est `swairm-result.json` — statut, résumé, diagnostics,
learnings, une preuve par critère d'acceptation. C'est l'Overmind qui pousse
la branche, ouvre la PR et écrit au creep. Même contrat que la page
`dev-handoff`, canal différent : la review de la Reine lit la PR, pas la
mémoire.

**L'index structurel doit atteindre le worktree.** `.codegraph/` est
gitignoré : un worktree neuf n'en a pas. Deux conditions pour que le drone ne
retombe pas silencieusement en lecture directe : le `.mcp.json` du projet
**commité** — le worktree l'a alors par git — et `runner.mcp_config:
.mcp.json` dans le `swairm.yml` du repo, sans quoi `--strict-mcp-config`
coupe tout. L'index lui-même se reconstruit en `provision`
(`codegraph init`) si son coût tient dans le timeout ; sinon la clause de
dégradation du bloc s'applique, et le drone la déclare.

**Le creep pointe sur la source du projet.** `creep.brain_source` du
`swairm.yml` = le contenu de `.gbrain-source`. Un creep qui pointe ailleurs
fait puiser au triage la connaissance d'un autre projet.

**Les learnings restent dans la source du projet.** L'assimilation ne sait
pas encore promouvoir une leçon transverse vers l'espace `lessons` : cette
promotion reste un geste de rétro d'atelier. Une leçon vraie hors du projet
se repasse à la main.

**Même fournisseur, même produit, des deux côtés.** Reine et drone sont deux
instances `claude -p` : c'est le repli de `adapters/claude.md`, à déclarer
comme tel. Ce qui subsiste : des instances distinctes, des contextes
disjoints, une Reine qui ne partage pas le worktree du drone.
