# Adaptateur — capacité `review_agent`

Implémentation : Vibe CLI (Mistral). Reviewer indépendant, borné.

## Pourquoi celui-là

Le critère de choix n'est pas la qualité brute du modèle, c'est la
**bornabilité**. Un reviewer qui peut partir explorer le repo et lancer la
suite de tests n'est plus un reviewer : c'est un second agent de dev, plus
lent et non déterministe. `--max-turns` rend le dérapage impossible par
construction.

Second critère : le **provider distinct** de celui de l'agent de dev. Un
reviewer du même moteur partage les angles morts de l'auteur. La review par
le provider du dev existe et fonctionne, mais elle est un repli, pas
l'équivalent.

## Appel

Le prompt passe par un fichier, pas en argument direct : le diff contient des
guillemets et des dollars qui se font manger au passage du shell.

```bash
{ echo "<INSTRUCTIONS DE REVIEW>"; echo; echo "DIFF:"; git --no-pager show <COMMIT>; } > /tmp/rev.txt
vibe -p "$(cat /tmp/rev.txt)" --max-turns 3 --output json --max-price 0.50 --auto-approve < /dev/null
rm -f /tmp/rev.txt
```

| Flag                           | Rôle                              |
| ------------------------------ | --------------------------------- |
| `-p`                           | one-shot programmatique           |
| `--max-turns N`                | garde-fou anti-exploration        |
| `--max-price` / `--max-tokens` | garde-fou budget                  |
| `--output json`                | findings parsables par le triage  |
| `--enabled-tools`              | restreindre ou couper l'outillage |

Instruction utile dans le prompt : « tu as tout en ligne, ne lance ni tests
ni outils, juge ».

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

## Par phase

| Phase  | Usage                     |
| ------ | ------------------------- |
| review | l'intégralité de la phase |

## Santé

```bash
vibe -p "PONG" --max-turns 1
```
