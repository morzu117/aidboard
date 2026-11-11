# Recette Windows 11 + WSL2 — A-I-D Board / Server

## Prérequis exacts

Fiche **à exécuter sur un vrai Windows**, aucune case n'est acquise par l'audit.
Utiliser un poste ou compte de recette isolé et des dépôts jetables. Le Board
utilise l'utilisateur par défaut de la distribution WSL par défaut. Un `AID_HOME`
exporté dans son shell de login interactif permet d'isoler l'état ; le Board
le lit aussi pour `daemon.json`. Ne pas utiliser le daemon de travail.

- [ ] Windows 11 **x64**, virtualisation et WSL2 opérationnels ; WebView2 Runtime
      présent. Consigner version Windows, WSL et WebView2, sans identifiant personnel.
- [ ] Distribution Linux WSL **version 2**, installée et initialisée avec un
      utilisateur non root ; choisir Ubuntu 22.04 ou 24.04 pour cette recette,
      en notant la version. Le dépôt ne fixe pas une liste de distributions WSL
      supportées : ce choix borne la recette, pas une promesse de compatibilité générale.
- [ ] Dans PowerShell, `wsl.exe --status` et `wsl.exe --list --verbose` confirment
      que la distribution voulue est celle par défaut et qu'elle est en version 2.
      Au besoin, faire l'installation initiale avec `wsl.exe --install`, redémarrer
      Windows, terminer l'initialisation, puis choisir la distribution de recette
      avec `wsl.exe --set-default <distribution-de-recette>`.
      Ne pas joindre les sorties brutes contenant les identités du poste.
- [ ] Dans WSL, Bash, sh, curl, tar, gzip, awk, cut, coreutils (dont sha256sum,
      ln et mv), certificats CA et git sont disponibles. Pour Ubuntu :

  ```bash
  sudo apt update
  sudo apt install bash curl ca-certificates tar gzip coreutils gawk git build-essential python3 wslu
  ```

  `build-essential` et `python3` sont les prérequis Linux/WSL de D5 pour une
  compilation des natifs ; l'archive Server normale livre déjà son Node et
  ses natifs. `wslu` fournit `wslview` ; si indisponible dans la distribution,
  consigner l'écart et tester le repli `cmd.exe` avant de considérer l'ouverture acquise.

- [ ] **Pas de Node système requis pour le Server en archive.** Pour les projets
      Node et pour les vérifications du dépôt : Node **>=22.12 et <25**, essais
      sous Node 22 puis 24 ; npm disponible séparément (le Node embarqué n'inclut
      pas npm, `scripts/package-server.sh:82`). Ni Rust ni compilateur Windows requis
      pour installer le MSI préconstruit.
- [ ] Agents à essayer installés **dans WSL**, authentifiés dans le même compte
      Linux : `claude` et `codex`. Facultatifs selon les cas : `gh` authentifié
      pour la livraison, `code` avec intégration WSL, codegraph et swairm.
      Ne pas transcrire de compte ni de valeur de clé dans cette fiche.
- [ ] Vérifier le PATH par le chemin exact du Board depuis PowerShell :

  ```powershell
  wsl.exe -e bash -l -i -c 'command -v bash curl tar git claude codex; test -x "${AID_HOME:-$HOME/.aid}/server/current/bin/aid"'
  ```

  Avant installation, le dernier test peut échouer normalement. Après installation,
  il doit réussir. Le shell de login interactif charge le PATH des agents
  configuré par nvm, mise ou fnm dans `~/.bashrc` (via `~/.profile` sur Ubuntu).
  Les avertissements de job control sans terminal ne doivent pas masquer la sortie utile.

- [ ] Dépôts sous `~/…` et état sous `~/.aid` **dans le système de fichiers Linux**,
      pas sous `/mnt/c`. Git configuré dans WSL pour commiter dans un dépôt de recette.
- [ ] Depuis Windows, accès au loopback du daemon WSL ; ports 4870 (daemon),
      4871 (pont Windows), 4880 par défaut (artefacts) et 4890 par défaut (appareils)
      disponibles. Vérifier transfert localhost et pare-feu sans ouvrir ces ports au LAN.
- [ ] Accès HTTPS sortant pour téléchargement des releases et authentification
      des agents ; DNS et horloge Windows/WSL synchronisés.
