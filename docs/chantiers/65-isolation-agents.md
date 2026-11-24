# Chantier 65 : un agent borné à son worktree (bubblewrap)

| Champ | Valeur |
|---|---|
| État | **Révision 0, 24 novembre 2026.** Risque 2 des zones d'ombre de la note d'idéation de Julien du 17 novembre (§14). Arbitrage de Julien du 24 novembre : un bac à sable OS, bubblewrap sous Linux et WSL ; le réseau et les credentials de l'agent lui sont laissés. |
| Emplacement final | `docs/chantiers/65-isolation-agents.md` sur `main` |
| Base | `main` |
| Organisation | Comme au 63 : cell-gestion gère le chantier, Codex CLI écrit le code et les tests, cell-gestion relit, lance le gate, commite et ouvre la PR. |
| Validation | Le gate est vert à chaque point, puis `gate:e2e`. La recette se fait sur la tour (WSL), avec un vrai `claude` et un vrai `codex`. Le merge se fait sur le oui de Julien, CI verte. |

## 1. Pourquoi

Dans A-I-D, un agent est une vraie session Claude Code ou Codex, lancée dans le home de Julien avec ses outils et ses abonnements. « Les écritures sont bornées au worktree » : c'est dit, pas imposé.

La note pose cette isolation comme préalable à deux choses : la boucle dans le daemon, et le merge automatique. « Avec un merge automatique, le pire scénario est un agent qui modifie autre chose que son worktree. »

Swairm avait des drones avec un HOME jetable et zéro credential. A-I-D ne peut pas le reprendre tel quel : ses agents ont besoin de leurs abonnements. Ce chantier borne donc les **écritures**, et cache les secrets dont l'agent n'a pas besoin.

## 2. Cible et hors-périmètre

**Cible.**
- Avec `agents.isolation: bwrap`, tout agent `claude` ou `codex` lancé par le daemon, en `stream` comme en `pty`, tourne dans bubblewrap :
  - le système de fichiers est lisible, et inscriptible seulement là où il le faut ;
  - les secrets d'A-I-D et ceux qui servent à pousser sont invisibles.
- La configuration qui s'exécute plus tard hors du bac à sable reste en lecture seule : les hooks git, la configuration git, les réglages de Claude Code. Sinon, une écriture dans le bac à sable deviendrait une exécution hors de lui.

**Hors-périmètre.**
- Le réseau. L'agent garde l'accès à son fournisseur et au daemon, en `127.0.0.1`.
- macOS. Il n'y a pas d'équivalent maintenu de bubblewrap, et `isolation: bwrap` y est refusé au démarrage, avec un message.
- `shell`, `swarph-cell` et `swairm-cell`. Ce sont des sessions de l'humain ou des cells du maillage, pas des agents de sujet. Elles restent hors du bac à sable, et l'écran le dit.
- Les bacs à sable propres aux agents (`codex --sandbox`, celui de Claude Code). Ils restent utilisables en plus du nôtre. Ce chantier ne s'appuie pas sur eux : il veut une règle commune aux deux.

## 3. Décisions

### DM42. Le profil d'écriture

L'agent voit `/` en lecture seule (`--ro-bind / /`), avec `--dev /dev` et `--proc /proc`. Il peut écrire :

| Où | Pourquoi |
|---|---|
| le worktree du sujet | son travail |
| le répertoire git commun du dépôt (`git rev-parse --git-common-dir`) | un commit dans un worktree écrit les objets et les refs dans le `.git` du dépôt principal |
| `AID_SPOOL` et `attachments/<agent>` | les événements et les pièces jointes |
| un `/tmp` propre à l'agent (`--tmpfs /tmp`) | les fichiers temporaires |
| `~/.claude`, `~/.claude.json`, `~/.codex` | l'état de session, et le rafraîchissement du jeton d'abonnement |
| les caches de paquets (`~/.npm`, `~/.cache`) | `npm install` et ses pareils |

