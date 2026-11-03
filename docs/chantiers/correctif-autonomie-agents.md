# Correctif — autonomie des agents en mode Auto

## Plan — 2026-11-03

L'opérateur demande que les agents exécutent un plan de développement, commitent,
ouvrent et fusionnent les PR prévues, et puissent lancer un autre agent pour la
review sans confirmations répétées. Cette demande remplace D66 du chantier 16
pour le mode Auto : Codex utilise `never` avec `danger-full-access` ; Claude
utilise `bypassPermissions`. Les modes Demander, Modifs auto et Plan gardent leur
fonction. Le choix Auto reste enregistré par le mécanisme de réglages existant.

Un point, un commit : aligner lancement, reprise et changement à chaud des deux
pilotes ; tester l'entrée et la sortie du mode Auto et les reprises. Les règles
explicites de confirmation des serveurs distants restent un réglage distinct.
Pas de changement de manifeste, de version, de CI ni de défaut global des agents.

Diagnostic manuel : Codex 0.166.0, `command/exec`, configuration temporaire,
aucun appel de modèle. `git add` échoue sous `workspaceWrite` sur `.git/index.lock`
et `.git/worktrees/worktree/index.lock` ; il réussit hors sandbox dans les mêmes
dépôts jetables. Le mode `never` empêchait toute demande d'élargissement.

CodeGraph absent de ce worktree : rayon d'impact structurel non établi. Lecture
ciblée des pilotes, du gestionnaire distant et de leurs tests. gbrain absent et
mémoire AID injoignable ; plan et handoffs conservés ici en repli déclaré.

Validation : faux agents dans les tests automatiques, gate complet, gate e2e,
gate sous Node 24, review par une instance Claude séparée sans outils. Les
vérifications manuelles des CLI réelles ne lancent pas de tour de modèle.

### Précisions de validation

- Codex 0.166.0 : `command/exec` en `dangerFullAccess` réussit les deux `git add`
  qui échouent en `workspaceWrite`, mêmes dépôts et mêmes fichiers.
- Claude 2.1.308 : avec `--allow-dangerously-skip-permissions`, les requêtes
  `set_permission_mode` vers `bypassPermissions`, puis `default`, répondent
  chacune `success`. Aucun message utilisateur ni appel de modèle.
- Une reprise en mode Demander doit explicitement rétablir ce mode, même si
  la session sauvegardée était autonome : ne pas laisser la CLI reprendre
  une ancienne permission par simple omission de l'option au lancement.

## Dev — handoff (2026-11-03)

Un seul commit, point unique du plan ci-dessus.

**Codex** (`src/daemon/conversation/codex.ts`) — `approvalAndSandbox()` centralise
la traduction Auto → `never` / `danger-full-access`, reprise à l'identique par
`thread/start`, `thread/resume` (qui porte désormais aussi `cwd`, absent avant ce
correctif) et `turnSettings()`. `turn/start` prend un champ distinct,
`sandboxPolicy` (objet), de `thread/start`/`thread/resume` qui prennent `sandbox`
(chaîne) — confirmé par `codex app-server generate-json-schema` (CLI locale
0.166.0, v2/TurnStartParams.json vs v2/ThreadStartParams.json), pas supposé.
`sandboxPolicyOf()` traduit la chaîne `sandbox` vers cet objet (`workspaceWrite`
avec `writableRoots: [cwd]`, `dangerFullAccess`, `readOnly`) ; une valeur non
reconnue ne reçoit aucune policy plutôt que d'en inventer une. Recalculée à
chaque tour à partir du mode courant : sortir d'Auto renvoie explicitement
`workspaceWrite`, sans dépendre de l'historique des tours précédents.

**Claude** (`src/daemon/conversation/claude.ts`) — `claudePermissionMode()`
traduit le mode A-I-D `auto` vers `bypassPermissions` chez claude, au lancement
(`settingsArgs`) et au changement à chaud (`configure`) ; les autres modes
passent tels quels. `buildClaudeArgs` ajoute `--allow-dangerously-skip-permissions`
de façon systématique (CLI 2.1.308, confirmé par `claude --help`) : il autorise
la capacité d'entrer en `bypassPermissions` sans l'activer lui-même, nécessaire
pour qu'un process lancé hors Auto puisse y basculer par un `set_permission_mode`
ultérieur. Reprise : `buildClaudeArgs` est rappelé à chaque lancement (y compris
`--resume`) avec les réglages courants — aucun code supplémentaire n'était
nécessaire pour que la reprise applique le réglage.

**`RemoteAgentManager`** (`src/daemon/remote/agents.ts`) : vérifié, pas modifié.
`mount()` ramène déjà `settings.mode` à `'default'` avant de construire les
options du pilote quand `confirm.autoApprove` (serveur sous confirmation) —
ce qui précède mon changement dans `CodexDriver` empêche donc `never` /
`danger-full-access` de jamais être atteints sous confirmation distante ;
`approvalPolicy: 'untrusted'` reste ce qui part dans `confirmOpts`.

**Portée non touchée** : `src/shared/agentSettings.ts` — seul le commentaire
obsolète (ligne 1) est corrigé ; aucun changement de type, de `MODES`, ni de
validation d'API (`PATCH /settings` continue de refuser `bypassPermissions` /
`danger-full-access` en entrée : seul le mot A-I-D `auto` déclenche la
traduction, côté pilote).

**Tests** — `test/fixtures/fake-codex-appserver.mjs` : capture les paramètres
reçus par `thread/start`/`thread/resume` (`lastThreadStart`/`lastThreadResume`,
lus par un tour `session_params`), et `turn/start` échote désormais aussi
`sandboxPolicy` dans son tour `reglages`. Nouveaux tests dans
`test/conversation-codex.test.ts` : Auto → défaut → Auto (sandboxPolicy à
chaque tour), `thread/start` et `thread/resume` en Auto (never, danger-full-access,
cwd), hors Auto (réglages explicites inchangés). Nouveau test dans
`test/conversation-claude.test.ts` : claude default → auto → default
(bypassPermissions au contrôle à chaud, puis retour). Expectations existantes
mises à jour là où elles vérifiaient l'ancien comportement (`approvalPolicy`
sans `sandboxPolicy`, `--permission-mode auto` littéral) — comportement
volontairement changé par ce correctif, pas affaibli : toujours une vérification
exacte (`toEqual`), jamais élargie ni supprimée.

**Validation** — `npm run gate` complet, vert : typecheck, lint (y compris
`prettier --check`, un fichier reformaté par `prettier --write` après l'édition),
build, 1374 tests passés (2 skip pré-existants, non touchés). Pas de test
retiré, pas de seuil abaissé. `gate:e2e` et le gate sous Node 24 laissés à
l'orchestrateur, comme demandé.

**Limites** — CodeGraph absent de ce worktree : rayon d'impact structurel non
établi, lecture ciblée à la place (déclaré en tête de ce document). gbrain et
mémoire A-I-D injoignables : rien écrit hors ce document. Le format exact de
`sandboxPolicy`/`SandboxMode` vient de la CLI codex locale (0.166.0) via
`generate-json-schema` et de `claude --help` (2.1.308) plutôt que d'un index
ou d'une doc interne — à revérifier si la CLI embarquée par le paquet diffère
de la CLI locale utilisée pour ce diagnostic. Aucun credential GitHub utilisé,
aucun push, aucune PR, aucun merge : commit local sur `fix/codex-git-permissions`
uniquement.