- [ ] Pour mesh/host/mobile : Tailscale **utilisable depuis WSL**, connecté au
      tailnet de recette ; ne pas supposer que l'installation Windows seule suffit.
      Choisir une seule topologie de référence (Tailscale et Serve Linux dans WSL,
      ou exécutable Windows explicitement configuré), puis noter ce choix anonymisé.
- [ ] Pour mesh : swarph Linux dans le PATH du daemon, version compatible avec
      les lectures Board (`aid doctor`), Python 3.12/uv si installé par uv ; cell
      dédiée `peer-a`, enrôlée, avec droits de lecture de recette ; proxy Unix et
      inbox lisible si ce transport est retenu. Ne jamais réutiliser l'identité d'un autre poste.
- [ ] Pour supervision : systemd opérationnel dans cette distribution WSL,
      unité de monitor installée par l'opérateur selon la documentation du build
      swarph retenu, démarrage et droits vérifiés. A-I-D ne l'installe pas.
- [ ] Pour mobile : téléphone connecté au tailnet, MagicDNS et certificats HTTPS
      activés pour Serve, nom de recette représenté ici par `aid-e2e.ts.net` ;
      iPhone iOS 16.4+ avec PWA installée et Android Chrome à tester séparément.
- [ ] Pour PDA : relais séparé sur un serveur de recette, HTTPS public et
      origine autorisée exacte de la PWA, clé publique du daemon configurée,
      passkeys ES256 avec vérification utilisateur et second téléphone disponible.
      Exemple de relais : `https://relais.example.com` ; jamais exposer le cockpit public.

Toutes les adresses et identités ci-dessous sont des exemples. Ne conserver
aucun hôte réel, IP de tailnet, login, jeton, cookie, clé privée ou QR complet.
Chaque étape reçoit un constat anonymisé et un résultat **OK / KO / non fait**.
Un cas facultatif non réalisé doit rester explicitement non validé.

## Installation du MSI non signé

- [ ] W.R.1 Identifier le commit et la version des artefacts de recette.
      Le brief vise v0.7.0, mais le source `949fcdd` annonce 0.6.1 : vérifier
      leur correspondance avant toute conclusion. Télécharger le MSI x64 depuis
      la page de release officielle indiquée dans le README, puis vérifier
      version, provenance et somme de contrôle si publiée.
- [ ] W.R.2 Ouvrir le MSI. Relever le comportement de **SmartScreen** :
      l'installeur n'est pas signé avec un certificat Windows reconnu ; la signature
      minisign des mises à jour ne supprime pas cet avertissement.
      Sur ce poste de recette et après vérification de provenance, utiliser
      **Informations complémentaires → Exécuter quand même**, si cette option est
      proposée, puis suivre l'assistant et accepter l'UAC si demandé.
      Si une politique d'entreprise interdit l'exécution, noter **KO, installation
      bloquée par politique** ; ne pas désactiver globalement SmartScreen ou Defender.
- [ ] W.R.3 Lancer AID Board depuis le menu Démarrer, sans terminal WSL ouvert.
      Attendu : Installation d'AID Server, Démarrage, puis cockpit dans une fenêtre native.
      WSL doit héberger l'archive Linux, pas un daemon Windows.
- [ ] W.R.4 Dans WSL : `~/.aid/server/current/bin/aid --version`,
      `~/.aid/server/current/bin/aid server status`, puis
      `~/.aid/server/current/bin/aid doctor`. Vérifier Node/natifs, droits de `~/.aid`
      et diagnostic. Ne pas recopier `daemon.json`, ni les liens d'ouverture.
      Classer séparément avertissements de fonctions facultatives et erreurs bloquantes.
      Attendu : WSL2 reconnu ; WSL1 refusé ; avertissement pour dépôt ou `AID_HOME`
      sous `/mnt/` ; sans `wslview`, avertissement indiquant le repli `cmd.exe /c start`
      si disponible, sinon ouverture automatique indisponible.

Constat Windows / WSL / artefacts / installation : _à remplir_.

## Un parcours par fonction

### W.R.5 — Mise à jour de l'app

