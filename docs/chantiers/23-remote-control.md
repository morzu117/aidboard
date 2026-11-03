# Chantier 23 — Remote-control depuis le composer

Branche `feat/remote-control`, base `main` (`2404c4d`, PR #107 mergée).

## Pourquoi

L'opérateur veut, à côté du choix du modèle, un bouton qui active le remote-control de l'agent : reprendre la
conversation depuis claude.ai/code ou l'application mobile, sans quitter A-I-D.

Constat du 2026-11-03, sondes manuelles dans un dossier jetable :
- claude 2.1.308 en `stream-json` accepte le `control_request` `{ subtype: 'remote_control', enabled, name? }`.
  L'activation répond `{ session_url, connect_url, environment_id, bridge_epoch, bridge_session_id }`, puis
  l'événement `system/bridge_state` passe de `ready` à `connected`. La désactivation répond `success`. Rien à
  relancer : c'est le process vivant qui s'ouvre ou se ferme ;
- codex 0.157 a les requêtes `remoteControl/enable`, `remoteControl/disable` et `remoteControl/status/read`, ainsi
  qu'un appairage par code (`remoteControl/pairing/start`). Elles sont réservées à l'API expérimentale
  (`initialize` avec `capabilities.experimentalApi`). `remoteControl/status/read` répond `disabled` sans rien
  ouvrir.

## Décisions

| N° | Décision | Pourquoi |
|---|---|---|
| D87 | Contrat des pilotes : `remoteControl(enabled, name)` et `remoteControlState()`. Un pilote qui ne les a pas est `unsupported`, et le bouton n'apparaît pas. | Le même bouton pour tous les agents, comme les commandes `/` (D80) : un nouveau pilote n'a qu'à implémenter les deux méthodes. |
| D88 | Pour claude : le `control_request` `remote_control`, nommé d'après le sujet ou la discussion. L'état suit `bridge_state` : `connected` connecté, `failed` en erreur, tout autre état « connexion… ». | C'est ce que claude offre en `stream-json`, sans relance. |
| D89 | Le remote-control n'est pas persisté : il vit avec le process. Une mise en veille, une relance ou un redémarrage du daemon le coupent, et le bouton le montre. | Ouvrir la conversation à un autre appareil reste un choix explicite, à refaire à chaque fois. |
| D90 | Routes `GET` et `POST …/remote-control` (`{ enabled }`), en local et sur un serveur. Activer réveille un agent en veille. | Mêmes conventions que `options` et `settings`. |
| D91 | Le bouton est un chip à droite du modèle : « Remote » éteint, « Remote · connexion… », « Remote · connecté » avec le lien vers la session, ou l'erreur. L'état est relu à l'ouverture et toutes les 3 s tant qu'il est en connexion. | Pas de nouvel événement dans le fil : un état, pas un message. |

## Points

- **A.1 Contrat, claude, routes.** `RemoteControlState` dans le partagé, le contrat, `ClaudeDriver`, la
  délégation de `RemoteDriver`, les deux managers et leurs routes.
- **A.2 Codex.** Après claude, décision de l'opérateur du 2026-11-03 : le contrat est le même, codex l'implémentera (API expérimentale, appairage par code).
- **B.1 Bouton.** Le chip dans `ComposerReglages`.

Tests écrits par un agent Claude, jamais avec le vrai `claude` ni `codex` : le faux claude répond au
`remote_control` et émet `bridge_state`.

## Journal

- **A.1 (2026-11-03) — contrat, claude, routes.** `RemoteControlState` et `REMOTE_CONTROL` dans le partagé ;
  `remoteControl(enabled, name)` et `remoteControlState()` au contrat. `ClaudeDriver.remoteControl` écrit le
  `control_request` `remote_control` et attend la `control_response` de même `request_id`, 30 s au plus. Une
  réponse en succès donne l'url (`session_url`) et « connexion », ou « connecté » si `bridge_state connected` est
  déjà arrivé ; une désactivation donne `off`. Un refus rejette, et met l'état en erreur s'il s'agissait d'une
  activation. `system/bridge_state` : `connected` connecté, `failed` en erreur (son `detail`), tout autre état en
  connexion ; ignoré une fois éteint. À la sortie du process, les attentes sont rejetées puis l'état remis à
  `off`. `RemoteDriver` délègue au pilote interne (`unsupported` sans lui). Les deux managers :
  - codex `unsupported` en lecture et 409 en écriture ;
  - un agent en veille est `off` ; le désactiver ne le réveille pas, l'activer le relance ;
  - la session est nommée `A-I-D · <titre du sujet>` ou `A-I-D · <nom de la discussion>` ;
  - une erreur du pilote donne 502.

  Routes `GET` et `POST /api/agents/:id/remote-control` et `/api/server-agents/:id/remote-control`, corps
  `{ enabled: boolean }` sans autre champ.
  - Bug trouvé en écrivant les tests, corrigé : `handleExit` remettait l'état à `off` avant de rejeter les
    attentes, et le rejet d'une activation en cours le repassait en erreur. Masqué par les managers, qui lisent
    `exited` d'abord, mais le pilote mentait.
  - Tests : `test/conversation-claude.test.ts` (« remote-control » : activation, nom envoyé, désactivation puis
    `bridge_state` ignoré, refus, désactivation refusée, délai de 30 s sous fake timers, `failed` avec et sans
    detail, sortie pendant une demande et une fois connecté, `control_response` inattendues),
    `test/remote-control.test.ts` (daemon local : `off` avant tout, url puis connecté, titre du sujet, codex
    vivant et en veille, veille sans relance pour désactiver, relance pour activer, refus en 502, corps invalides,
    404, token de run 403), `test/server-discussions.test.ts` (« remote-control (23 A.1) »). Le faux claude répond
    au `remote_control` comme claude 2.1.308 (`ready` avant la réponse, `connected` après, url
    `https://claude.ai/code/session_fake<n>`), avec `FAKE_CLAUDE_RC_REFUSE`, `FAKE_CLAUDE_RC_SILENT` et
    `FAKE_CLAUDE_RC_FAIL`, et les tours `remote-control`, `bridge_state <état>` et `control_response inconnue`.
  - Mutations vérifiées, chacune casse au moins un test :
    (a) `readBridgeState` sans le garde `off` ; (b) `handleExit` sans la remise à `off` ;
    (c) `remoteControl` sans lire `session_url` ; (d) `setRemoteControl` qui réveille aussi pour désactiver ;
    (e) sans le 409 codex, en local (casse le test du codex en veille ; vivant, le second garde répond 409) et
    sur le serveur ; (f) `RemoteDriver.remoteControlState` toujours `unsupported` ; (g) la remise à `off` avant
    le rejet des attentes.
  - Réserves : `{ enabled: 1 }` est accepté comme `true`, par la coercition d'Ajv commune à toutes les routes
    (gardée, comme pour les autres routes). La réactivation d'un agent déjà connecté n'est pas couverte : le bouton ne
    la propose pas, et le comportement du vrai claude n'a pas été observé.
  - Lignes existantes modifiées : 1, le commentaire « control_response entrant… : ignorés » de `claude.ts`,
    devenu faux. La puce A.2 du plan est réécrite (le fichier du chantier est nouveau dans ce commit).
- **B.1 (2026-11-03) — chip « Remote ».** Dans `ComposerReglages`, à droite du chip modèle, pour un pilote dont
  `REMOTE_CONTROL` est vrai (claude) : l'état est lu au montage par la route de l'agent (`useAgentRoutes`, donc
  locale ou distante), relu à chaque ouverture du menu et toutes les 3 s tant qu'il est `connecting`. Le chip est
  absent si l'état est `unsupported` ou si la lecture échoue. Libellés « Remote », « Remote · connexion… »,
  « Remote · connecté », « Remote · erreur » (attribut `data-etat`). Le menu, même mécanique que mode et modèle
  (clic dehors et Échap ferment), dit l'état, donne « Ouvrir la session » (nouvel onglet) en connexion ou connecté
  avec une url, et un bouton « Activer » / « Désactiver » / « Réessayer » désactivé pendant le `POST` ; un `POST`
  refusé passe par l'erreur du composer et relit l'état.
  - Tests : `test/web/conversation.test.tsx` (« chip Remote » : absent pour codex sans lecture, absent si
    `unsupported` ou si le `GET` échoue, libellé par état, Activer → `{ enabled: true }` puis lien, bouton
    désactivé pendant la requête, Échap, Désactiver → `{ enabled: false }`, erreur sans lien même avec une url,
    Réessayer, `POST` refusé → alerte et relecture, relecture toutes les 3 s en connexion arrêtée une fois connecté
    sous fake timers), `test/web/discussion.test.tsx` (agent distant : lecture et bascule par
    `/api/server-agents`), `e2e/remote-control.spec.ts` (deux daemons `stream` dédiés devant le faux claude :
    Activer → « Remote · connecté » et lien `session_fake<n>`, Désactiver → « Remote » ; le second porte
    `FAKE_CLAUDE_RC_REFUSE` : refus affiché, « Remote · erreur », « Réessayer »).
  - Mutations vérifiées, chacune casse au moins un test : (a) chip lu et affiché aussi pour codex ; (b) pas de
    relecture en connexion ; (c) bascule qui envoie toujours `enabled: true` ; (d) lien affiché hors connexion ;
    (e) erreur de `POST` avalée sans `onErreur`.
  - Réserves : un `connected` qui retombe (`failed` côté claude) n'est vu qu'à la prochaine ouverture du menu ou au
    prochain montage, la relecture ne tournant qu'en connexion. Une relecture en vol peut, en théorie, revenir
    après la réponse d'un `POST` et afficher l'état d'avant jusqu'à la lecture suivante. Le composant ne remet pas
    l'état à zéro si `agentId` change sans remontage : sans effet aujourd'hui, `Conversation` étant remontée par
    `key={agent.id}` dans Sujet et Discussion.
  - Lignes existantes modifiées : 2, le type `Menu` de `ComposerReglages.tsx` (ajout de `'remote'`) et la
    réserve du Journal A.1, qui attribuait à tort la coercition d'Ajv à une décision de l'opérateur.