### DM43. Ce qui reste en lecture seule à l'intérieur des zones inscriptibles

Une écriture dans ces fichiers s'exécuterait plus tard, hors du bac à sable. Ils sont donc remontés en lecture seule par-dessus :
- **dans le `.git` commun** :
  - `config` et `hooks/` ;
  - `refs/heads/main` et `packed-refs`.

  Un agent ne peut ni déplacer `main` ni ajouter un hook. Un `git pack-refs` ou une suppression de branche échoue dans le bac à sable : c'est accepté et documenté.
- **dans `~/.claude`** :
  - `settings.json`, où vivent les hooks, dont ceux d'A-I-D ;
  - `CLAUDE.md` ;
  - `commands/`, `agents/`, `skills/` et `plugins/`.
- **dans `~/.codex`** : `config.toml`.

Un fichier absent n'est pas monté. Il n'est pas créé, pour ne pas changer la machine.

**Le risque qui reste.** `~/.claude.json` reste inscriptible, parce que Claude Code y écrit sans cesse. Or il porte les serveurs MCP déclarés. Le risque est nommé dans la fiche, et sera revu au chantier de la boucle.

### DM44. Ce qui est caché

Ces chemins sont recouverts par un `--tmpfs` vide quand ce sont des dossiers. Un fichier est recouvert par un fichier vide :
- **A-I-D** : tout `AID_HOME` (`state.db`, `session.secret`, `config.yaml`, les journaux et les autres worktrees), sauf le spool et le dossier de pièces jointes de l'agent, remontés par-dessus ;
- **les identités qui servent à pousser** : `~/.ssh`, `~/.gnupg`, `~/.config/gh` et `~/.git-credentials`.

  C'est la règle des trois acteurs (§11 de la note, et swarph) : l'orchestrateur seul pousse. Un agent de sujet commite, il ne pousse pas, et il n'ouvre pas de PR ;
- **les autres dépôts du home** : pas dans ce chantier. Ils restent lisibles, et la fiche le dit.

L'agent parle au daemon par `AID_URL` et son jeton de run, comme aujourd'hui. Il n'a pas besoin de la base.

### DM45. Le lanceur

- `src/daemon/isolation/bwrap.ts` construit l'argv de bwrap à partir d'un `ProfilIsolation` (le worktree, le git commun, le home, les chemins d'A-I-D et l'agent). C'est une fonction pure, testée sans lancer bwrap.
- Le mode `stream` passe par le `spawnChild` existant (D75) : le lanceur isolé préfixe `bwrap <args> --` à la commande.
- Le mode `pty` préfixe de la même façon l'appel à `getPty().spawn`.
- Les options de bwrap :
  - `--die-with-parent` et `--new-session`. En PTY, sans `--new-session`, puisque le terminal doit rester attaché : le point 65.3 le vérifie ;
  - `--unshare-pid` ;
  - pas de `--unshare-net`.
- Au démarrage du daemon, avec `isolation: bwrap`, `bwrap` doit être dans le PATH et passer une sonde (`bwrap --ro-bind / / true`). Sinon, le daemon refuse de démarrer, avec le message « isolation demandée mais bubblewrap indisponible : … ». Il ne retombe jamais en silence sur un lancement non isolé.
- `agents.isolation` vaut `off` par défaut dans ce chantier. Le passage à `bwrap` par défaut sera décidé après la recette.

### DM46. Ce que l'agent et l'humain voient

- `aid doctor` montre une ligne « Isolation : bwrap (version) » ou « Isolation : off ».
- La carte de l'agent dans la vue du sujet porte une petite marque « isolé » ou « non isolé ».
- Le bloc rendu du noyau dit que, sous isolation, un `git push`, un `gh` ou une écriture hors du worktree échouent normalement, et qu'il ne faut pas les contourner.

## 4. Points

### 65.1 Le plan

Ce document, et une ligne dans `docs/chantiers/README.md`.

### 65.2 Le profil et l'argv (DM42 à DM44)

