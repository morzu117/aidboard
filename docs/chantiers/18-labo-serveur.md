# Chantier 18 — Labo serveur : un vrai sshd, un vrai tmux, en conteneur local

Branche `feat/labo-serveur`, base `main` (`6227f10`, chantier 17 mergé). Accord opérateur du
2026-10-31 : ajouter une commande npm et, une fois le labo stable, une étape de CI.

## Pourquoi

Les tests du chantier 17 tournent contre un faux ssh, un faux tmux et de faux agents (D79). Ils
ont laissé passer une différence réelle : sous le dash d'Ubuntu 22.04, le faux tmux ne tuait
pas la bonne commande, et seule la CI l'a vu (PR #84). La vérification sur le VPS de
l'opérateur, elle, est manuelle, ponctuelle, et demande son accord à chaque fois.

Le labo rejoue les parcours du chantier 17 contre un **vrai** serveur : un conteneur Linux
local, lancé par le test, avec un vrai `sshd`, un vrai `tmux` et plusieurs shells de
connexion. Seuls les agents restent faux : ni `claude` ni `codex` dans un test automatique.

## Décisions

| N° | Décision | Pourquoi |
|---|---|---|
| DL1 | Image construite localement depuis `test/labo/Dockerfile` (`node:22-bookworm-slim` + `openssh-server`, `tmux`, `zsh`, `git`, `procps`). Rien n'est poussé vers un registre. Seuls la construction de l'image (image de base, `apt`) et rien d'autre touchent au réseau. | Node est nécessaire côté serveur pour les faux agents (`.mjs`). |
| DL2 | Le vrai `ssh` du poste, appelé par un enveloppeur qui impose `-F <config du labo>` : clé ed25519 générée pour le run dans un dossier temporaire, `IdentitiesOnly yes`, `IdentityAgent none`, `known_hosts` temporaire. | Jamais le `~/.ssh` de l'opérateur, ni son agent ssh, ni son `known_hosts`. |
| DL3 | Le conteneur n'écoute que sur `127.0.0.1`, port éphémère. Il porte le label `aid-labo` ; le nettoyage ne supprime que les conteneurs qu'il a lancés. | Aucun service exposé ; aucun conteneur de l'opérateur touché. |
| DL4 | Fichiers copiés dans le conteneur par `docker cp`, jamais montés. | Colima ne partage que `$HOME` ; les dossiers temporaires de macOS n'y sont pas. |
| DL5 | Sur le serveur, `claude` et `codex` sont des enveloppeurs vers les faux agents (`test/fixtures/fake-claude-stream.mjs`, `fake-codex-appserver.mjs`). | La détection des agents du test de connexion et les binaires par défaut sont ceux d'un vrai serveur. |
| DL6 | Commande séparée `npm run gate:labo` (vitest, `vitest.labo.config.ts`, fichiers `test/labo/*.labo.ts`). Hors de `npm run gate` : Docker n'est pas requis pour le gate. Docker absent ou arrêté : **échec explicite**, jamais un saut silencieux. | Le gate reste lançable partout ; le labo ne ment pas sur ce qu'il a vérifié. |
| DL7 | Comptes du serveur : `aid` (bash), `aidzsh` (zsh), `aiddash` (dash). | Les trois shells de connexion POSIX qu'un VPS peut avoir. `fish` reste non supporté (chantier 17). |

## Points

Un point = un commit. Après chaque point : `npm run gate` en entier et `npm run gate:labo`.

- **L.1 Le labo et la connexion** — image, harnais (`test/labo/labo.ts` : construire, démarrer,
  attendre `sshd`, enveloppeur ssh, exécuter dans le conteneur, arrêter), script npm, config
  vitest. Scénario : le test de connexion complet du daemon réussit pour chacun des trois
  comptes (étapes `command`, `shell`, `workdir`, `agents`, `session`), agents détectés
  `claude · codex`.
- **L.2 Le relais contre le vrai tmux** — dépôt, start, attach, alive, stop ; session tuée
  (`tmux kill-session`) puis serveur tmux tué (redémarrage) : `perdu`, sortie restante rendue.
- **L.3 Discussions de bout en bout** — claude et codex : message, tour fini, redémarrage du
  daemon et rattachement, coupure réseau (sessions `sshd` tuées, agent intact dans tmux) puis
  reprise sans perte ni doublon, suppression qui arrête l'agent sur le serveur, refus D.2 quand
  `sshd` ne répond plus.
- **L.4 Confirmations** — commande destructive soumise par le faux agent : carte, refus,
  « Toujours autoriser dans ce dossier ».
- **L.5 Panneau Fichiers et Git** — dépôt Git réel dans le conteneur : liste, lecture, secrets
  masqués, statut, journal, branches.
- **L.6 CI** — un job `labo` (Ubuntu, Docker du runner) qui lance `npm run gate:labo`, une fois
  L.1–L.5 stables en local.

## Journal

- **L.1 Le labo et la connexion** : image `node:22-bookworm-slim` (532 Mo, construite une fois par
  `globalSetup`, étiquetée par l'empreinte du Dockerfile), harnais `test/labo/labo.ts`, script
  `npm run gate:labo`. Le test de connexion du daemon passe contre le vrai sshd pour bash, zsh,
  dash, et pour zsh avec `shell: bash` (la commande traverse deux shells). Mutation vérifiée : un
  home attendu faux fait échouer les quatre cas (les home viennent bien du conteneur). Rien ne
  reste après le run (conteneur supprimé, dossier temporaire effacé).
