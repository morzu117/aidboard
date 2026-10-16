# A-I-D — brief de lancement

> A-I-D se prononce lettre par lettre. CLI : `aid`. Namespace mémoire : `aid`.
> Spec complète (référence humaine) : https://claude.ai/code/artifact/ab9cde6f-048f-47bb-a0cd-805a44312134
> Ce brief est autoporteur : un agent doit pouvoir démarrer la v0.1 sans lire la spec.

## 1. Le besoin

Julien fait travailler plusieurs agents de code en parallèle (Claude Code, Codex,
Cursor, la ruche Swairm, grokbot) sur plusieurs sujets à la fois. Aujourd'hui, tout
passe par des fenêtres VS Code et des onglets de terminaux. Il ne sait plus quel
sujet avance, lequel est bloqué, lequel attend un arbitrage de sa part, ni ce que
chaque agent a modifié.

A-I-D est une **web app locale** qui répond à une seule question, en permanence :
**qu'est-ce qui m'attend, et où en est chaque sujet ?**

Un sujet = une branche git + un worktree. Sur un sujet tournent un ou plusieurs
agents. Tout ce qui se passe devient un événement, et tout ce qui attend Julien
remonte dans une boîte de réception unique.

## 2. Décisions déjà prises

Ne pas les rediscuter sans escalade.

| Sujet | Décision |
| --- | --- |
| Forme | Web app locale : un daemon sur la machine + une UI dans le navigateur. Pas d'Electron en v1. |
| Plateformes | macOS, Linux, Windows **sous WSL2 uniquement** (jamais en natif), comme toute la chaîne agent-kernel. |
| Daemon | Node 22, TypeScript, Fastify, `ws`. Un seul process qui détient tout l'état. |
| Terminaux | `node-pty` côté daemon, `xterm.js` côté UI. Pas de tmux. |
| Front | React + Vite, xterm.js, éditeur diff Monaco. |
| Persistance | SQLite (`better-sqlite3`) dans `~/.aid/state.db` ; sortie brute des PTY dans `~/.aid/logs/<agentId>.log`. |
| Git | CLI `git` et `gh`, appelés par des scripts bash. Aucune bibliothèque git. |
| Distribution | Paquet npm, lancé par `npx aid` (ou `aid` installé globalement). |
| Consignes | **agent-kernel est la couche normative.** A-I-D n'invente aucun format de consignes et n'injecte rien dans les agents. |
| Configuration | A-I-D lit `agent.yml`, `defaults.yml`, `adapters/`. Aucun fichier A-I-D dans les repos en v1. Seul fichier propre : `~/.aid/config.yaml`. |
| Swairm | A-I-D ne lance ni ne pilote la ruche : il la suit par le CLI `swairm`, en lecture seule, qui rend un JSON versionné (`status`, `inbox`, `events`). Un workspace est relié à son board par son remote `origin` (`owner/dépôt`). GitHub ne porte plus que les branches et les PR. Pour agir (valider un plan, répondre, merger), on passe par le cockpit de la ruche. Décision du 2026-10-15. |
| grokbot | Agent cloud qui agit sur GitHub. Intégré par GitHub uniquement, aucun port entrant. |
| Réseau | Le daemon écoute **uniquement** sur `127.0.0.1`. |

## 3. Modèle

```
Workspace (un repo)
  └─ Sujet (branche + worktree, slug = <task> du kernel)
       └─ Run (mode: standard | swairm)
            └─ Agent (process local, ou agent distant observé)
Événement : journal append-only, seule source de l'état affiché
```

