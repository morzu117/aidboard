# Chantier 21 — Agents installés par mise trouvés sur le serveur

Branche `feat/agents-shims-mise`, base `main` (`a92420a`, chantiers 20 et layoutGraph mergés).

## Pourquoi

Constat sur le VPS le 2026-11-01, en lecture seule et avec le go de l'opérateur :
- `claude` est installé par mise ; son shim se trouve dans `~/.local/share/mise/shims/claude` ;
- `mise activate` est à la ligne 117 du `~/.bashrc`, donc après le garde de Debian qui arrête la lecture
  pour un shell non interactif ;
- A-I-D lance chaque commande en `bash -lc`, un shell de connexion non interactif ; il ne trouve donc
  que `tmux` et `mise`, et le test de connexion ne détecte pas `claude`.

La première réponse était d'ajouter les shims au `~/.profile` du VPS. L'opérateur a préféré qu'A-I-D
contourne le piège lui-même, sans rien modifier sur le serveur, avec un test du labo à l'appui.

## Décisions

| N° | Décision | Pourquoi |
|---|---|---|
| DS1 | `remoteCommand` préfixe chaque commande distante de `PATH="$PATH:<shims de mise>"`. Le dossier suit `MISE_DATA_DIR`, puis `XDG_DATA_HOME/mise`, puis `~/.local/share/mise`. | Point unique : test de connexion, git, fichiers, dépôt et démarrage du relais. Le relais enregistre l'environnement du shell de connexion (`export -p`) avant tmux : l'agent hérite du même PATH. |
| DS2 | Les shims sont ajoutés **en fin** de PATH. | Un outil déjà trouvé par le profil, par exemple un `claude` natif dans `~/.local/bin`, garde la priorité. Le préfixe n'agit que sur ce qui était introuvable. |
| DS3 | Le préfixe est ajouté sans condition, même si le dossier n'existe pas. | Un dossier absent dans le PATH n'a aucun effet ; un test `[ -d ]` ajouterait du script pour rien. |
| DS4 | Seul mise est couvert, pas asdf ni nvm. | C'est le cas constaté. asdf a le même mécanisme de shims et pourra s'ajouter de la même façon si un serveur en a besoin ; nvm n'a pas de shims. |

## Point

- **A.1 Les shims de mise en fin de PATH.** `PATH_SHIMS` dans `src/daemon/remote/transport.ts`.
  - Test local (`test/remote-transport.test.ts`) : le vrai `sh -lc` trouve un outil placé seulement
    dans les shims, suit `XDG_DATA_HOME` et `MISE_DATA_DIR`, et laisse la priorité au PATH du profil.
  - Test du labo (`test/labo/mise.labo.ts`) : le piège du VPS est rejoué, avec `claude` présent
    seulement dans les shims et activé seulement en interactif. Le test de connexion détecte
    `claude · codex`, puis une discussion claude répond, lancée dans tmux.

## Journal

- **A.1** — Mutations vérifiées :
  - avec les shims en tête de PATH, le test de priorité casse ;
  - sans préfixe, le test local casse, et le labo ne détecte que `codex`, exactement le symptôme du VPS.

  Lignes existantes modifiées, toutes déclarées : `remoteCommand`, l'import `node:fs` et six attentes de
  `test/remote-transport.test.ts`, qui figent la commande distante exacte et portent maintenant
  `${PATH_SHIMS}`.