- [ ] Sur une installation de recette d'une version antérieure, disposer d'une
      release suivante signée par la même clé updater et d'un manifeste qui la référence.
      Ne pas modifier la version du source audité. D'abord « Plus tard » : aucune installation.
      Relancer, accepter : nouveau MSI appliqué, une fenêtre utilisable et version attendue.
- [ ] Répéter avec réseau indisponible ; l'app déjà installée reste utilisable.
      Le refus d'une signature invalide se teste dans un circuit de publication de
      recette préparé séparément, jamais en altérant une release publique.
- [ ] Garder un shell de recette vivant pendant l'opération et relever son sort.
      **Défaut attendu à cette tête :** la réouverture cycle le daemon et arrête le
      shell malgré la promesse du dialogue ; ne pas cocher la continuité comme réussie.

Constat version / annulation / panne / agents : _à remplir_.

### W.R.6 — Mise à jour du serveur

- [ ] Avec deux archives publiées compatibles, installer l'ancienne dans le compte
      isolé, lancer le Board, attendre l'annonce de version suivante ; appliquer
      depuis le bandeau et vérifier la version réellement en cours et le lien `current`.
- [ ] Avec un agent de recette vivant, vérifier le refus ou l'avertissement avant
      mise à jour ; accepter seulement dans le scénario prévu et relever la reprise.
- [ ] Couper le réseau avant le téléchargement : ancienne version et données conservées,
      erreur visible. Revenir au réseau, recommencer, puis `aid server status`.
- [ ] Tester `aid server use <version-précédente>` dans l'instance isolée, arrêter
      puis redémarrer via la CLI sans `--cycle` ; vérifier binaire et données.
      Rouvrir le Board peut rechercher/appliquer à nouveau une mise à jour : l'observer.

Constat version / intégrité / erreurs / retour arrière : _à remplir_.

### W.R.7 — Lancement, arrêt et reprise du daemon

- [ ] Démarrage à froid depuis le menu Démarrer : page servie par WSL accessible
      depuis la WebView Windows. Fermer la fenêtre sans relancer : le daemon reste vivant.
      Rouvrir le Board : observer le cycle prévu et son effet sur les agents.
- [ ] Dans le navigateur Windows, ouvrir la même instance par `aid open`.
      Arrêter le daemon sans agent, garder la coquille ouverte, cliquer Redémarrer :
      retour du daemon par le pont Windows 4871 et reconnexion.
- [ ] Tester port 4870 occupé, puis 4871 occupé sur le compte de recette ; relever
      le message et l'absence de démarrage concurrent, libérer les ports ensuite.
- [ ] Fermer les outils de recette puis tester veille/reprise, verrouillage et
      `wsl.exe --shutdown` ; après extinction WSL, aucun PTY ne doit être déclaré
      conservé, le Board doit pouvoir redémarrer l'instance.
- [ ] **Home personnalisé isolé** : exporter `AID_HOME` dans la configuration du
      shell de login WSL, avec un chemin Linux contenant des espaces ; comparer
      lancement CLI et Board. Le Board doit lire le port de ce home, sans utiliser
      le home par défaut. Ne pas déplacer les données de travail pour ce test.

- [ ] **Transfert localhost coupé** : dans une configuration de recette WSL2 en
      mode NAT, poser `localhostForwarding=false` dans `%UserProfile%\.wslconfig`,
      puis `wsl --shutdown` et lancer le Board. Vérifier « Connexion à AID Server… »,
      puis, sous 10 secondes après cette étape, le message expliquant que Windows
      ne joint pas `127.0.0.1:<port>` et proposant `localhostForwarding=true`
      (ou `networkingMode=mirrored`), `wsl --shutdown` et une relance d'AID.
      La page d'attente reste ouverte, aucune fenêtre principale ni page d'erreur
      WebView. Rétablir la configuration, arrêter WSL et relancer : le Board s'ouvre.

Constat loopback / pont / veille / home personnalisé : _à remplir_.

### W.R.8 — Terminaux et agents

- [ ] Créer trois sujets dans le dépôt jetable. Dans chaque terminal shell,
      vérifier le `pwd` du worktree, accents, collage multiligne, Ctrl+C et redimensionnement.
