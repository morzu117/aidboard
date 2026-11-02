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
- **A.3 `/compact` pour tous.** Le texte `/compact` passe par `send`, comme tout message : claude le reçoit tel
  quel, codex le traduit en `thread/compact/start`. Pas de route dédiée ; un futur pilote fait de même.
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
- **A.3 (2026-11-02) — `/compact` pour tous.** Pas de route ni de `compact()` dans le contrat : `/compact` passe
  par `send`, comme tout message (D81). Claude le reçoit tel quel, sans code nouveau. Dans `CodexDriver.send`, le
  texte exactement `/compact` (aux espaces près), sans pièce jointe, est reconnu avant la branche skill d'A.2 :
  une skill homonyme ne masque pas la commande d'A-I-D. Il part tout de suite si le pilote est prêt, sinon il
  attend dans la file sous une sentinelle (`COMPACTER`) que `startTurn` reconnaît par identité. `startCompaction`
  passe en tour et envoie `thread/compact/start { threadId }`. Un refus finit le tour en erreur avec son message
  et fait avancer la file. `/compact maintenant`, ou `/compact` avec une pièce jointe, part en texte, ou en
  entrée skill si une skill `compact` existe.
  - Sonde manuelle de codex 0.157 : `thread/compact/start` répond `{}`, puis codex émet `turn/started` et
    `turn/completed` (`turn.items` vide, `status: completed`). La fin de la compaction passe donc par le
    `turn/completed` déjà géré.
  - Tests : `test/conversation-codex.test.ts` (« compact (A.3) » : codex prêt, pendant un tour, pièce jointe et
    arguments, refus, skill homonyme), `test/commandes-slash.test.ts` (codex local, et claude qui reçoit
    `/compact` tel quel), `test/server-discussions.test.ts` (« compact (22 A.3) »). Le faux codex répond à
    `thread/compact/start` comme le vrai, en erreur sous `FAKE_CODEX_FAIL_COMPACT=1`. Il ajoute une skill
    `compact` sous `FAKE_CODEX_SKILL_COMPACT=1` et note chaque compaction (`threadId`, arrivée pendant un tour
    long), relue par son tour `compactions`.
  - Mutations vérifiées, chacune casse au moins un test :
    (a) `send` sans la branche `/compact` ; (b) `startTurn` sans le test `input === COMPACTER` ;
    (c) le refus sans `advanceQueue()` ; (d) la branche `/compact` après la branche skill ;
    (e) sans la condition `files.length === 0`.
  - Lignes existantes modifiées : 2, les deux lignes de l'ancien libellé A.3 des points, réécrit (la route est
    abandonnée au profit de `send`).
- **B.1 (2026-11-02) — menu et commandes A-I-D dans le composer.** `web/src/conversation/commandes.ts` porte la
  logique pure : `saisieCommande` (un `/` en tête, pas encore d'espace), `filtrerCommandes` (préfixe, puis
  sous-chaîne, l'ordre reçu gardé), `completer`, `commandeAid`, `reglageDe` et `aide`. `reglageDe` traduit
  `/model`, `/effort` et `/mode` en patch de réglage : id ou libellé, sans tenir compte de la casse ;
  `défaut`/`default` remet la valeur de la CLI ; un choix inconnu est refusé en listant les possibles. L'effort
  est pris dans le modèle courant s'il en a. Le `Composer` n'ouvre le menu que pour un agent qui a des
  réglages (`stream`) : aucun menu pour un agent PTY. Il relit `options` à chaque `/` tapé seul, puisque claude
  n'annonce ses commandes qu'à son premier tour. ↑ et ↓ choisissent, Tab ou Entrée complètent (Entrée envoie
  quand le texte est déjà le nom complet), Échap ferme, un clic complète. Sans commande correspondante, le menu
  dit que le message part tel quel (D85). À l'envoi, sans pièce jointe, les commandes d'A-I-D sauf `/compact`
  sont exécutées sur place et ne partent jamais à l'agent. `/aide` liste ; `/stop` interrompt le tour, ou dit
  « Aucun tour en cours » ; `/model`, `/effort` et `/mode` passent par `PATCH settings`. Leur résultat s'affiche
  sous le champ (`.avis`), l'erreur à la place habituelle. `/compact` et tout autre `/xxx` partent par
  `input` ; après `/compact`, l'avis « Compaction demandée à l'agent ».
  - Tests : `test/web/commandes.test.ts` (unitaires de chaque fonction, catalogue claude et catalogue à la codex
    avec efforts par modèle), `e2e/commandes-slash.spec.ts`. Ce spec lance son propre daemon en `stream`
    (AID_HOME temporaire, port `AID_E2E_PORT + 1` ou `AID_E2E_STREAM_PORT`), devant le faux claude structuré
    de `test/fixtures/bin-stream`, puisque le daemon commun des e2e joue claude en PTY. Il couvre : menu et
    ordre, filtrage, ↓ + Tab, Entrée sur un nom partiel, Échap, clic, `/model` par id, par libellé et
    `défaut`, `/model inconnu`, `/mode`, `/aide`, `/stop` hors tour et pendant un tour long, `/inconnu` et
    `/compact` qui partent à l'agent (et rien d'autre n'y part), puis les commandes de claude après le tour
    `commandes`. Le faux claude n'a pas eu besoin d'être étendu.
  - Mutations vérifiées, chacune casse au moins un test :
    (a) Échap ne ferme pas ; (b) `executer` rend toujours `false` ; (c) `filtrerCommandes` sans le groupe
    sous-chaîne, ou sans l'ordre préfixe d'abord ; (d) `reglageDe` sans la comparaison par libellé ;
    (e) Entrée complète toujours.
  - Lignes existantes modifiées : aucune.
- **B.1 bis (2026-11-02) — `/model` remet l'effort au défaut, comme le chip.** Le daemon local valide les
  réglages fusionnés : `{ model }` seul, vers un modèle qui ne connaît pas l'effort courant, répondait 422
  « effort inconnu ». Le menu du chip envoie déjà `effort: null` dans ce cas. `reglageDe` fait désormais de même :
  si un effort est posé et que le nouveau modèle annonce des efforts qui ne le contiennent pas, le patch est
  `{ model, effort: null }` et l'avis « Modèle : <libellé> (effort : par défaut) ». Seul codex local était touché :
  les modèles de claude partagent leurs efforts, et le daemon distant ne valide que les champs envoyés.
  - Tests : `test/web/commandes.test.ts` (effort inconnu du nouveau modèle, effort connu, modèle sans efforts,
    aucun effort courant), `test/commandes-slash.test.ts` (« settings (B.1 bis) » : sur un codex local, `{ model }`
    seul répond 422, le patch de `reglageDe` est accepté). Sous `FAKE_CODEX_MODELE_MINI=1`, le faux codex annonce
    un second modèle visible, `gpt-mini`, qui ne connaît que `low`.
  - Mutations vérifiées, chacune casse au moins un test :
    (a) sans la condition `!m.efforts.includes(courant.effort)` ; (b) sans le bloc entier.
  - Lignes existantes modifiées : aucune.