```ts
type RunMode = 'standard' | 'swairm';
type Phase = 'plan' | 'dev' | 'review' | 'triage' | 'retro';   // phases du kernel
type TopicState = 'draft' | 'active' | 'review' | 'merged' | 'archived';
type AgentStatus =
  | 'starting' | 'working' | 'needs_input' | 'idle'
  | 'done' | 'error' | 'stopped';

interface Agent {
  id: string;
  runId: string;
  kind: 'claude' | 'codex' | 'cursor' | 'shell'
      | 'swairm-drone' | 'swairm-queen' | 'grokbot-cloud';
  role: 'orchestrator' | Phase | 'free';
  transport: 'pty' | 'headless' | 'remote';
  status: AgentStatus;
  cwd: string;          // worktree du sujet
  command: string[];
  issue?: number;       // issue GitHub (grokbot)
}
```

**Slug.** Le slug d'un sujet est le `<task>` du kernel : un même identifiant relie la
branche, le worktree et les pages mémoire `aid`-préfixées du projet
(`<namespace>/plan/<task>`, `dev-handoff`, `review`, `retro`).

## 4. Événements

Toutes les sources écrivent le même format, une ligne JSON par événement. L'UI ne
connaît que ce format.

```json
{
  "v": 1,
  "id": "01JAB7Q3W8…",
  "ts": "2026-10-15T09:52:11.204Z",
  "source": "hook:claude",
  "workspaceId": "ws_…",
  "topicId": "tp_…",
  "runId": "run_…",
  "agentId": "ag_…",
  "type": "agent.status",
  "data": { "status": "needs_input", "reason": "permission", "message": "Autoriser Bash(npm test) ?" }
}
```

- `id` est un ULID : unique, triable, il rend l'ingestion idempotente.
- `source` ∈ `hook:claude`, `codex:json`, `swairm`, `github`, `daemon`, `action`, `heuristic`.
- Le statut affiché d'un agent est celui de son dernier `agent.status`. Seul le daemon dérive l'état.
- La sortie brute des terminaux n'est **pas** un événement : elle passe par le flux PTY.

Types v1 : `agent.spawned`, `agent.exited`, `agent.status`, `agent.tool`, `run.state`,
`run.command`, `approval.requested`, `approval.resolved`, `files.changed`, `cost`,
`action.started`, `action.finished`, `topic.state`, `topic.phase`.

**Raisons de `needs_input`.** Elles reprennent la liste fermée d'escalade du kernel
(`policy/orchestration.md`), plus deux cas propres aux sessions interactives et un
cas propre à la ruche :

| `reason` | Origine |
| --- | --- |
| `design` | finding de conception ou d'architecture |
| `scope` | dépassement de périmètre détecté au gate |
| `redev_cap` | sous-tâche encore rouge après `guardrails.redev_cap` re-dev |
| `budget` | garde-fou budget atteint |
| `ambiguity` | ambiguïté irréductible du besoin ou du plan |
| `delivery` | toutes les sous-tâches vertes : proposition de livraison |
| `permission` | session interactive qui demande une autorisation d'outil |
| `question` | session interactive qui pose une question |
| `hive` | la ruche Swairm attend Julien : un élément de `swairm inbox` (§7) |

**Émission : `aid emit`.** Le daemon injecte dans chaque PTY `AID_URL`, `AID_TOKEN`,
`AID_TOPIC`, `AID_RUN`, `AID_AGENT`. Un hook appelle
`aid emit agent.status --status needs_input --reason permission` ; la commande
complète l'enveloppe depuis l'environnement et la poste au daemon. Daemon absent :
écriture dans `~/.aid/spool/`, rejouée au démarrage. Hors A-I-D (`AID_AGENT` absent),
`aid emit` ne fait rien et sort en 0.

## 5. Git et worktrees

- Branche : `<type>/<slug>`, `type` ∈ `feat`, `fix`, `chore`, `spike`. Sujet né d'une issue : `<type>/<numéro>-<slug>`.
- Worktree : `~/.aid/worktrees/<workspace>/<slug>`, hors du repo.
- Base : toujours `origin/<baseBranch>` après `git fetch`.
- Jamais de push sur la branche principale. Jamais de merge sans validation humaine.

