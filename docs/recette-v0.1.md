# Recette de la v0.1 Socle

Grille du plan 05.4. Les cases cochées ont été vérifiées le 2026-10-16 sur macOS (M5, Node 22.23.3) **depuis le tarball
installé dans un dossier vierge**, pas depuis le dépôt. Les cases vides demandent un humain : une vraie session Claude
(quota d'abonnement) et un poste Windows en WSL2.

## Poste : macOS (M5)

- [x] Installation depuis le tarball : `npm i ./aidboard-0.1.0.tgz`, sans erreur (test `test/pack.test.ts`, lancé par `npm run gate:e2e`)
- [x] `aid doctor` : aucun ✗ (node-pty, better-sqlite3, git, bash, claude, codex, codegraph, gh présents)
- [x] `aid` démarre un daemon détaché et affiche `http://127.0.0.1:<port>/?token=…` ; le navigateur s'ouvre (`AID_NO_BROWSER=1` neutralise l'ouverture dans les tests)
- [x] Enregistrer un vrai dépôt (e2e `trois-sujets`)
- [x] Trois sujets, un terminal dans chacun, chacun dans son worktree (e2e `trois-sujets` avec un shell ; **pas** avec `claude`, voir plus bas)
- [x] Fermer l'onglet puis rouvrir : agents vivants, historique intact, sortie produite entre-temps présente (e2e `reconnexion`)
- [x] Nettoyer un sujet avec un fichier modifié : refusé, rien n'est supprimé (e2e `cleanup`, `test/topic-cleanup.test.ts`)
- [x] Nettoyer avec un commit non poussé : confirmation qui répète le nombre exact (`test/topic-cleanup.test.ts`, `test/web/dialogues.test.tsx`)
- [x] Sujet sans index : « index absent : lecture directe » (e2e `repli-index`)
- [x] `GET /api/state` sans cookie : **401**
- [x] `Host` étranger : **421** ; `POST` avec cookie et `Origin: http://evil.com` : **403** ; `POST` avec cookie et sans `Origin` : **403** ; mauvais token : **401**
- [x] Le lien `/?token=…` rend **303** vers `/` avec le cookie `HttpOnly`, `SameSite=Strict`
- [x] Le port n'écoute que sur `127.0.0.1` (`lsof`)
- [x] `~/.aid` en `0700`, `state.db` et `daemon.json` en `0600`
- [x] Le token n'apparaît pas dans `daemon.log`
- [x] `aid stop` refuse (code 2) tant que des agents vivent ; `aid stop --force` arrête tout, aucun processus orphelin (`test/cli.test.ts`)
- [ ] **Une vraie session `claude` dans chacun des trois sujets** : `pwd` dans Claude donne le worktree du sujet
- [ ] `/status` dans Claude : connexion par l'abonnement, pas par une clé API (`ANTHROPIC_API_KEY` est retirée de l'environnement ; vérifié en test avec un shell)
- [ ] Deux vues (poste + onglet étroit) : la taille suit la vue qui a la main, l'autre affiche « fixé par une autre vue »

## Poste : Windows + WSL2

- [ ] `sudo apt install build-essential python3 wslu` puis `npm i -g ./aidboard-0.1.0.tgz` sans erreur (node-pty compile : aucun binaire Linux précompilé)
- [ ] `aid doctor` : aucun ✗
- [ ] `aid` ouvre le navigateur Windows sur `http://127.0.0.1:<port>/…` et la page s'affiche (`wslview`, sinon `cmd.exe /c start`)
- [ ] Enregistrer un dépôt **dans `~/`**, pas sous `/mnt/c` (un dépôt sous `/mnt` doit afficher l'avertissement de lenteur)
- [ ] Trois sujets, une session Claude dans chacun
- [ ] Fermer l'onglet, attendre une minute, `aid open` : les agents tournent, l'historique est intact
- [ ] `aid stop --force` : aucun processus orphelin (`ps`)

## Ce que la recette a révélé (corrigé)

Ces défauts n'existaient que dans le build ou dans un vrai navigateur ; les tests unitaires, qui tournent sur les sources,
ne les voyaient pas.

| Défaut | Effet | Garde-fou ajouté |
| --- | --- | --- |
| `@xterm/headless` est du CommonJS | le daemon construit ne démarrait pas (`import` nommé impossible sous Node) | `aid` en sous-processus dans `test/cli.test.ts` |
| Les chunks du bundle n'ont pas de profondeur fixe | `aid` relançait un script inexistant ; `readVersion` cherchait `package.json` au mauvais endroit | `test/smoke.test.ts`, `test/pack.test.ts` |
| `defaultWebRoot` remontait au `web/` source | page blanche : le daemon servait `web/index.html` au lieu de `dist/web` | `webRootFrom` testé, e2e |
| Aucun moyen d'ajouter un second workspace | impossible d'enregistrer un deuxième dépôt dans l'interface | « Ajouter un workspace… », e2e |
| Le dialogue de sujet préselectionnait le premier workspace | le sujet atterrissait dans le mauvais dépôt | préselection du dernier ajouté, test |
| Le token d'ouverture finissait dans `daemon.log` | secret dans un fichier de journal | `redactToken`, test |

## Points ouverts pour la suite

- `aid doctor` signale `~/.aid en 755` sur un dossier créé à la main avant le premier lancement ; le daemon le repasse en `0700` au démarrage.
- La CSP autorise `style-src 'unsafe-inline'` : xterm pose des attributs `style`. À resserrer si xterm le permet.
- Le premier lancement de `claude` ou de `codex` dans un worktree neuf affiche son dialogue de confiance : normal, A-I-D n'y touche pas.