`src/daemon/isolation/bwrap.ts` et `agents.isolation` dans la configuration.

Les tests portent sur l'argv seul :
- l'ordre des montages : le plus général d'abord, les recouvrements ensuite ;
- les chemins absents ignorés ;
- le git commun déduit, puis donné ;
- `AID_HOME` caché et ses deux exceptions ;
- les identités de poussée cachées.

- _Révision 65.2._ Fait :
  - `agents.isolation: off | bwrap`, à `off` par défaut ;
  - `src/daemon/isolation/bwrap.ts`, avec `argvBwrap` pur et `gitCommunDe` sans repli. L'ordre est le suivant : la base, les zones cachées, les zones inscriptibles, puis les recouvrements en lecture seule ;
  - un worktree sous `AID_HOME` est remonté après le tmpfs ;
  - un chemin absent n'est jamais monté.

  Gate 4 695.

### 65.3 Le lancement (DM45)

- Le branchement en `stream` et en `pty`.
- La sonde au démarrage et le refus explicite.
- macOS refusé.

Les tests utilisent un faux `bwrap`, qui écrit son argv et lance la commande. Un test d'intégration, sauté si `bwrap` est absent, lance un vrai `bwrap` sur un `sh` et vérifie quatre choses :
- une écriture dans le worktree passe ;
- une écriture dans le home échoue ;
- `.git/hooks` est en lecture seule ;
- `~/.ssh` est vide.

- _Révision 65.3._ Fait :
  - `lanceur.ts` : `profilPour`, `envelopper` et `spawnChildIsole` ;
  - dans `manager.ts`, les `claude` et `codex` locaux sont enveloppés, en PTY comme en stream. Un profil impossible renvoie une 422 sans lancement, et la commande enregistrée reste celle de l'agent ;
  - `isole` sur l'agent ;
  - la sonde au démarrage (`sonde.ts`) : refus hors Linux, sans bwrap, ou sur une sonde en échec ;
  - `bwrapVersion` dans `/api/state`.

  14 tests. Le test d'intégration est sauté sur le VPS, faute de bwrap : il est à lancer sur la tour. Gate 4 709.

### 65.4 La visibilité, le noyau et la fiche (DM46)

- La ligne d'`aid doctor`, la marque sur la carte, la phrase du noyau et le changelog.
- La fiche `docs/recette-chantier-65-isolation-agents.md`, sur la tour : installer bubblewrap, passer `isolation: bwrap`, lancer un `claude` puis un `codex` dans un sujet. Elle vérifie :
  - un commit passe ;
  - un `git push` échoue ;
  - l'écriture d'un fichier dans le home échoue ;
  - un hook git ne peut pas être ajouté ;
  - le jeton d'abonnement se rafraîchit, la session survit au lendemain ;
  - la reprise fonctionne.

## 5. Pièges

- **Ne jamais retomber en silence.** Un daemon réglé en `bwrap` qui lancerait un agent non isolé parce que bwrap manque est pire qu'un daemon en `off` : on croit être protégé.
- **L'ordre des montages compte** dans bwrap. Un recouvrement placé avant son parent est écrasé.
- **Le `.git` commun est la vraie surface.** Ce qui s'y exécute plus tard (`hooks/`, `config` et son `core.hooksPath`, `core.fsmonitor`) doit rester en lecture seule. Sinon, l'isolation se contourne au prochain `git status` de Julien.
- **`--new-session` et le PTY.** `--new-session` détache l'agent du terminal de contrôle : à vérifier en PTY avant de le garder.

## 6. Fini quand

- Avec `agents.isolation: bwrap` sur la tour, un agent de sujet peut lire tout le système et travailler dans son worktree. Il ne peut ni écrire ailleurs, ni pousser, ni lire les secrets d'A-I-D.
- Le daemon refuse de démarrer si l'isolation est demandée et indisponible.
- La boucle dans le daemon et le merge automatique peuvent s'appuyer sur cette garantie.
