# Chantier 33 : rejoindre un mesh depuis A-I-D, avec le jeton de cell

| Champ | Valeur |
|---|---|
| État | **Révision 1, 14 novembre 2026.** Relu par le lab (DM 98234) : le plan tient, avec quatre changements dans D334, faits ici. Choix de Julien du 14 novembre : le jeton de cell de `swarph join` (#1582) suffit, le chantier n'attend plus le flux SSO de l'émetteur. Julien a tranché Q1 à Q3 le 14 novembre (les recos). Le lab a répondu à L1 à L4 (DM 98234). |
| Emplacement final | `docs/chantiers/33-rejoindre-mesh.md` sur `main` |
| Base | `main` (6346fee) |
| Organisation | Comme au 41. cell-gestion gère le chantier ; Codex CLI écrit le code et les tests de chaque point ; cell-gestion relit, lance le gate, commite et ouvre la PR. |
| Validation | Le 33 touche au contrat swarph (programme §5 bis) : le lab relit ce plan, puis le code de 33.2 et 33.3, comme pair distinct du constructeur. Ensuite la recette de Julien, et son oui pour le merge, CI verte. |
| Prérequis | swarph-cli 0.80.0 ou plus (`swarph join`, #1582). Un opérateur du gateway visé pour approuver le code. |

## 1. Pourquoi

Le programme (§5, phase 4) prévoit au 33 la « connexion SSO dans A-I-D : QR, jeton court, révocation, mode `auto` interdit ». Le flux SSO de l'émetteur n'a ni carte ni date. Depuis la 0.80.0, `swarph join` fait entrer une nouvelle cell dans un mesh **sans passer de jeton à la main** : la cell affiche un code, un opérateur du gateway l'approuve, et la cell récupère son propre jeton. Julien a choisi le 14 novembre de s'en contenter.

Aujourd'hui, pour brancher un mesh dans A-I-D, il faut créer la cell et son jeton hors d'A-I-D, puis écrire la config à la main (46, D311). Le 33 fait ce parcours depuis l'écran : rejoindre, suivre l'approbation, puis déclarer le mesh.

## 2. Ce que `swarph join` fait (swarph-cli 0.80.0, `docs/device-join.md`)

- `swarph join <gateway> --name <cell>` crée une **nouvelle** identité. Un nom déjà pris est refusé. Ce n'est ni une récupération ni une rotation de jeton.
- La commande affiche une ligne `Code: XXXX-XXXX (expires in 15 minutes). Ask the operator to run: swarph mesh approve XXXX-XXXX --gateway <gateway> --witness <peer>`. Le code suit `[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}`.
- Un opérateur approuve avec `swarph mesh approve <code> --gateway … --witness <témoin> --token-file <jeton opérateur>`, ou refuse avec `--refuse`. Un jeton de cell ordinaire n'est pas un jeton opérateur.
- La commande interroge le gateway jusqu'à 15 minutes. À l'approbation, elle écrit le jeton dans `~/.config/swarph/<cell>.peer_token` (0600, dossier 0700) et un fichier `<cell>.join.json` (nom, gateway, chemin du jeton). Un fichier déjà présent est refusé avant toute demande.
- Elle vérifie l'identité par `/whoami`, puis affiche quatre questions de ratification. Sans terminal interactif, elle n'envoie aucune réponse : la cell est inscrite, **non ratifiée**, jusqu'au processus du témoin.
- En HTTP clair, seuls `*.ts.net` et `100.64.0.0/10` passent sans `--allow-unsafe-http`.
- En cas d'échec, elle écrit `swarph join: <raison>` sur la sortie d'erreur et sort en 1. Les raisons connues (relevées par le lab, DM 98234) : `access_denied`, `expired_token`, `already_redeemed`, `name_unavailable` (au retrait du jeton seulement), `pickup_failed`, `join request expired`, `invalid peer name`, `invalid gateway URL`, `join request refused (HTTP <n>)` (409 : nom déjà pris à la demande ; 429 : trop de demandes), `non-tailnet HTTP requires --allow-unsafe-http…`, `native Windows credential storage is unsupported; use Linux or WSL`, `gateway request failed…`, `local storage failure or cancellation…`.
- Deux raisons disent que le jeton a pu être retiré : `authenticated identity check failed; the private credential file is retained` et `invalid token pickup response; operator recovery may be needed`.
- Au succès sans terminal, la commande écrit `No interactive answers were supplied; no handshake was sent. Send your own answers to <témoin>.` C'est le seul endroit où elle donne le nom du témoin.
- Ce texte n'est pas un contrat : pas de `--json`, aucune promesse de stabilité (L1). Les défauts du client sont notés sur #1582, sans date de correction.

Ce que ça change par rapport au programme :
- **Le jeton n'est pas court.** C'est un jeton de cell, qui vit jusqu'à sa révocation.
- **La révocation** est celle du gateway, par l'opérateur. A-I-D ne peut pas révoquer.
- **Le QR** n'a plus de destinataire : personne ne scanne, l'opérateur tape le code dans son terminal.

## 3. Cible et hors-périmètre

**Cible.**
- Dans l'écran Machines, une action « Rejoindre un mesh » : Julien donne l'adresse du gateway, le nom de la nouvelle cell et le nom local du mesh.
- A-I-D lance `swarph join`, affiche le code et la commande d'approbation à transmettre à l'opérateur, puis suit l'attente jusqu'au succès, au refus ou à l'expiration.
- Au succès, A-I-D ajoute le mesh à sa config (`meshes.<nom>`, D311), et dit que la cell n'est pas encore ratifiée.
- « Oublier ce mesh » retire l'entrée de la config, et dit clairement que le jeton n'est pas révoqué pour autant.

**Hors-périmètre.**
- Le SSO de l'émetteur, le jeton court par app et le QR. Ils reviendront si le flux SSO est construit.
- La révocation au gateway, la récupération d'un retrait de jeton perdu, la rotation.
- L'approbation elle-même : A-I-D n'exécute jamais `swarph mesh approve`, et ne touche jamais un jeton opérateur.
- Les réponses de ratification : ce sont les mots de la cell, pas ceux d'A-I-D.
- Le lancement du monitor et du sidecar de la nouvelle cell.

## 4. Décisions

### D333. Le jeton de cell tient lieu de SSO (choix de Julien, 14 novembre 2026)

Le 33 s'appuie sur `swarph join`. Le jeton reste dans le fichier qu'écrit swarph. **A-I-D ne lit jamais son contenu**, ne l'affiche pas, ne l'envoie nulle part et ne le met dans aucun journal. Il vérifie seulement que le fichier existe et qu'il est en 0600, comme `doctor` le fait déjà (D39).

### D334. Le lanceur de `swarph join`

- Le daemon lance `<mesh.bin> join <gateway> --name <cell>` comme processus enfant :
  - sans shell, arguments en tableau ;
  - **entrée standard sur `/dev/null`** (en Node, `stdio: ['ignore', 'pipe', 'pipe']`), jamais un descripteur fermé. Un descripteur fermé fait planter swarph **après** l'écriture du jeton : la cell serait inscrite, et A-I-D afficherait « échec » (L2) ;
  - `HOME` est le `home` du mesh (D311), par défaut celui du daemon ;
  - l'environnement est nettoyé : ni `SWARPH_SELF`, ni `MESH_GATEWAY_URL`, ni `MESH_GATEWAY_TOKEN`, ni jeton GitHub ;
  - **`PYTHONUNBUFFERED=1`** : sans lui, la ligne `Code:` reste en tampon jusqu'à la fin du processus (L1).
- **Jamais `--allow-unsafe-http`.** A-I-D refuse d'avance une adresse HTTP qui n'est ni en `*.ts.net` ni en `100.64.0.0/10`, avec le même message que swarph.
- Le nom de cell suit `^[a-z][a-z0-9-]{0,62}[a-z0-9]$`, comme le gateway. Le nom local du mesh suit D311. A-I-D refuse d'avance un nom de mesh déjà dans la config, et un fichier de jeton déjà présent pour cette cell.
- La sortie est lue ligne par ligne. Seules deux lignes sont interprétées, par des expressions ancrées : `Code: …` et `… Send your own answers to <témoin>.` (le nom du témoin suit la forme des noms de cell). Le reste n'est ni affiché ni gardé, sauf la raison d'échec `swarph join: <raison>`, ramenée à la liste fermée du §2, et « échec » pour tout le reste.
- **Deux échecs ne sont pas de simples échecs** : `authenticated identity check failed…` et `invalid token pickup response…`. Le jeton a pu être retiré. L'état devient `a-voir`, avec « Le jeton a peut-être été retiré : vois avec l'opérateur du gateway. » A-I-D ne relance jamais.
- Une seule demande à la fois. swarph s'arrête seul à 15 minutes ; le délai de 16 minutes d'A-I-D n'est qu'un filet.
- **Annuler, ou atteindre le délai : SIGINT, puis attendre la fin** (L3). SIGINT retire les deux fichiers réservés ; SIGTERM laisse deux fichiers vides qui bloquent la tentative suivante. Si le processus ne finit pas en 10 secondes : SIGKILL, puis A-I-D retire `<cell>.peer_token` et `<cell>.join.json` **seulement s'ils font 0 octet**. Un fichier de jeton non vide est un vrai jeton : A-I-D ne le supprime jamais.
- **Après une annulation**, l'écran dit « Demande annulée : demande à l'opérateur de refuser le code XXXX-XXXX », avec la commande `swarph mesh approve XXXX-XXXX --gateway <gateway> --refuse --token-file <JETON-OPÉRATEUR>` à copier. Sans ce refus, une approbation tardive réserve le nom jusqu'à l'expiration (L3).
- Les états servis : `demande`, `en-attente` (avec le code et l'expiration), `approuve` (avec le témoin s'il est lu), `refuse`, `expire`, `annule` (avec le code), `a-voir`, `echec` (avec le libellé).

### D335. La route et la config

- `POST /api/meshes/rejoindre` `{gateway, cell, mesh}` lance la demande. `GET /api/meshes/rejoindre` lit son état. `DELETE` l'annule et arrête le processus.
- Ces routes sont **réservées à l'admin, et ne sont pas servies en mode host** (D178), comme toute route qui écrit la config.
- Au succès, A-I-D ajoute `meshes.<mesh>` avec `cell` et `gateway`, par un écrivain de config du même modèle que `ecrireModeHost*`. Le fichier garde ses droits. Le mesh est pris en compte au prochain démarrage du daemon : A-I-D le dit, et ne redémarre rien lui-même.
- « Oublier ce mesh » (`DELETE /api/meshes/<mesh>`) retire l'entrée. Il ne supprime ni le jeton ni `<cell>.join.json`, et l'écran dit : « Le jeton existe toujours. Pour le révoquer, demande à l'opérateur du gateway. » `principal` ne s'oublie pas d'ici.
- **Plancher de version** : swarph-cli 0.80.0. En dessous, la route répond « swarph trop ancien pour rejoindre un mesh (0.80.0 ou plus) », et `doctor` le signale.

### D336. La vue

- Dans Machines, une section « Meshes » : la liste de la config (nom, cell, gateway, jeton présent ou non), et le bouton « Rejoindre un mesh ».
- Le formulaire a trois champs. Le gateway est affiché tel que Julien l'a tapé, en texte brut.
- Pendant l'attente : le code en grand, son expiration en compte à rebours, et un « Copier » de la commande d'approbation, avec `<TÉMOIN>` et `<JETON-OPÉRATEUR>` à remplir. A-I-D ne l'exécute jamais.
- Au succès : « Cell inscrite, pas encore ratifiée : la boîte marche, le board reste vide jusqu'à la ratification » (L4). Puis les quatre questions de ratification, en texte, avec la commande d'envoi à copier (le témoin lu dans la sortie, ou `<TÉMOIN>` à remplir : `swarph mesh send <témoin> --content-file <réponses> --as <cell> --gateway <gateway> --token-file <chemin>`), et « Redémarre le daemon pour activer ce mesh. »
- Tout ce qui vient de swarph s'affiche en texte brut (invariant 9).

## 5. Questions

### Pour Julien (tranchées le 14 novembre 2026 : les trois recos)

- **Q1. Le mode `auto` et le jeton.** Le programme interdit le mode `auto` (`bypassPermissions`) à une session qui détient le jeton SSO. Avec un jeton de cell dans `~/.config/swarph`, tout agent lancé sous le même utilisateur peut le lire, en `auto` ou non (`device-join.md` le dit : le flux ne remplace pas l'isolation des cells par l'OS). Reco : **(a)** garder les agents comme aujourd'hui, et écrire ce risque dans la fiche de recette **(choisi)** ; (b) refuser le mode `auto` dès qu'un mesh rejoint par A-I-D est configuré ; (c) reporter la question à l'isolation des drones (#20).
- **Q2. Une confirmation du téléphone pour rejoindre ?** Reco : **non (choisi)**. L'approbation de l'opérateur au gateway est déjà le geste humain, et rien n'est écrit sur le mesh avant elle. Une confirmation en plus doublerait le geste quand l'opérateur est Julien.
- **Q3. La place.** Reco **(choisie)** : la section « Meshes » de l'écran Machines, plutôt qu'un écran nouveau.

### Pour le lab (réponses du 14 novembre 2026, DM 98234)

- **L1.** La ligne `Code: …` sur la sortie standard et la forme `swarph join: <raison>` sont-elles assez stables pour être lues par A-I-D ? Sinon, une sortie `--json` est-elle prévue ?
  → Lisible, pas un contrat ; pas de `--json`. Il faut `PYTHONUNBUFFERED=1`. Liste des raisons complétée au §2.
- **L2.** Une entrée standard fermée est-elle bien le chemin « non interactif » prévu, sans effet de bord ?
  → Oui avec `/dev/null`, non avec un descripteur fermé (plantage après l'écriture du jeton).
- **L3.** Arrêter le processus pendant l'attente (annulation, délai) laisse-t-il une demande en cours au gateway ? Le doc dit qu'une demande expire à 15 minutes ; A-I-D doit-il prévenir l'opérateur ?
  → Rien d'orphelin au gateway : une demande en attente ne réserve pas le nom, et la cell n'est inscrite qu'au retrait du jeton. Mais une approbation tardive réserve le nom jusqu'à l'expiration : prévenir l'opérateur de refuser. Arrêter par SIGINT, pas SIGTERM.
- **L4.** Une cell rejointe par A-I-D reste non ratifiée. Peut-elle lire le board et la boîte avant ratification, ou A-I-D doit-il attendre ?
  → La boîte oui (lu dans le code, pas essayé en réel). Le board non : la ligne « * » ne s'applique pas à une cell non ratifiée, qui ne voit aucune carte, ni les envois au groupe ALL. A-I-D n'attend pas, mais l'écran le dit.

## 6. Points

### 33.1 Le plan

Ce document, et une ligne dans `README.md`.

### 33.2 Le lanceur (D334)

Le lanceur, la lecture de la sortie, la liste fermée des raisons, les délais, l'annulation, l'environnement nettoyé. Les tests utilisent un faux `swarph` qui rejoue chaque issue : approuvé (avec et sans ligne du témoin), refusé, expiré, nom pris (HTTP 409), adresse refusée, jeton peut-être retiré, sortie inattendue, processus qui ne finit pas. Ils vérifient l'entrée sur `/dev/null`, `PYTHONUNBUFFERED=1`, l'arrêt par SIGINT, et qu'après SIGKILL seuls des fichiers vides sont retirés.
- _Révision 33.2._ `src/daemon/mesh/rejoindre.ts` (`LanceurRejoindre`), un faux `swarph join` et 25 tests. Le validateur des noms de mesh (D311) est extrait de `config.ts` (`nomMeshValide`) : 2 lignes existantes modifiées. Reprise r1 après relecture : un binaire introuvable donne `echec` « swarph introuvable » et libère le lanceur, avec une seule fin même si Node émet `error` sans `close` (vérifié sous Node 22 et 24) ; l'état de départ est `aucune`, ajouté aux états de D334. Après une sortie 0, un jeton absent, vide ou pas en 0600 donne `a-voir`. Gate 3918, gate:e2e 132 sous Node 22, 5/5 passages des tests du point.

### 33.3 Les routes, la config et le plancher (D335)

Les trois routes, l'écrivain de config, « Oublier », le plancher de version et la ligne de `doctor`. Les tests vérifient que les routes refusent hors admin et en mode host, et qu'aucun contenu de jeton ne sort par une route ni un journal.

### 33.4 La vue (D336)

La section « Meshes », le formulaire, l'attente, le succès et les échecs.

### 33.5 L'e2e et la fiche de recette

Un e2e Machines avec le faux `swarph`, et la fiche `docs/recette-chantier-33-rejoindre-mesh.md`. La fiche écrit le risque de Q1 : tout agent lancé sous le même utilisateur peut lire le jeton de cell. La recette réelle demande un gateway et un opérateur : elle se fait avec le lab, ou sur le mesh de Julien.

## 7. Pièges

- Les exemples n'utilisent que des noms neutres et des adresses d'exemple (`aid-e2e.ts.net`, `192.0.2.x`, `peer-a`). Aucun vrai gateway, hôte du tailnet ni jeton dans le dépôt.
- Le faux `swarph` des tests écrit un faux jeton dans un `HOME` temporaire, jamais dans le vrai `~/.config/swarph`.
- Un retrait de jeton perdu ne se rejoue pas (`device-join.md`). A-I-D ne relance jamais une demande d'office.

## 8. Fini quand

- Depuis Machines, Julien rejoint un mesh, voit le code, et le mesh apparaît dans la config après l'approbation de l'opérateur.
- Les refus, expirations et erreurs ont chacun leur message, et ne laissent aucune entrée de config.
- Aucun contenu de jeton ne sort du fichier de swarph.
- Le lab a relu le plan et le code de 33.2 et 33.3.
