# Chantier 20 — Secrets masqués dans le texte libre des serveurs distants

Branche `feat/secrets-texte-libre`, base `main` (`b509857`, chantier 19 mergé).

## Pourquoi

Décision de l'opérateur du 2026-10-31, après la review complète du chantier 17 (journal du 17,
« Décisions opérateur », point 1) : le texte libre d'un serveur distant est masqué par un
**détecteur de contenu côté daemon** (clés privées, `user:mdp@`, préfixes de jetons connus). Cela
couvre le fil de l'agent, la commande d'une carte, les règles et la sortie du test de connexion.

Aujourd'hui, seuls les **fichiers** sont masqués, par leur nom (D78, F.1 bis). En revanche, un jeton
qu'un agent affiche, ou qu'une commande porte, arrive en clair :
- dans `server_agent_messages` (SQLite) ;
- dans la carte de confirmation ;
- dans `server_rules` quand l'opérateur clique « Toujours autoriser » ;
- dans la sortie brute du test de connexion.

Le cas de `server_rules` contredit D76 : aucun secret en base.

## Décisions

| N° | Décision | Pourquoi |
|---|---|---|
| DM1 | Un détecteur unique, `src/daemon/secrets.ts` : `maskSecrets(text)` et `MASK`. Il reconnaît trois familles. **Clés privées** : bloc `-----BEGIN … PRIVATE KEY-----` jusqu'à son `END`, ou jusqu'à la fin du texte s'il est coupé. **Identifiants d'URL** : `schéma://…@` devient `schéma://[secret masqué]@`. **Jetons à préfixe connu** : GitHub, GitLab, Slack, AWS (`AKIA`/`ASIA`), OpenAI, Anthropic, Stripe, Google (`AIza`), npm, Hugging Face, JWT. Le préfixe reste visible (`ghp_[secret masqué]`), le reste disparaît. | La décision de l'opérateur fixe les trois familles. Le préfixe dit de quoi il s'agit sans rien livrer. Une longueur minimale par préfixe évite les faux positifs (`sk-` dans un mot ordinaire). |
| DM2 | Masquage **à l'entrée**, irréversible, avant l'écriture en base et avant l'envoi au navigateur. L'original ne reste que sur le serveur, dans la sortie du relais. | D76 : A-I-D ne garde aucun secret. Le révéler avec le mot de passe d'`aid-relay` (journal du 17, D78) se fera depuis le serveur, sans copie dans A-I-D. |
| DM3 | Une commande qui portait un secret n'offre que **Autoriser** et **Refuser**, jamais « Toujours autoriser ». Aucune règle ne s'y applique. | Une règle est la commande exacte (`rulePattern`) : l'écrire, c'est stocker le secret. Une fois masquée, deux commandes à secrets différents ne doivent pas partager une règle. |
| DM4 | Les messages de l'opérateur partent **en clair à l'agent**, mais sont **masqués au fil**. | L'agent a besoin de ce que l'opérateur lui donne ; A-I-D n'a pas à le garder. |
| DM5 | Le test de connexion masque sa sortie brute et le détail de ses étapes. Les traces du daemon (`trace`, chantier 19) passent par le même détecteur. | Mêmes fuites, mêmes règles. |
| DM6 | Données existantes : au démarrage, une passe unique masque les `payload` de `server_agent_messages` et supprime les `server_rules` dont le motif porte un secret. Elle est marquée faite par une migration SQL (table `maintenance`). | Sans elle, l'historique déjà écrit reste en clair. Une règle à secret ne pourra plus jamais s'appliquer (DM3) : la garder, c'est garder le secret. |
| DM7 | **Hors périmètre** : les agents **locaux** (fil et journaux PTY), les mots de passe en argument (`mysql -pX`, `sshpass -p`), les en-têtes `Authorization` génériques et les `CLE=valeur`. | La décision de l'opérateur vise le texte libre des serveurs et ces trois familles. Les cas génériques donnent beaucoup de faux positifs : ils sont listés comme candidats, à trancher. |

## Points