- [ ] Lancer Claude et Codex Linux en stream, puis leur mode terminal dans une
      instance/configuration de recette appropriée ; accepter leurs dialogues de
      confiance et vérifier leur authentification, sans afficher de secrets.
- [ ] Faire attendre une question puis une permission, répondre depuis le poste,
      interrompre un tour, reprendre une conversation. Fermer et rouvrir **la vue web** :
      historique et agent vivants conservés ; distinguer cela d'une relance du Board.
- [ ] `aid stop` avec agents vivants refuse ; `aid stop --force` sur la recette
      termine les enfants, sans processus orphelin. Ne jamais l'exécuter sur le daemon de travail.

Constat PTY / stream / PATH / interruptions : _à remplir_.

### W.R.9 — Worktrees et livraison

- [ ] Enregistrer un dépôt Linux de recette ; nouveau sujet, branche et worktree
      séparés, fichier avec espaces et accents. Refuser le nettoyage quand le dépôt
      est sale, puis vérifier la confirmation de commits non fusionnés.
- [ ] Sur un dépôt de recette distinct sous `/mnt/c`, vérifier l'avertissement de
      performances et retirer ensuite son enregistrement ; ne pas y mener le parcours principal.
- [ ] Avec `code` et son intégration WSL, ouvrir fichier et diff dans l'éditeur
      Windows ; sans `code`, vérifier le résultat réel du repli au lieu de le supposer.
- [ ] Avec une forge de recette et `gh` dans WSL, vérifier test local, PR et tête
      affichée dans Livraison. Ne confirmer push/merge que sur ce dépôt jetable ;
      quand les confirmations sont armées, réaliser aussi W.R.13.
- [ ] Machines : diagnostiquer agents et mémoire ; relever que la mémoire est
      celle de WSL, et relever les libellés « Mac » affichés sous Windows.

Constat chemins / nettoyage / éditeur / livraison : _à remplir_.

### W.R.10 — Mesh, proxy et monitor supervisé

- [ ] Configurer `peer-a` et un gateway de recette représenté par
      `https://example.com`, avec les vrais paramètres conservés uniquement localement.
      Connecter ; faire émettre depuis un autre pair de recette un DM neutre.
      Vérifier arrivée unique, « Vu », lectures Board, Cells, Memory et ouverture de la cell.
- [ ] Monitor **vivant et supervisé systemd** : noter son état, connecter puis
      déconnecter depuis A-I-D ; aucun start/stop ni hold induit, monitor toujours vivant,
      seuls le suivi et l'état A-I-D changent. Répéter après cycle du Board.
- [ ] Monitor arrêté sous supervision : reconnecter et relever le démarrage hors
      superviseur éventuel. Consigner ce risque séparément ; rétablir l'unité par son
      gestionnaire, sans prétendre qu'A-I-D l'a installée ou réparée.
- [ ] Transport proxy Unix : socket et inbox dans WSL avec permissions appropriées,
      config `proxySocket` + `inboxLog`. Lectures sans repli CLI ; liens Memory annoncés
      indisponibles. Avec lecture seule, aucun envoi possible ; proxy coupé, erreur explicite.
- [ ] Si les écritures sont autorisées sur le proxy de recette, confirmer au téléphone
      une note ou un DM neutre puis relire pour prouver l'envoi unique ; coupure de socket
      après requête = résultat possiblement incertain, jamais répétition automatique.

Constat superviseur / suivi / proxy / droits : _à remplir_.

### W.R.11 — Tailscale

- [ ] Depuis le même `bash -l -i -c` que le Board, vérifier binaire et état Tailscale.
      D'abord avec installation Windows seule : noter l'absence attendue du binaire
      Linux par défaut. Ensuite avec la topologie explicitement choisie : état connecté,
      résolution DNS et accès réel du gateway depuis WSL, sans recopier les sorties d'identité.
- [ ] `mesh.tailscale.manage: false` : connecter/déconnecter A-I-D ne coupe pas
      Tailscale. Si `true` est essayé dans un environnement dédié, seuls les services
      montés par A-I-D doivent être descendus ; noter tout besoin d'élévation ou blocage.

Constat topologie / DNS / réseau / gestion : _à remplir_.

### W.R.12 — Mode host et mobile