| Action | Effet | État du sujet |
| --- | --- | --- |
| `topic.create` | `git fetch`, `git worktree add -b <branche> <chemin> origin/<base>`, copie selon `.worktreeinclude`, `codegraph init` dans le worktree | `active` |
| `topic.sync` | rebase sur `origin/<base>` ; conflit → sujet en attente, shell proposé | inchangé |
| `topic.pr` | `git push -u`, `gh pr create`, URL enregistrée | `review` |
| `topic.merge` | `gh pr merge`, après validation `kind: merge` | `merged` |
| `topic.cleanup` | `git worktree remove`, branche locale supprimée ; refusé s'il reste du non-commité | `archived` |

**Index structurel.** `.codegraph/` est gitignoré : un worktree neuf n'a pas d'index.
`topic.create` lance `codegraph init`. S'il échoue ou n'est pas prêt, la fiche du sujet
affiche « index absent : lecture directe ». Le repli doit être **déclaré**, jamais
silencieux (`policy/routing.md`).

**Contrat des scripts.** `bash`, `cwd` = worktree du sujet (racine du repo pour
`topic.create`). Contexte par variables : `AID_REPO_ROOT`, `AID_TOPIC`, `AID_SLUG`,
`AID_BRANCH`, `AID_BASE`, `AID_WORKTREE`. stdout/stderr streamés dans l'UI. Une ligne
`::aid:: {"prUrl": "…"}` est lue comme résultat structuré. Code de sortie : `0`
succès, `2` action humaine requise, autre = erreur.

## 6. Intégration agent-kernel

| Niveau | Dans le kernel | Ce qu'A-I-D en fait |
| --- | --- | --- |
| Machine | `~/.agent-kernel` : `defaults.yml`, `policy/`, `roles/`, `adapters/` | Affiche la version, lance `bootstrap-machine.sh --check` |
| Projet | `agent.yml` + bloc entre `<!-- agentkit:start VERSION -->` et `<!-- agentkit:end -->` dans `CLAUDE.md` / `AGENTS.md` | Compare la version du marqueur à `~/.agent-kernel/VERSION`, propose `/sync` |
| Sujet | pages `<namespace>/plan/<task>`, `dev-handoff`, `review`, `retro` | Affiche plan, rayon d'impact, handoff, review ; en déduit `topic.phase` |

- Résolution du manifeste comme le kernel : `defaults.yml` < détection du repo < `agent.yml`.
- Agents de la chaîne : `capabilities.dev_agent` / `review_agent` + section « Appel » de `adapters/<nom>.md`.
- Un arbitrage rendu dans A-I-D s'écrit dans la page de plan du sujet (`gbrain put`), jamais dans `lessons`.
- gbrain pas à la version épinglée = **bloquant** : A-I-D refuse de lancer un agent qui écrirait en mémoire.

## 7. Modes

**Standard.** Julien ouvre un run, choisit ses agents ; le daemon les lance dans des PTY
(`cwd` = worktree, variables `AID_*`). Les hooks remontent les statuts. Quand la
session interactive joue l'orchestrateur du kernel, ses agents de phase (`claude -p`)
héritent des `AID_*` et remontent sous le même sujet ; leur `total_cost_usd` alimente
`cost`.

**Swairm (v0.4).** La ruche 2.0 tient son état dans un board local (un SQLite par
dépôt, sous `~/.swairm/boards/`) ; GitHub n'est plus que la forge. A-I-D ne lit jamais
ce board directement. Il lance le CLI `swairm` en sous-processus, comme `git` et `gh`,
et ne s'appuie que sur son JSON :

- `swairm status --json` (`swairm-status/1`) : les sujets de la ruche, leur état, leur
  colonne, leurs pas, les vols en cours. Un sujet de la ruche devient un sujet A-I-D en
  mode `swairm`, avec le même identifiant (sa branche `swairm/<slug>`). Sa branche et
  son worktree sont ceux de la ruche : les règles du §5 ne s'y appliquent pas, et
  A-I-D ne les crée ni ne les nettoie. Un vol en cours devient un agent
  `swairm-drone` observé (`transport: 'remote'`).
