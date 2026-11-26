# Adaptateur — `aid avis`

Le daemon demande des avis aux CLI d'abonnement et affiche l'état des avis,
le tableau d'accord et le coût total (« inconnu » si un coût manque).

## Appel

```sh
aid avis "<question>" [--sous-question "<texte>"]... [--niveau <niveau>] [--n <nombre>] [--budget <USD>] [--challenge] [--json]
```

- `--sous-question` est répétable. Les sous-questions sont numérotées dans l'ordre.
- `--niveau` accepte `leger`, `standard` (par défaut) ou `fort`.
  `--n` fixe le nombre d'avis de 1 à 5 (3 par défaut).
- `--budget` fixe le budget en USD par avis, strictement positif et au plus 2.
- `--challenge` prend un avis par fournisseur de la liste de challenge, au
  niveau fort. `--json` rend la demande complète au format `swairm-ask/1`,
  avec son identifiant.

Chaque appel vise un avis sans outil. Le daemon lance directement le CLI
dans un répertoire temporaire vide, avec un délai borné. Il retire de
l'environnement les clés d'API et les variables prescrites par `env.strip`.

- `claude -p "<prompt>" --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands --permission-mode dontAsk --model <modele> --max-budget-usd <budget> --output-format json`.
- `codex exec --sandbox read-only --skip-git-repo-check -o <fichier> -`.
  Le prompt passe sur stdin. Le daemon relit le fichier et ajoute
  `-m <modele>` si un modèle explicite est demandé.
- `vibe -p "<prompt>" --max-turns 1 --output json --max-price <budget> --enabled-tools ""`.
  Vibe utilise son modèle configuré.

Un CLI absent donne un avis en `echec` avec « CLI absent ». Les autres avis
se poursuivent.

## Contraintes

Avant tout lancement, le daemon filtre la question et chaque sous-question.
Il refuse les textes trop longs, les textes qui ressemblent à des secrets,
les hôtes privés et les adresses privées. Le refus indique seulement sa classe.

Le texte d'une question ne passe dans aucun journal.

| Code | Résultat                                       |
| ---- | ---------------------------------------------- |
| 0    | Chaque accord est unanime ou majoritaire.      |
| 4    | Au moins un accord est partagé ou insuffisant. |
| 3    | Aucun avis valide.                             |
| 2    | Refus ou erreur de demande.                    |

## Routage

| Entrée de `routage` | Défaut                                                                                |
| ------------------- | ------------------------------------------------------------------------------------- |
| `niveaux.leger`     | Claude, `haiku`                                                                       |
| `niveaux.standard`  | Claude, `sonnet`                                                                      |
| `niveaux.fort`      | Claude, `opus`                                                                        |
| `challenge`         | `[claude, codex, vibe]`, un avis chacun. Codex et Vibe gardent leur modèle configuré. |

Dans `agent.yml`, surcharge `routage` seulement en cas d'écart avec
`defaults.yml`. Sous `routage.niveaux`, chaque niveau surchargé indique
`fournisseur` et `modele`. Sous `routage.challenge`, indique la liste de
fournisseurs voulue. Le CLI livré au point 66.3 lit encore la table intégrée
au code.