Un point = un commit. Après chaque point : `npm run gate` en entier et une vérification par mutation.
Le labo est lancé à la fin (aucun script distant n'est modifié).

- **M.1 Le détecteur.** `src/daemon/secrets.ts`. Tests sur un corpus : chaque famille, un bloc de clé coupé, une URL avec `@` dans le mot de passe, un masquage idempotent. Faux positifs exclus : `task-list`, `sk-` court, `AKIA` trop court, une URL sans identifiants, `user@host` sans schéma.
- **M.2 Le fil des agents distants.** Chaque `ConversationEvent` est masqué en entier (textes, entrée d'outil en profondeur, sortie, demandes, raisons) avant `record` et `notify`, y compris les messages de l'opérateur (DM4). Tests par le daemon : un faux claude répète un jeton, le fil, la base et le socket ne le portent pas ; l'agent l'a bien reçu en clair.
- **M.3 Cartes et règles.** DM3 : options sans `always`, aucune règle appliquée ni écrite, la carte montre la commande masquée. Tests : commande destructive avec jeton ; règle existante identique au caractère près ; « Toujours » refusé en 422.
- **M.4 Test de connexion et traces.** DM5. Tests : un profil de connexion qui affiche un jeton ; une erreur tracée qui porte une clé.
- **M.5 Données existantes.** DM6. Tests : une base peuplée avant la migration (messages et règle à secret), puis un démarrage : masquée et règle retirée, les autres intactes ; un second démarrage ne refait rien.

## Journal
- **M.1 Le détecteur** : `src/daemon/secrets.ts` (`maskSecrets`, `hasSecret`, `maskDeep`, `MASK`). Rien n'est encore branché.
  - Un identifiant d'URL n'est masqué que s'il porte un `:` ou fait au moins 20 caractères. `ssh://git@…` reste lisible.
  - Une clé privée devient `clé privée [secret masqué]`. Le remplacement ne reprend pas l'en-tête `BEGIN`, sinon un second passage avalerait la suite du texte.
  - `pk_live_` (clé Stripe publique) n'est pas masqué.
  - Tests : 5 (corpus par famille, faux positifs, idempotence, `maskDeep`).
  - Cinq mutations vérifiées : clé coupée, `AKIA` retiré, tout identifiant d'URL masqué, longueurs minimales retirées, en-têtes de clé retirés.
  - Aucune ligne existante modifiée.
  - Gate vert : 1274.
  - codegraph indisponible (`statInode`) : lecture directe des fichiers.
- **M.2 Le fil des agents distants** : chaque événement est masqué en entier (`maskDeep`) à la sortie du pilote,
  avant `onEvent`. La demande en cours (`pending`) que rend la vue de l'agent est donc masquée elle aussi.
  - `record` remasque ce qu'il écrit : couvre le message de l'opérateur, parti en clair à l'agent (DM4).
    Le masquage est idempotent.
  - Test : un jeton tapé par l'opérateur, répété par le faux claude, puis porté par une commande en carte.
    - Masqué au fil, en base, dans la vue de l'agent et sur `/ws/server-agent`.
    - La sortie du relais, sur le serveur, porte le jeton en clair : l'agent l'a bien reçu.
  - Deux mutations vérifiées : sans masque à l'entrée, sans masque au fil.
  - Aucune ligne existante modifiée.
  - Gate vert : 1275.
- **M.3 Cartes et règles** : dans `screen`, une commande masquée (elle porte `MASK`) est présentée avec
  **Autoriser** et **Refuser** seulement, avant toute recherche de règle.
  - « Toujours » n'étant plus une option de la demande, `answer` le refuse en 422 sans code nouveau.
  - La carte de l'interface affiche les options que rend le daemon : rien à changer côté web.
  - Test :
    - `sudo git push https://deploy:motdepasse@…` : carte masquée à deux boutons, « Toujours » en 422 ;
    - une règle identique au caractère près à la commande masquée ne s'applique pas ;
    - aucune règle écrite, le mot de passe absent des règles ;
    - une commande sans secret garde ses trois boutons.
  - Mutations vérifiées : bloc DM3 retiré, mauvaise option retirée.
  - Aucune ligne existante modifiée.
  - Gate vert : 1276.
- **M.4 Test de connexion et traces** : `ServerConnections` masque
  - chaque morceau de la sortie brute avant de l'ajouter : un morceau est la sortie entière d'une commande, donc
    un secret n'y est jamais coupé en deux, et le plafond de 64 Kio ne coupe que du texte déjà masqué ;
  - le détail de chaque étape ;
  - l'erreur du test, aux deux endroits où elle est écrite ;
  - la cause de tout état publié : elle vient aussi des pings, tirée du stderr de ssh.

  `trace` passe ce que `stripUserinfo` rend par `maskSecrets`.
  - Tests :
    - un `.bash_profile` qui affiche un jeton et une clé sur stderr, un `workdir` qui porte un jeton : masqués
      dans la sortie brute, l'erreur, la publication et `GET …/test` ;
    - une commande locale introuvable dont le nom porte un jeton : étape, erreur et état masqués ;
    - un refus de ssh qui cite une cible à jeton : cause de l'état masquée ;
    - une erreur tracée qui porte une clé AWS.
  - Cinq mutations vérifiées : sortie brute, détail d'étape, erreur du test, cause d'état, trace.
    - La cause d'état a d'abord survécu : elle passait déjà par l'erreur du test, masquée. D'où le test du ping.
  - Lignes existantes modifiées :
    - le `const why` de `trace` ;
    - l'import de `secrets.js` dans `agents.ts`, celui de M.2, qui gagne `maskSecrets`.
  - Gate vert : 1280.