- `swairm inbox --json` (`swairm-inbox/1`) : chaque élément (décision, plan à valider,
  livraison à merger, sujet garé) devient un `needs_input` de raison `hive`, dédoublonné
  par sa `cle`. Le bouton ouvre le cockpit, car le CLI v1 n'écrit rien.
- `swairm events --project <owner/dépôt> --since <seq> --follow --json`
  (`swairm-event/1`) : un suivi par workspace en mode ruche. Chaque ligne devient un
  événement de `source: "swairm"`. A-I-D garde le dernier `seq` par projet pour
  reprendre après un redémarrage, et relit `status` et `inbox` à chaque événement reçu.

Le CLI marche ruche éteinte comme allumée. Son contrat (formats, codes de sortie,
installation) est `docs/cli-swairm.md` dans le dépôt swairm (chantier 06).

**grokbot (v0.5).** Ses issues alimentent une colonne « à démarrer » ; ses PR sont
suivies comme agents `grokbot-cloud` ; les arbitrages des sessions locales peuvent
passer par un dépôt privé `aid-inbox` (commandes `/aid approve|pause|resume`).
Jamais de code, de diff ni de log envoyé hors de la machine.

## 8. API du daemon

| Route | Rôle |
| --- | --- |
| `GET /api/state` | Instantané : workspaces, sujets, runs, agents, statuts |
| `POST /api/workspaces` | Enregistrer un repo |
| `POST /api/topics` | Créer un sujet (`topic.create`) |
| `POST /api/topics/:id/actions/:actionId` | Exécuter une action |
| `GET /api/topics/:id/diff?scope=uncommitted\|base` | Diff du sujet |
| `POST /api/runs` | Ouvrir un run |
| `POST /api/agents` / `DELETE /api/agents/:id` | Lancer / arrêter un agent |
| `POST /api/approvals/:id` | Répondre à une validation |
| `POST /api/events` | Ingestion (`aid emit`) |

WebSocket :
- `/ws/events` : abonnement (filtre `topicId` / `runId` optionnel) avec le dernier `id` reçu ; replay puis direct.
- `/ws/pty/:agentId` : sortie binaire ; le client envoie saisie et redimensionnements. À la connexion, le tampon circulaire est rejoué d'abord.

## 9. Sécurité

- Écoute `127.0.0.1` uniquement ; refus de démarrer sur une autre interface.
- Token aléatoire au démarrage, porté par l'URL d'ouverture puis échangé contre un cookie `HttpOnly`, `SameSite=Strict`.
- Vérification de `Host` et `Origin` sur REST et WebSocket (DNS rebinding, pages tierces).
- `AID_TOKEN` injecté dans les PTY = token par run limité à `POST /api/events`. Un agent ne peut ni lancer d'action, ni ouvrir de shell, ni valider ses propres demandes.
- Toute action marquée `confirm` exige un clic humain.
- Tout texte venant d'un agent est rendu comme du texte, jamais comme du HTML.

## 10. Premier jalon : v0.1 Socle

C'est le seul jalon à livrer maintenant. Les suivants sont listés en §11 pour
orienter les choix, pas pour être anticipés dans le code.

**Contenu**
1. Daemon Fastify + SQLite, schéma pour workspaces, sujets, runs, agents, événements.
2. Enregistrement d'un workspace (chemin d'un repo git local).
3. `topic.create` et `topic.cleanup` (scripts bash fournis), avec `codegraph init` et repli déclaré.
4. Lancement d'agents interactifs dans des PTY persistants (`claude`, `codex`, `shell`), tampon circulaire + journal disque, reconnexion sans perte.
5. UI : liste des workspaces et sujets, terminaux xterm.js en onglets par sujet, bouton « ouvrir dans l'éditeur ».
6. Sécurité du §9 dès la v0.1 (localhost, token, Origin).
7. Journal d'événements en place (`agent.spawned`, `agent.exited`, `topic.state`), même si les statuts fins arrivent en v0.2.

