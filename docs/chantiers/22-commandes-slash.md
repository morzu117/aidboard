# Chantier 22 — Commandes `/` dans la conversation

Branche `feat/commandes-slash`, base `main` (`630e0db`, PR #99, #100, #103 et #105 mergées).

## Pourquoi

L'opérateur veut taper `/commande` dans le champ d'une conversation, avec **le même comportement quel que soit
l'agent** : claude, codex, et tout agent intégré demain.

Constat du 2026-11-02, sonde manuelle de claude 2.1.308 en `stream-json`, dans un dossier jetable :
- un `/context` envoyé tel quel est exécuté par claude, qui répond par un message synthétique, sans appel au modèle ;
- une commande inconnue part au modèle, qui répond qu'elle n'existe pas ;
- `/login` répond « isn't available in this environment » ;
- l'événement `system/init` de chaque tour annonce les commandes disponibles dans `slash_commands`
  (intégrées, skills, plugins : 120 chez l'opérateur, des noms sans description), et dans
  `terminal_slash_commands` celles qui n'ont de sens que dans un terminal
  (`doctor`, `color`, `focus`, `reload-plugins`).

Côté codex 0.157 (`codex app-server generate-json-schema`), il n'y a pas de commandes `/`. Le protocole offre
en revanche :
- `skills/list`, qui renvoie nom, description et chemin de chaque skill ;
- une entrée `{ type: 'skill', name, path }` dans `turn/start` ;
- `thread/compact/start`.

A-I-D, aujourd'hui, ne propose rien quand on tape `/` et ne dit pas ce qui est utilisable.

## Décisions

| N° | Décision | Pourquoi |
|---|---|---|
| D80 | Deux familles de commandes. Les **commandes A-I-D** sont les mêmes pour tous les agents et exécutées par A-I-D. Les **commandes de l'agent** sont annoncées par son pilote et exécutées par l'agent. | Même comportement partout. Un nouvel agent hérite des commandes A-I-D sans rien écrire, et n'a qu'à annoncer les siennes. |
| D81 | Les commandes A-I-D :<br>• `/model <id>`, `/effort <niveau>` et `/mode <id>` passent par le réglage existant (`PATCH settings`), avec les mêmes validations ;<br>• `/stop` interrompt le tour, comme le bouton Arrêter ;<br>• `/compact` compacte la conversation, et chaque pilote sait le faire (claude : le texte `/compact` ; codex : `thread/compact/start`) ;<br>• `/aide` liste les commandes. | Ce sont les commandes que les deux agents ont en commun, ou qu'A-I-D sait déjà faire pour tous. Elles ne partent jamais telles quelles à l'agent. |
| D82 | Contrat des pilotes : `commands(): AgentCommand[]` (nom, description, arguments), et `send` reconnaît ses propres `/nom`. Le daemon les expose dans `GET …/options` (champ `commands`), en local comme sur un serveur. | Même chemin que le catalogue de modèles (D71), sans nouvelle route de lecture. Le pilote distant délègue au pilote interne. |
| D83 | Pour claude, les commandes annoncées sont `slash_commands`, sans `terminal_slash_commands`, sans les commandes déjà couvertes par A-I-D, et sans `login`/`logout`, inutilisables sans terminal. Elles partent telles quelles, et claude les exécute. | C'est ce que claude fait déjà en `stream-json`. A-I-D ne fait que les rendre visibles. |
| D84 | Pour codex, les skills (`skills/list`) sont les commandes annoncées. `/nom arguments` devient l'entrée `skill`, suivie du texte des arguments. | C'est l'équivalent le plus proche des skills et commandes de claude. Le mécanisme est celui que codex propose, sans rien inventer. |
| D85 | Un `/xxx` inconnu part tel quel. Le menu indique « envoyé tel quel à l'agent ». | Ne rien bloquer. L'agent répond lui-même qu'il ne connaît pas la commande, comme aujourd'hui. |
| D86 | Le menu s'ouvre quand le message commence par `/` et ne contient pas encore d'espace. Il filtre par préfixe, puis par sous-chaîne. ↑ et ↓ déplacent la sélection, Tab ou Entrée complète, Échap ferme. Les commandes A-I-D apparaissent en premier. Une commande A-I-D validée par Entrée est exécutée, et son résultat s'affiche sous le champ (« Modèle : Opus 5.5 »). | Comportement attendu d'un menu de commandes. Le résultat d'une commande A-I-D n'est pas un message de l'agent : il ne va pas au fil. |

## Points

- **A.1 Contrat et commandes de claude.**
  - `AgentCommand` dans le partagé.
  - `ClaudeDriver.commands()` lu dans `system/init`.
  - `RemoteDriver.commands()` délègue au pilote interne.
  - `commands` exposé dans `options`, en local et sur un serveur, avec les commandes A-I-D en tête.
- **A.2 Commandes de codex.** `skills/list` après la poignée de main. `send` traduit `/skill arguments` en
  entrée `skill`.
- **A.3 `/compact` pour tous.** `compact()` dans le contrat, implémenté par claude et codex, et exposé par la
  route `POST …/compact`.
- **B.1 Menu et commandes A-I-D dans le composer.** Suggestions, complétion, exécution de `/model`,
  `/effort`, `/mode`, `/stop`, `/compact` et `/aide`. Tout le reste est envoyé tel quel.

Tests écrits par un agent Claude (consigne du 2026-11-02), jamais avec le vrai `claude` ni `codex` : les
faux agents `test/fixtures/fake-claude-stream.mjs` et `fake-codex-appserver.mjs` annoncent leurs commandes.

## Journal

- **A.1 (2026-11-02) — contrat et commandes de claude.** `AgentCommand`, `AID_COMMANDS`, `withAidCommands` et
  le champ `commands` d'`options`. `ClaudeDriver.commands()` lit `system/init`, et `RemoteDriver.commands()`
  délègue au pilote interne. Les deux managers ne lisent les commandes que si le pilote n'est pas sorti : un
  agent arrêté, ou dont le pilote est sorti, n'a que celles d'A-I-D.
  - Tests : `test/commandes-slash.test.ts` (unitaires `withAidCommands` et `agentOptions`, daemon local avant et
    après un tour, agent arrêté, pilote sorti), `test/server-discussions.test.ts` (« options (22 A.1) »), et le
    déclencheur `commandes` du faux claude.
  - Mutations vérifiées, chacune casse au moins un test :
    (a) sans le filtre `terminal_slash_commands` ; (b) sans `this.readCommands(o)` ;
    (c) `RemoteDriver.commands()` renvoie `[]` ; (d) `withAidCommands` sans le filtre des noms d'A-I-D ;
    (e) sans `!live.exited` dans `manager.ts` (casse les tests « agent arrêté » et « pilote sorti »).
  - Lignes existantes modifiées : 4, toutes en production. Ce sont la signature et le `return`
    d'`agentOptions`, l'appel dans `pty/manager.ts` et l'appel dans `remote/agents.ts`.
- **A.2 (2026-11-02) — commandes de codex.** `CodexDriver.loadSkills()` part après `loadCatalog()` à la poignée
  de main : `skills/list { cwds: [cwd] }`. Il garde les skills activées, au nom sans espace, avec un `path`, sans
  doublon. La description est `interface.shortDescription`, sinon `shortDescription`, sinon `description`, sinon
  « Skill de codex ». Un échec de la requête est silencieux : seules les commandes d'A-I-D restent.
  `commands()` rend les skills sans leur chemin. Dans `send`, `/<skill connue> arguments` devient l'entrée
  `turn/start` `[{ type: 'skill', name, path }, { type: 'text', text: arguments }, …localImage]`. Le texte est
  omis s'il est vide et porte les chemins des pièces jointes. La file d'attente est respectée ; un `/inconnu`
  part en texte tel quel (D85).
  - Tests : `test/conversation-codex.test.ts` (« skills (A.2) » : liste filtrée, entrée skill avec et sans
    arguments, texte tel quel, pièces jointes, file pendant un tour, `skills/list` en erreur),
    `test/commandes-slash.test.ts` (options et entrée skill d'un codex local, agent arrêté),
    `test/server-discussions.test.ts` (« options (22 A.2) »). Le faux codex répond à `skills/list`, en erreur
    sous `FAKE_CODEX_FAIL_SKILLS_LIST=1`, et renvoie en écho l'`input` d'un `turn/start` qui porte une skill
    ou commence par `/`.
  - Mutations vérifiées, chacune casse au moins un test :
    (a) sans le filtre `enabled !== false` ; (b) sans le dédoublonnage ; (c) `send` sans la branche skill ;
    (d) l'entrée skill sans le texte des arguments ; (e) `loadSkills()` non appelé.
  - Lignes existantes modifiées : aucune.
