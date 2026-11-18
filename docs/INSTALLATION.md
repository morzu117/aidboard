# Installer et mettre à jour A-I-D

A-I-D se compose de deux éléments, publiés ensemble à chaque version sur la
[page des releases](https://github.com/morzu117/aidboard/releases/latest) :

- **AID Board**, l'app de bureau : c'est elle qu'on installe.
- **AID Server**, le daemon qui fait tourner les agents. L'app l'installe et le lance toute seule au premier
  lancement. Node est embarqué : il n'y a rien à compiler.

Aucune étape ne demande Node, Rust ou un compilateur. Pour développer A-I-D lui-même, voir le README.

## Ce qu'il faut avant

| Système                            | Fichier à prendre                                         | À installer avant                                              |
| ---------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| macOS Apple Silicon (M1 et suivants) | `AID_<version>_aarch64.dmg`                             | git (`xcode-select --install`)                                 |
| macOS Intel                        | `AID_<version>_x64.dmg`                                   | git (`xcode-select --install`)                                 |
| Windows 10 ou 11, x64              | `AID_<version>_x64_en-US.msi`                             | WSL2 et une distribution Linux (voir plus bas)                 |
| Linux x64, Debian ou Ubuntu        | `AID_<version>_amd64.deb`                                 | `curl`, `git`, `bash` (déjà présents sur la plupart des postes) |
| Linux x64, autre distribution      | `AID_<version>_amd64.AppImage`                            | `curl`, `git`, `bash`, et `libfuse2` pour lancer l'AppImage    |
| Linux arm64, ou serveur sans écran | AID Server seul (voir « Serveur seul »)                   | `curl`, `git`                                                  |

Facultatif, sur la machine où tournent les agents (dans WSL sous Windows) : `claude` et `codex` (les agents),
`gh` (les PR de la vue Livraison), `codegraph` (l'index structurel), `swarph` et Tailscale (le mesh).
`aid doctor` dit ce qui manque.

## macOS

**Installer**

1. Télécharge le `.dmg` qui correspond à ton Mac (menu Pomme → À propos de ce Mac : « Puce Apple » = `aarch64`,
   « Processeur Intel » = `x64`).
2. Ouvre le `.dmg` et glisse **AID** dans Applications.
3. Premier lancement : l'app n'est pas encore signée par Apple, donc Gatekeeper refuse le double-clic.
   - Clic droit sur AID dans Applications, puis **Ouvrir**, puis **Ouvrir** dans la boîte.
   - Sur macOS 15 et suivants, si la boîte ne propose pas Ouvrir : Réglages Système → Confidentialité et
     sécurité, tout en bas, **Ouvrir quand même**.
4. L'app affiche « Installation d'AID Server », puis « Démarrage », puis le board. Ces étapes ne se font qu'une
   fois.

**Désinstaller** : glisse AID d'Applications à la corbeille, puis supprime les données (voir « Désinstaller »).

## Windows

L'app est native Windows, mais AID Server et les agents tournent dans WSL2, sous Linux.

**Préparer WSL2 (une seule fois)**

1. Dans un terminal administrateur : `wsl --install -d Ubuntu`, puis redémarre Windows.
2. Ouvre Ubuntu depuis le menu Démarrer et crée ton utilisateur Linux (pas root).
3. Dans Ubuntu : `sudo apt update && sudo apt install -y curl git wslu`.
4. Si tu as plusieurs distributions : `wsl --set-default Ubuntu`. AID utilise la distribution par défaut et
   son utilisateur par défaut.
5. Installe les agents (`claude`, `codex`) **dans Ubuntu**, pas sous Windows. Garde tes dépôts sous `~/…`
   dans Linux, pas sous `/mnt/c`.

**Installer**

1. Télécharge le `.msi` et ouvre-le.
2. L'installeur n'est pas signé : SmartScreen affiche « Windows a protégé votre ordinateur ». Clique
   **Informations complémentaires**, puis **Exécuter quand même**, puis suis l'assistant.
3. Lance AID depuis le menu Démarrer. L'app vérifie WSL, installe AID Server dans Ubuntu, le lance, puis
   affiche le board.

Si WSL manque ou est en version 1, l'app le dit et donne la commande à lancer.

**Désinstaller** : Paramètres → Applications → AID → Désinstaller. Les données sont dans Ubuntu (voir
« Désinstaller »).

## Linux

**Installer, Debian ou Ubuntu**

```bash
sudo apt install ./AID_<version>_amd64.deb
```

apt installe aussi ses deux dépendances (`libwebkit2gtk-4.1-0`, `libgtk-3-0`). Lance **AID** depuis le menu
des applications.

**Installer, autre distribution**

```bash
chmod +x AID_<version>_amd64.AppImage
./AID_<version>_amd64.AppImage
```

**Le shell.** L'app lance AID Server dans ton shell de connexion, pour retrouver le PATH de tes agents. À partir
de la v0.9.1, elle prend bash ou zsh. En v0.9.0, elle exige zsh : `sudo apt install zsh` avant le premier
lancement.

**Désinstaller** : `sudo apt remove aid` (ou supprime le fichier `.AppImage`), puis les données.

## Serveur seul

Pour une machine sans écran (un serveur, un Linux arm64), ou pour piloter A-I-D depuis le navigateur :

```bash
curl -fsSL https://github.com/morzu117/aidboard/releases/latest/download/install-server.sh | sh
export PATH="$HOME/.aid/server/current/bin:$PATH"   # à ajouter à ~/.bashrc ou ~/.zshrc
aid                                                  # lance le daemon et ouvre le navigateur
```

Le script prend l'archive de ta plateforme (macOS ou Linux, arm64 ou x64), vérifie sa somme SHA-256, et la
pose dans `~/.aid/server/<version>/`. Il ne demande jamais sudo. Variables possibles :
`AID_SERVER_VERSION=0.9.0` pour une version précise, `AID_HOME` pour un autre dossier que `~/.aid`.

## Mettre à jour

L'app et le serveur se mettent à jour **séparément**. Il faut accepter les deux.

| Quoi       | Quand                                                                                   | Comment                                                                         |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| AID Board  | à chaque ouverture de l'app                                                             | boîte « AID Board X est disponible », bouton **Mettre à jour** ; l'app redémarre |
| AID Server | à l'ouverture de l'app, puis toutes les 30 min dans le board                            | boîte au lancement, ou bandeau « AID Server X disponible », **Mettre à jour**   |
| AID Server | à la main                                                                               | `aid server install`, puis `aid stop` et `aid`                                  |

Si des agents tournent, le bandeau le dit et propose de forcer : les agents en cours sont alors arrêtés.
Mieux vaut attendre qu'ils aient fini.

Les mises à jour de l'app sont signées : une mise à jour dont la signature est fausse est refusée.

**Revenir en arrière**

- Serveur : `aid server use <version>`. Les deux dernières versions installées sont gardées ; `aid server status`
  les liste.
- App : télécharge l'ancienne version sur la page des releases et réinstalle-la par-dessus.

## Vérifier

```bash
aid doctor     # vérifie la machine et dit quoi corriger
aid status     # pid, port, nombre de sujets et d'agents vivants
aid server status   # version installée et versions gardées
```

Sous Windows, ces commandes se lancent dans Ubuntu. Sans `aid` sur le PATH, le chemin complet est
`~/.aid/server/current/bin/aid`.

## Désinstaller

1. Arrête le daemon : `aid stop` (refusé si des agents tournent ; `aid stop --force` les arrête).
2. Si tu as installé les hooks Claude Code : `aid hooks uninstall`.
3. Désinstalle l'app (voir ton système plus haut).
4. Supprime les données, après avoir gardé ce qui t'importe : `rm -rf ~/.aid`.

`~/.aid` contient la config, la base des sujets, les worktrees, la mémoire locale, les journaux, l'identifiant
cockpit et les versions du serveur. Le mesh garde son état à part, dans `~/swarph_state`, et le noyau
multi-agents dans `~/.agent-kernel` : supprime-les seulement si tu n'utilises plus swarph ni le noyau.
