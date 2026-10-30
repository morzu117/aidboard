# Chantier 16 — Composer : mode, modèle, pièces jointes

Branche `feat/composer-mode-modele-pj`, base `main`. Demande de l'opérateur du 2026-10-30 :
la fenêtre de discussion d'un agent conversationnel (`transport: 'stream'`, chantier 15
groupe A) doit permettre (1) un **mode auto** pour ne plus valider chaque demande de
permission, (2) le **choix du modèle** (et de l'effort), (3) l'**ajout de pièces jointes**.
Le brief de refonte (`design/aid-refacto-agent-ui/BRIEF.md` §4 « Composer », §5.3 « Zone de
saisie ») et la maquette `Main.dc.html` prévoient déjà ces trois éléments : chip « mode »,
chip « modèle · effort », bouton trombone.

**Base de vérité** : formes observées le 2026-10-30 sur les CLI réelles (claude 2.1.308,
codex-cli 0.157.0), pas déduites d'une documentation.

- claude, en `stream-json` sur stdin, sans tour de modèle :
  `{"type":"control_request","request_id":"r1","request":{"subtype":"set_permission_mode","mode":"auto"}}`
  → `control_response` success `{"mode":"auto"}` puis `system/status` `permissionMode: "auto"`.
  Mode inconnu → `subtype: "error"`, `error_code: "invalid_mode"` (valeurs acceptées :
  `acceptEdits, auto, bypassPermissions, default, dontAsk, plan`).
  `{"subtype":"set_model","model":"sonnet"}` → success `{"model":"claude-sonnet-5-5"}`.
  `{"subtype":"apply_flag_settings","settings":{"effortLevel":"high"}}` → success.
  Au lancement : `--permission-mode <mode>`, `--model <alias>`, `--effort <niveau>`
  (`low, medium, high, xhigh, max`), `--add-dir <dossier>`.
- codex `app-server` (schéma `codex app-server generate-json-schema`) : `turn/start` accepte
  `approvalPolicy` (`untrusted | on-request | never`), `model`, `effort`, chacun valant
  « pour ce tour et les suivants » ; `input` accepte `{type:'localImage', path}` ; `model/list`
  rend `data[]` `{id, model, displayName, hidden, isDefault, defaultReasoningEffort,
  supportedReasoningEfforts[{reasoningEffort, description}]}`.

## Décisions (validées par l'opérateur le 2026-10-30)

| N° | Décision | Choix |
| --- | --- | --- |
| D66 | **Modes proposés** | claude : Demander (`default`) · Modifs auto (`acceptEdits`) · Auto (`auto`, classifieur claude) · Plan (`plan`). codex : Demander (`on-request`) · Auto (`never`, la sandbox `workspace-write` reste la garde). Jamais `bypassPermissions` ni `danger-full-access`. |
| D67 | **Défaut d'un nouvel agent** | Le dernier réglage choisi pour ce `kind` (table `agent_defaults`), sinon `default` et le modèle par défaut de la CLI. Chaque agent garde ensuite le sien (colonnes `agents.permission_mode/model/effort`), y compris à la relance (A.6). |
| D68 | **Changement en cours de session** | Sans relancer le process : `control_request` côté claude, paramètres de `turn/start` côté codex (appliqués au tour suivant). Un réglage changé pendant qu'un agent dort est appliqué à sa relance par les arguments de lancement. |
| D69 | **Journal** | Un événement `agent.settings` `{kind, mode, model, effort}` projeté sur `agents` et `agent_defaults` dans la même transaction (D10) : la reconstruction depuis le journal redonne les deux tables. |
| D70 | **Pièces jointes** | Déposées hors worktree, sous `~/.aid/attachments/<agentId>/` (dossier 0700, fichiers 0600), jamais dans git. Images : passées en ligne au modèle (bloc `image` base64 pour claude, `localImage` pour codex). Autres fichiers : cités par leur chemin dans le message ; claude reçoit `--add-dir` sur ce dossier pour les lire sans demande. Au plus 5 fichiers de 10 Mio. Réservé aux agents `stream`. |
| D71 | **Catalogue des modèles** | claude : liste fixe d'alias (`fable`, `opus`, `sonnet`, `haiku`) dans le partagé. codex : `model/list` interrogé par le pilote après la poignée de main, gardé en mémoire ; tant qu'aucun pilote codex n'a répondu, seul « Par défaut » est proposé. |

## Points

Un point = un commit. `npm run gate` vert à chaque point ; `npm run gate:e2e` en fin de
chantier.

**16.1 — Réglages d'agent : modèle, journal, projection**
- `migrations/013_agent_settings.sql` : `agents.permission_mode`, `agents.model`,
  `agents.effort` (TEXT NULL) ; table `agent_defaults (kind PK, permission_mode, model, effort)`.
- `src/shared/agentSettings.ts` : types `PermissionMode`, `AgentSettings`, catalogue des modes
  par kind (D66), modèles et efforts claude (D71), `ModelOption`, `AgentOptions`.
- `src/shared/events.ts` : `agent.settings`. Projection dans `events/projectors.ts`.
- `Agent` (`shared/model.ts`) porte `permissionMode`, `model`, `effort` ; `state/snapshot.ts`
  les lit.
- Preuve : `test/events.test.ts` — projection et reconstruction.
- Commit : `feat(agents): réglages mode/modèle/effort par agent, journalisés`.

**16.2 — Pilotes : lancement et changement à chaud**
- `ConversationDriverOptions.settings?` ; `ConversationDriver.configure(settings)` ;
  `catalog?()` (codex).
- claude : `buildClaudeArgs` ajoute `--permission-mode`, `--model`, `--effort`, `--add-dir` ;
  `configure` envoie `set_permission_mode`, `set_model`, `apply_flag_settings`.
- codex : `approvalPolicy` initial selon le mode ; `turn/start` porte `approvalPolicy`,
  `model`, `effort` du réglage courant ; `model/list` après `thread/start|resume`.
- Faux agents : le faux claude journalise les `control_request` reçus ; le faux codex
  répond à `model/list` et renvoie les paramètres de `turn/start`.
- Preuve : `test/conversation-claude.test.ts`, `test/conversation-codex.test.ts`.
- Commit : `feat(conversation): mode, modèle et effort transmis aux pilotes, à chaud`.

**16.3 — Daemon : routes et défauts par kind**
- `PATCH /api/agents/:id/settings` `{mode?, model?, effort?}` (validé contre le catalogue du
  kind, 422 sinon) ; `GET /api/agents/:id/options` → `AgentOptions`.
- `AgentManager.setSettings` : événement `agent.settings`, puis `driver.configure` si le
  pilote est vivant. `spawnStream` part de `agent_defaults` ; `resumeStream` des colonnes de
  l'agent.
- Preuve : `test/agent-stream.test.ts` — défaut hérité, changement à chaud, relance.
- Commit : `feat(agents): routes de réglages et défaut retenu par kind`.

**16.4 — Daemon : pièces jointes**
- `POST /api/agents/:id/input` accepte `attachments?: [{name, type, data}]` (base64) ; texte
  vide permis s'il y a au moins une pièce jointe. Limite de corps de la route relevée.
- `inputStream` écrit les fichiers (D70), enregistre le message utilisateur avec
  `attachments: [{name, type, size}]`, puis `driver.send(text, files)`.
- `ConversationEvent` `message` : `attachments?` optionnel.
- Preuve : `test/agent-stream.test.ts` — fichier écrit hors worktree, mode 0600, bloc image
  reçu par le faux claude, refus au-delà des limites et pour un agent PTY.
- Commit : `feat(conversation): pièces jointes envoyées à l'agent`.

**16.5 — Composer : chips mode et modèle**
- `web/src/conversation/Composer.tsx` : chip mode (`▸▸ <mode>`) et chip modèle
  (`<modèle> · <effort>`), menus déroulants alimentés par `GET …/options`, `PATCH …/settings`.
  Styles de la maquette (`#16191e`, bordure `#23272e`, rayon 6) via les variables existantes.
- Preuve : `test/web/conversation.test.tsx`.
- Commit : `feat(conversation): sélecteurs de mode et de modèle dans le composer`.

**16.6 — Composer : pièces jointes**
- Bouton trombone (`input type=file multiple`), collage d'image, glisser-déposer ; puces
  retirables au-dessus de la barre ; envoi avec le message. La bulle utilisateur liste les
  noms des pièces jointes.
- Preuve : `test/web/conversation.test.tsx`.
- Commit : `feat(conversation): joindre des fichiers et des images depuis le composer`.

## Hors périmètre

- Agents PTY (`transport: 'pty'`) : inchangés ; les chips ne s'affichent que pour `stream`.
- File d'attente des messages pendant un tour (brief §5.3, « à confirmer ») : inchangé.
- Purge des pièces jointes : elles restent sous `~/.aid/attachments/` comme les journaux.