- [ ] Activer Mode host. Depuis **l'environnement où tourne Serve**, appliquer la
      commande proposée, par exemple `tailscale serve --bg --https=443 http://127.0.0.1:4890`.
      Vérifier que seul ce port appareils est exposé, jamais 4870, 4871 ou artefacts,
      et qu'aucun Funnel n'est actif. Depuis le téléphone : HTTPS valide sur le nom de recette.
- [ ] Refaire la mesure des en-têtes du chantier 31 dans cette topologie si nécessaire ;
      une identité déclarée n'est pas une preuve supplémentaire tant que cette mesure
      n'est pas faite. Retirer toute configuration de sonde à la fin.
- [ ] Appairer par QR et code court comparés sur les deux vues ; approuver depuis
      Windows. Installer la PWA iPhone depuis Safari, puis Android depuis Chrome.
- [ ] Depuis le téléphone : trois onglets si mesh actif, question autorisée en mode
      compatible, permission sans bouton de réponse, tour marqué relu visible au poste.
      Afficher le diff seulement si l'option est activée ; fichier sensible refusé.
- [ ] Terminal, commandes admin et merge direct indisponibles sur le port appareils.
      Révoquer le téléphone avec sa page ouverte : accès coupé immédiatement ; refaire
      l'essai d'expiration à 8 h sans réduire cette durée dans le produit.
- [ ] Arrêter le daemon de recette : dernier état daté, aucune écriture possible ;
      revenir puis révoquer et constater la purge des données locales en ligne.
      Vérifier séparément le résidu d'un appareil resté hors ligne.

Constat Serve / frontière / iPhone / Android / hors ligne : _à remplir_.

### W.R.13 — PDA et confirmations par relais

- [ ] Déployer le relais de recette séparé selon `docs/recette-chantier-43-pda.md`
      (utilisateur système dédié, HTTPS, seule clé publique du daemon). Sur
      `https://relais.example.com/`, attendu 404 vide : aucun code servi par le relais.
- [ ] Dans le tailnet, enregistrer deux appareils PDA, comparer leurs empreintes,
      activer le premier depuis Windows (amorçage), puis le second par confirmation.
      Vérifier l'état armé et les numéros « toujours » affichés uniquement au poste.
- [ ] Téléphone en données mobiles, Tailscale coupé : ouvrir la PWA en cache,
      recevoir un essai, confirmer avec passkey et vérification utilisateur ; puis
      refaire avec refus et annulation de l'authentification.
- [ ] Depuis Windows, demander push/merge du dépôt jetable : file d'attente, résumé,
      tête et paramètres exacts au téléphone ; oui unique, non sans effet ; tête changée
      entre demande et oui refusée. Aucun merge lancé directement par le téléphone.
- [ ] Demande « toujours » : mauvais numéro **signé** annule ; demande expirée ou
      appareil révoqué n'exécute rien. Après révocation du dernier PDA, actions sous
      confirmation refusées ; ne pas attendre de repli silencieux.
- [ ] Arrêter puis reprendre WSL pendant une attente : échec fermé, résultat
      compréhensible, aucune exécution double. Faire tourner la clé, mettre à jour la
      clé publique du relais ; ancienne app en cache refuse, rechargement dans le
      tailnet permet la reprise. Cache perdu hors tailnet : impossible de confirmer.

Constat relais / passkeys / attentes / refus / reprise : _à remplir_.

### W.R.14 — Notifications

- [ ] Dans Réglages du Board Windows, demander la permission par clic ; minimiser
      la fenêtre et provoquer une nouvelle attente. Vérifier centre de notifications,
      contenu, clic et retour au bon sujet. Refaire avec un DM question de recette.
      Si API absente ou demande sans effet sous WebView2, noter KO explicite.
- [ ] Refaire dans un navigateur Windows ; permission refusée = aucune notification,
      pas de boucle de demande ; aucune notification de rattrapage au premier état.
- [ ] Activer le push côté host puis sur iPhone installé et Android ; vrai push
      avec nombre seul, app fermée, téléphone verrouillé, puis clic. Révocation et
      interrupteur coupé arrêtent les envois. PC en veille : noter l'indisponibilité,
      sans promettre que WSL envoie quand Windows ne tourne plus.
