<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/marque/aid-logo-arrondi_with_text.svg">
  <img src="design/marque/aid-logo-arrondi_with_text-sombre.svg" alt="A-I-D Board" height="60">
</picture>

Cockpit local pour piloter des agents de code (Claude Code, Codex, un shell) sur plusieurs sujets en parallèle.
Un **sujet** est une branche git et son worktree ; chaque agent tourne dans un terminal persistant du navigateur :
fermer l'onglet n'arrête rien.

## Prérequis

| Plateforme | À installer avant                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS      | Node 22 à 24, git                                                                                                                                                                                                                          |
| Linux      | Node 22 à 24, git, **`sudo apt install build-essential python3`** (node-pty n'a pas de binaire précompilé pour Linux)                                                                                                                      |
| Windows    | **WSL2 uniquement, jamais en natif.** Dans WSL2 : comme Linux, plus `sudo apt install wslu` pour que le navigateur Windows s'ouvre tout seul. Garder les dépôts dans le système de fichiers Linux (`~/…`), pas sous `/mnt/c` : c'est lent. |

Facultatifs : `claude`, `codex` (les agents), `codegraph` (index structurel), `gh` (utile à partir de la v0.3).

## Installation et lancement

```bash
npm i -g aidboard     # donne les commandes `aidboard` et `aid`
aid                   # lance le daemon s'il ne tourne pas, ouvre le navigateur
```

ou, sans installer : `npx aidboard`.

| Commande                       | Effet                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `aid`                          | démarre le daemon (détaché, ses agents survivent au terminal) et ouvre le navigateur                    |
| `aid open`                     | rouvre le navigateur sur le daemon qui tourne                                                           |
| `aid status`                   | pid, port, nombre de sujets et d'agents vivants                                                         |
| `aid stop`                     | arrête le daemon ; **refusé tant que des agents tournent** (code 2)                                     |
| `aid stop --force`             | arrête le daemon et tous ses agents                                                                     |
| `aid doctor`                   | vérifie la machine et dit quoi corriger                                                                 |
| `aid kernel install [--check]` | matérialise le noyau multi-agents (`kernel/`) dans `~/.agent-kernel` ; `--check` ne touche rien         |
| `aid mem …`                    | lit, écrit et cherche dans la mémoire locale (`get`, `put`, `search`, `list`, `rm`, `export`, `import`) |
| `aid mcp`                      | serveur MCP « aid » (stdio) : mémoire locale et index structurel (`index_*`) pour un agent              |

Enregistrement auprès de Claude Code : `claude mcp add --scope user aid -- aid mcp`.

Premier pas : « Nouveau sujet » dans la barre. Sans dépôt enregistré, A-I-D demande d'abord le chemin de la racine d'un
dépôt git (qui doit avoir un remote `origin`).

Au premier lancement de `claude` ou de `codex` dans un worktree neuf, l'agent affiche **son propre** dialogue de
confiance : c'est normal, A-I-D n'y touche pas.

## Ce qu'A-I-D fait et ne fait pas

- Il écoute **uniquement sur `127.0.0.1`** et refuse de démarrer ailleurs. Le lien d'ouverture porte un token aléatoire
  échangé contre un cookie `HttpOnly`, `SameSite=Strict` ; `Host` et `Origin` sont vérifiés sur REST et WebSocket.
- Un agent ne reçoit qu'un droit d'émettre des événements pour son run : il ne peut ni lancer une action, ni ouvrir un
  shell, ni valider ses propres demandes.
- `ANTHROPIC_API_KEY` et `ANTHROPIC_AUTH_TOKEN` sont **retirés de l'environnement des agents** : leur présence ferait
  basculer `claude` de l'abonnement vers la facturation à l'API. Réglable (`env.strip`).
- Aucun code, diff ni journal ne quitte la machine.
- Il n'ajoute rien dans les dépôts : seuls les worktrees, créés sous `~/.aid/worktrees/`, y sont visibles.
- `topic.cleanup` ne supprime jamais de travail : refus si le worktree a des modifications non commitées, et si des
  commits ne sont pas dans `origin/<base>` il faut confirmer en répétant leur nombre exact.

## Où sont les données

```
~/.aid/
  config.yaml      réglages facultatifs (port 4870, éditeur, rétention des journaux…)
  state.db         sujets, runs, agents, journal d'événements (SQLite)
  daemon.json      pid, port et token du daemon qui tourne (0600)
  daemon.log       journal du daemon
  logs/            sortie brute de chaque terminal (0600, supprimée au-delà de 30 jours)
  worktrees/       un dossier par workspace puis par sujet
  memory/          mémoire locale, en markdown, sous git (dépôt séparé des workspaces)
```

`AID_HOME` change ce dossier. Les journaux de terminaux peuvent contenir des secrets : ne pas les partager.

## Le noyau multi-agents

`kernel/` (adapters, policy, roles, gabarit, commande `/sync`) est la
politique de routage de la connaissance, des phases et des rôles d'agent —
embarquée dans ce paquet, ancien dépôt séparé `agent-kernel` (fusionné,
chantier 09). `aid kernel install` la matérialise sur `~/.agent-kernel` et
installe `/sync` dans `~/.claude/commands/`. Dans un projet rattaché,
`/sync` résout le manifeste (`agent.yml`) et rend le bloc d'instructions
entre les marqueurs `<!-- agentkit:start --> … <!-- agentkit:end -->` de
`CLAUDE.md`/`AGENTS.md`. Le détail : `kernel/policy/routing.md`,
`kernel/commands/sync.md`.

## Développer

```bash
mise install            # Node 22
npm install
npm run gate            # typecheck, lint, build, tests
npm run gate:e2e        # gate + installation depuis le tarball + Playwright
npm run dev:daemon      # daemon au premier plan sur le build
npm run dev:web         # Vite sur 127.0.0.1:5173, proxy vers le daemon
```

En dev, lancer le daemon avec `AID_DEV_ORIGIN=http://127.0.0.1:5173` : sans cela, toute écriture depuis Vite répond 403.
Les plans de développement sont dans `docs/chantiers/`, les maquettes de référence dans `design/maquettes/`.

## Licence

[MIT](LICENSE).