**Critères d'acceptation**
- [ ] Trois sujets tournent en parallèle, chacun avec une session Claude dans son worktree.
- [ ] Fermer l'onglet du navigateur puis le rouvrir : les agents tournent toujours, l'historique des terminaux est intact.
- [ ] `topic.cleanup` refuse un worktree avec des modifications non commitées.
- [ ] Un worktree sans index structurel affiche le repli déclaré.
- [ ] Une requête avec un `Origin` étranger ou sans token est rejetée.
- [ ] Testé sur macOS et sur un poste Windows en WSL2.

**Hors périmètre v0.1** : hooks et statuts fins, diff, actions configurables, kernel
(`/sync`, dérive), Swairm, grokbot, notifications.

## 11. Jalons suivants

| Version | Contenu | Terminé quand |
| --- | --- | --- |
| v0.2 Statuts et diff | `aid emit`, hooks Claude Code, `notify` Codex, heuristique, boîte de réception, notifications, vue diff | Un agent qui attend une permission est repéré sans ouvrir son terminal |
| v0.3 Git flow et kernel | Registre d'actions, lecture d'`agent.yml` et des adaptateurs, santé machine, dérive et `/sync`, phase du sujet, `sync`/`pr`/`merge`, sujet depuis une issue | Un sujet va de `draft` à `archived` sans quitter A-I-D ; un projet en retard sur le kernel est resynchronisé en un clic |
| v0.4 Ruche Swairm | Suivi par le CLI `swairm` : sujets et vols (`status`), boîte de réception (`inbox`), journal (`events --follow`), renvoi au cockpit pour agir | Un plan à valider ou une décision de la ruche arrive dans la boîte de réception d'A-I-D sans que le cockpit soit ouvert |
| v0.5 grokbot | PR grokbot suivies, sujets distants, `aid-inbox`, commandes `/aid` | Un arbitrage est rendu depuis le téléphone |

## 12. Contraintes de travail

- Ce repo se rattache à agent-kernel : lancer `/sync` pour produire `agent.yml` et le bloc de `CLAUDE.md` / `AGENTS.md` avant le premier cycle de dev. Namespace proposé : `aid`.
- Un point de plan = un commit. Gate complet vert avant de rendre.
- Aucun agent de dev ne pousse, n'ouvre de PR ni ne merge.
- Toute décision d'architecture non couverte par le §2 remonte à Julien au lieu d'être tranchée.

## 13. Questions ouvertes

Aucune ne bloque la v0.1.

- [x] Ruche : suivie par le CLI `swairm` en lecture seule (décision du 2026-10-15). Les labels et les commandes d'issue de la ruche v1 ne servent plus.
- [ ] Ruche : agir depuis A-I-D (valider un plan, répondre à une décision) demandera des commandes d'écriture au CLI `swairm`. À décider après la v0.4.
- [ ] Mode standard : A-I-D observe-t-il une session qui joue l'orchestrateur, ou lance-t-il lui-même la boucle BUILD → GATE → REVIEW → TRIAGE ?
- [ ] grokbot agit-il sous le compte GitHub de Julien ou sous le sien ?
- [ ] grokbot expose-t-il un déclencheur, ou la délégation par issue `aid:delegate` est-elle la seule voie ?
- [ ] Cursor CLI : lit-il `AGENTS.md`, a-t-il des hooks exploitables ?
- [ ] Codex interactif : quels signaux pour détecter une demande d'approbation au-delà du `notify` ?
- [ ] Reprise des sessions après redémarrage du daemon (`claude --resume`) : v0.2 ou plus tard ?
- [ ] Stratégie `topic.sync` par défaut : rebase (proposé) ou merge ?