- [ ] Si un appareil Windows/Edge est essayé pour le push, relever le rejet d'un
      endpoint Microsoft : ce service est hors de la liste autorisée à cette tête,
      pas une preuve que tous les navigateurs Windows échouent.

Constat WebView2 / navigateur / push Apple et Google : _à remplir_.

### W.R.15 — Ouverture du navigateur

- [ ] Dans WSL, `~/.aid/server/current/bin/aid open` ouvre le navigateur Windows,
      URL en 127.0.0.1, échange du lien sensible contre cookie puis URL nettoyée.
      Vérifier `wslview`, puis le repli `cmd.exe` avec un PATH de test préparé sans
      wslview ; ne pas désinstaller les outils du poste pour réaliser ce cas.
- [ ] Avec les deux lanceurs indisponibles, message utile et URL exploitable
      localement ; aucun lien portant le jeton dans le compte rendu.
- [ ] Depuis le Board, ouvrir un lien de PR et un lien externe de documentation
      tel que `https://example.com` ; relever fenêtre courante, nouvelle fenêtre ou
      navigateur externe et vérifier qu'aucun jeton du cockpit n'est propagé.

Constat lanceurs / cookie / liens externes : _à remplir_.

## Bilan, nettoyage et décision

- [ ] Résultats séparés par fonction, versions Windows/WSL/WebView2/CLI et
      topologie anonymisée ; aucun secret ni capture contenant une identité réelle.
- [ ] Refaire les vérifications applicables aux projets sous Node 22 puis 24 ;
      distinguer ce Node de celui embarqué dans l'archive Server testée.
- [ ] Arrêter les instances et services de recette, révoquer les appareils,
      retirer les configurations temporaires Serve/proxy/relais et rétablir la
      distribution WSL par défaut précédente si elle avait été changée.
- [ ] Ne pas supprimer les données ou règles Tailscale de travail ; nettoyage
      limité aux objets de recette identifiés au préalable.

| Fonction                              | Résultat | Constat anonymisé / anomalie |
| ------------------------------------- | -------- | ---------------------------- |
| Installation MSI et amorçage          | non fait |                              |
| Mise à jour app                       | non fait |                              |
| Mise à jour serveur / retour arrière  | non fait |                              |
| Lancement daemon / pont / reprise     | non fait |                              |
| Terminaux et agents                   | non fait |                              |
| Worktrees / éditeur / livraison       | non fait |                              |
| Mesh / proxy / monitor supervisé      | non fait |                              |
| Tailscale                             | non fait |                              |
| Mode host                             | non fait |                              |
| Mobile / PDA / relais / confirmations | non fait |                              |
| Notifications                         | non fait |                              |
| Ouverture navigateur                  | non fait |                              |

Décision finale : _à remplir_. Une fonction non faite reste non validée ;
le succès du MSI ou du gate Linux ne suffit pas à annoncer « prêt pour Windows ».

## Diagnostic WSL au démarrage

Avant « Recherche d'AID Server… », Windows affiche « Vérification de WSL… ».

- [ ] Sans `wsl.exe` ou sans distribution installée : vérifier l'aide
      « WSL2 n'est pas installé », avec `wsl --install -d Ubuntu` à lancer
      dans un terminal administrateur, puis redémarrage Windows et relance d'AID.
- [ ] Avec la distribution visée en WSL1 : vérifier le message qui donne son
      nom et `wsl --set-version <nom> 2`, puis demande de relancer AID.
- [ ] Avec une distribution explicitement choisie mais absente : vérifier
      « La distribution <nom> est introuvable. Distributions présentes : <liste>. »

Pour choisir une distribution, exécuter `setx AID_WSL_DISTRO Ubuntu` dans un
terminal Windows, puis relancer AID pour qu'il hérite de la variable. Le nom
peut contenir des espaces ; les noms vides ou contenant un caractère de contrôle
sont refusés. Sans variable, AID utilise la distribution marquée `*` dans
`wsl.exe --list --verbose`, avec son utilisateur par défaut. Ce choix s'applique
au cycle, à la lecture de `daemon.json` et au pont de redémarrage. Adapter aussi
les commandes de recette en ajoutant `-d Ubuntu` avant `-e` si nécessaire.
Une erreur non reconnue de la commande de diagnostic ou une sortie illisible
laisse le démarrage continuer.
