# Politique de routage de la connaissance

## Trois couches, jamais plus

**Structurelle** — ce que le code fait _maintenant_. Dérivable, volatile,
régénérée automatiquement. Jamais écrite à la main, jamais commitée. Si elle
est perdue, elle se reconstruit à l'identique.

**Décisionnelle** — ce qui n'est _pas_ dérivable du code : pourquoi ce choix,
ce qui a été tenté et abandonné, les handoffs entre phases. Écrite par les
agents, à des moments définis, jamais opportunistement.

**Normative** — comment on travaille. Stable, versionnée, lue au démarrage.
C'est le bloc généré depuis ce noyau.

## La règle d'hygiène

> Si l'information est dérivable du code, elle n'a rien à faire dans la
> couche décisionnelle.

Un agent qui écrit « la fonction X est appelée par Y et Z » dans une page
mémoire vient de créer une donnée qui sera fausse dans deux semaines, et que
l'index structurel donne gratuitement et à jour.

C'est la première cause de pourrissement de la mémoire. Une page qui viole
cette règle se supprime, elle ne se corrige pas.

## Table de routage

Pour une question donnée, il y a **exactement un** premier point d'entrée.
Un agent qui interroge deux couches « au cas où » ne divise pas le coût, il
le double.

| La question porte sur                                                          | Premier appel      | Interdit                                           |
| ------------------------------------------------------------------------------ | ------------------ | -------------------------------------------------- |
| Ce que le code fait, où c'est défini, qui appelle quoi, impact d'un changement | `structural_index` | grep, lecture de fichier, sous-agent d'exploration |
| Pourquoi une décision, ce qui a été tenté, l'état d'un cycle                   | `memory`           | relire l'historique git                            |
| Comment on travaille, quelle phase fait quoi                                   | déjà en contexte   | tout appel                                         |
| Rien ne répond                                                                 | lecture directe    | —                                                  |

Dernière ligne : si la réponse obtenue est **durable**, elle remonte dans la
couche décisionnelle avant la fin de la phase. Si elle est dérivable du code,
elle ne remonte pas.

## Deux règles que les agents violent naturellement

**Le source rendu par l'index structurel est déjà lu.** On ne le re-vérifie
pas au grep. Le re-vérifier annule le gain et double le coût.

**On ne délègue jamais l'exploration à un sous-agent.** C'est structurel : un
sous-agent qui part lire des fichiers contourne l'index et annule
intégralement le bénéfice. La phase qui a besoin de comprendre le code
l'interroge elle-même.

Cette seconde règle est la raison pour laquelle ce bloc est écrit dans le
fichier d'instructions du projet et pas seulement livré par le serveur MCP :
les instructions MCP n'atteignent que l'agent principal.

## Quand une capacité ne répond pas

Le bloc rendu est commité, donc lu dans des environnements que le rendu n'a
pas inspectés — worktree, conteneur, machine sans outillage. La vérification
de capacités faite au rendu vaut pour la machine qui rend, pas pour celle qui
lit.

L'exclusivité vaut là où la capacité répond. Ailleurs, la table retombe sur
sa dernière ligne : lecture directe, **nommée comme telle**.

Un agent qui retombe silencieusement sur le grep est plus dangereux qu'un
agent sans outil : il rend un travail qui a la forme du travail normal sans en
avoir les garanties. Le rayon d'impact n'est plus un contrat, et la review
croit vérifier quelque chose.

C'est la raison pour laquelle la dégradation est **déclarative** et pas
seulement tolérée. Le repli est autorisé ; le silence sur le repli ne l'est
pas.

## Ce que la politique ne nomme pas

Elle nomme des **rôles** (`structural_index`, `memory`, `dev_agent`,
`review_agent`), jamais des outils. L'implémentation est déclarée dans
`capabilities` du manifeste et décrite dans `adapters/`.

Le jour où un outil est remplacé : un fichier d'adaptateur, un `/sync`, tous
les projets suivent.
