# Chantier 59 : installer et mettre à jour A-I-D proprement

| Champ | Valeur |
|---|---|
| État | **Révision 0, 18 novembre 2026.** Julien veut, avant de tester la v0.9.0, un guide d'installation propre pour macOS, Windows et Linux, qui couvre l'installation et la mise à jour. |
| Emplacement final | `docs/chantiers/59-installation.md` sur `main` |
| Base | `main` à e2213d0 (v0.9.0). |
| Organisation | La cell de gestion écrit le guide à partir des faits relevés dans le code. Codex fait le correctif 59.1. La cell de gestion relit, lance le gate et ouvre la PR. |
| Validation | Aucun secret, aucun mesh. Merge : CI verte, puis oui de Julien. |

## 1. Le constat

- Le README mêle l'installation et le développement. Ses prérequis (Node, compilation) ne concernent pas l'utilisateur de l'app, puisque AID Server embarque Node.
- Rien ne décrit la désinstallation, ni le fait que l'app et le serveur se mettent à jour séparément.
- Sous Linux, l'app lance AID Server par `/bin/zsh -i -l -c`, codé en dur. Sur une Debian ou une Ubuntu de base, sans zsh, l'app ne peut ni installer ni lancer le serveur.

## 2. Décisions

### D352. Un seul guide pour l'utilisateur, `docs/INSTALLATION.md`

Il couvre, par système, les fichiers à prendre, les prérequis, l'installation, le premier lancement, la mise à jour, le retour arrière, la vérification et la désinstallation. Le README y renvoie. Chaque fait vient du code : release.yml, daemon_bridge.rs, diagnostic_wsl.rs, install-server.sh, server.ts, doctor.ts, Accueil.tsx et updateWatcher.ts.

### D353. Sous Linux, le shell de lancement est celui de l'utilisateur, bash ou zsh

`choisir_shell` garde zsh sur macOS. Sous Linux, il prend `$SHELL` s'il est absolu, existe et s'appelle bash ou zsh, puis `/bin/bash`, puis `/bin/zsh`. Sans aucun des deux, l'app affiche « Ni bash ni zsh trouvé : installe bash, puis relance AID. » Les options `-i -l -c` restent. Windows et WSL ne changent pas.

## 3. Points

### 59.1 Le shell de lancement sous Linux

`app/src-tauri/src/daemon_bridge.rs` : `choisir_shell`, `login_shell` qui rend un `Result`, et six tests Rust (macOS, `$SHELL` zsh, fish ignoré, repli zsh, aucun shell, chemin relatif refusé). La CI `app` les lance sur Ubuntu et sur Windows.

### 59.2 Le guide

`docs/INSTALLATION.md`, le renvoi depuis le README, et la ligne du chantier dans `docs/chantiers/README.md`.
