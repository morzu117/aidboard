# Chantier 56 : les tests des interfaces

| Champ | Valeur |
|---|---|
| État | **Révision 0, 16 novembre 2026.** Demandé par Julien : « sur les sujets avec interface, souvent un CTA n'a pas le bon comportement, une action est impossible… il faut vraiment une politique de test sur les interfaces ». Julien a choisi l'ordre « audit, puis garde ». |
| Emplacement final | `docs/chantiers/56-tests-interfaces.md` sur `main` |
| Base | `main`. |
| Organisation | La cell de gestion de Julien gère le chantier. Un agent Codex CLI code sur un brief tiré de ce plan. La cell de gestion relit le diff, regarde les captures, lance le gate et `gate:e2e`, commite et ouvre la PR. |
| Validation | CI verte et oui de Julien. Le chantier ne touche ni le mesh ni la sécurité : pas de relecture du lab, sauf si un correctif touche le mode host, le PDA ou le proxy. |

## 1. Le constat

Les gates sont verts, et pourtant Julien trouve souvent, à l'usage, un bouton qui ne fait pas ce qu'il dit, ou une action impossible. Les tests web vérifient surtout que l'écran s'affiche. Les e2e suivent des parcours choisis à la main : rien ne garantit que chaque bouton est cliqué au moins une fois, ni qu'un bouton désactivé devient utilisable dans un cas réel.

## 2. Les décisions

| # | Décision | Source |
|---|---|---|
| **D342** | **La politique, pour tout point qui touche l'interface**, à partir du 31.14 :<br>1. Chaque bouton, lien ou formulaire ajouté ou modifié est **cliqué par un e2e**, dans le vrai navigateur et contre le vrai daemon. Seuls les services extérieurs sont simulés : le proxy, Tailscale, le CLI swarph, claude, codex et gh. Le test vérifie ce que l'utilisateur voit, et aussi l'effet côté serveur.<br>2. **Aucun bouton désactivé pour toujours** : pour chaque bouton qui peut être désactivé, un test le montre actif dans un cas réel, puis le clique.<br>3. **Le cas d'erreur** : chaque action a un test où le serveur refuse. L'écran affiche le message, et l'utilisateur peut recommencer.<br>4. **La revue visuelle** : avant le commit, la cell de gestion regarde les captures de l'e2e, en format bureau (1280 × 800) et en format téléphone (390 × 844).<br>5. **Le garde** (D345) fait échouer la CI si un bouton n'est cliqué par aucun e2e. | Julien, 16 novembre. |
| **D343** | **L'explorateur.** C'est un outil d'audit, hors du gate : `npm run audit:ui`, avec sa propre config Playwright (`playwright.audit.config.ts`) et ses fichiers sous `e2e/audit/`.<br>• **Ce qu'il démarre.** Un daemon isolé, avec les faux de l'e2e : un dépôt, un sujet, un serveur, un mesh avec son board et un faux proxy, le mode host actif avec une sortie synthétique de `tailscale`, et un appareil appairé. Aucun réseau, aucun vrai nom.<br>• **Ce qu'il parcourt.** Chaque route de `web/src/App.tsx`, avec un id réel pour les routes paramétrées, puis l'app de l'appareil et l'app du PDA. Il passe chaque écran dans les deux formats de D342.<br>• **Sur chaque écran**, il prend une capture, puis il liste les éléments interactifs visibles : `button`, `a[href]`, `[role=button]`, `summary`, `input`, `select`, `textarea`. Pour chacun, il relève le `data-node` (ou son absence), le texte, l'état actif ou désactivé, et le `title`.<br>• **Il clique chaque élément actif**, sur une page rechargée à neuf. Il attend 1,5 s, puis il relève les erreurs de la console, les erreurs de page, les réponses ≥ 400 (chemin et statut, jamais le corps), la navigation, les mutations du DOM et les requêtes parties.<br>• **Il classe chaque élément :** `erreur` (une erreur de la console ou de page, ou une réponse 5xx), `refus` (une réponse 4xx), `sans effet` (ni requête, ni navigation, ni mutation), `desactive` (jamais actif sur cet écran), `ok`.<br>• **Les exclusions.** Une liste écrite dans le code, avec la raison de chaque entrée. Elle couvre les boutons qui arrêtent le daemon ou ouvrent un programme externe. Si le daemon ne répond plus après un clic, l'explorateur le note et le redémarre.<br>• **Le rapport** est écrit sous `$TMPDIR/aid-audit-ui/` : `rapport.json`, un `rapport.md` trié par gravité, et les captures. Rien de tout cela n'est commité. | Julien : « audit, puis garde ». |
| **D344** | **Le tri de l'audit.** La cell de gestion lit le rapport et regarde les captures, puis elle trie :<br>• les vrais défauts, regroupés par écran ;<br>• les faux positifs de l'explorateur (un `sans effet` qui en a bien un, comme une copie dans le presse-papiers), corrigés dans l'explorateur ;<br>• les boutons désactivés à bon droit, avec le cas réel qui les rend actifs.<br>Elle montre la liste à Julien. Chaque groupe de défauts devient un point de correctif, avec son e2e qui clique (D342). | — |
| **D345** | **Le garde de couverture.**<br>• **Le relevé des clics.** Un script d'init (`context.addInitScript`), posé par une fixture commune à tous les e2e, écoute les clics en phase de capture. Il note le `data-node` le plus proche de chaque clic. À la fin de chaque test, la fixture ajoute ces ids à un fichier de relevé sous `$TMPDIR`.<br>• **L'inventaire.** L'explorateur en sort un : `e2e/audit/inventaire.json`, commité, avec les `data-node` des éléments interactifs, normalisés (les segments variables, comme un id de sujet, sont remplacés par `*`).<br>• **Le contrôle.** Après `gate:e2e`, `npm run couverture:ui` compare le relevé à l'inventaire. Un élément de l'inventaire qui n'a jamais été cliqué fait échouer la CI, sauf s'il figure dans `e2e/audit/non-couverts.json`, avec une raison.<br>• **Le cliquet.** La liste `non-couverts.json` part de l'état de l'audit, et elle ne peut que diminuer. Un élément nouveau ne peut pas y entrer sans une raison relue par la cell de gestion.<br>• **Un élément interactif sans `data-node`** compte comme non couvert. | Julien : « audit, puis garde ». |
| **D346** | **Le détecteur visuel.** La revue des captures du 56.7 trouve des défauts visuels sur 45 vues sur 68. L'explorateur ne les voit pas, parce qu'il ne regarde que le comportement. Un module `e2e/visuel.ts` les cherche dans le navigateur, sur la page affichée, à partir des styles calculés et des boîtes :<br>• **le style par défaut** : un `button`, un `input`, un `select`, un `textarea` ou une case à cocher dont le fond, la bordure ou la couleur du texte sont ceux du navigateur ; un lien dont la couleur est le bleu ou le violet par défaut ;<br>• **le contraste** : un texte visible dont le contraste avec son fond est sous 4,5:1 (3:1 pour un gros texte, ou un élément désactivé qui l'annonce) ;<br>• **le débordement** : un élément dont le contenu dépasse sa boîte (`scrollWidth > clientWidth + 1`) sans conteneur qui défile, ou qui sort de la fenêtre ;<br>• **le texte écrasé** : un libellé court qui passe sur plus de lignes que de mots, comme un mot écrit une lettre par ligne ou coupé en plein milieu ;<br>• **le chevauchement** : deux textes frères dont les boîtes se recouvrent.<br>Chaque trouvaille donne l'écran, le format, le sélecteur ou le `data-node`, la règle et les mesures. L'explorateur l'appelle sur chaque vue, et son rapport gagne une classe `visuel`. Une liste d'exceptions écrite dans le code, avec une raison par entrée, couvre par exemple la zone de xterm. | Cell de gestion, 16 novembre, après la revue des captures du 56.7. |

## 3. Les points

### 56.1 Le plan

Ce document.

### 56.2 L'explorateur (D343)

- L'outil `npm run audit:ui` et sa config. Le démarrage du daemon réutilise les aides de `e2e/` (`helpers.ts`, `host-helpers.ts`, `helpers-multi-mesh.ts`, `serve-local.ts`).
- **Tests :**
  - un test unitaire du classement, sur des relevés synthétiques ;
  - un essai de l'explorateur sur deux écrans, joué en CI pour qu'il ne pourrisse pas, sans faire échouer la CI sur ses trouvailles.
- _Révision 56.2._ Codex a été coupé par sa limite pendant l'audit complet, à 49 écrans sur 72. La cell de gestion l'a relancé seule, sur une machine libre : 59 min, 16 erreurs, 84 sans effet, 46 désactivés, 1 114 ok, 4 exclusions, aucun écran non chargé. Deux lignes existantes sont modifiées : la signature de `demarrerHost` et l'exclusion `**/audit/**` dans `playwright.config.ts`. Gate 4 164, gate:e2e 140, essai de l'audit 3 fois sur 3.

### 56.3 L'audit et son tri (D344)

La cell de gestion lance l'explorateur, regarde le rapport et les captures, puis montre la liste à Julien. Le plan reçoit la liste des points de correctif, de 56.4 à 56.n.

- _Révision 56.3._ Codex a fait le diagnostic sans toucher au dépôt. La cell de gestion l'a relu et a vérifié D08 et D14 elle-même. Sur 86 groupes : 14 défauts distincts, 26 refus attendus et dits à l'écran, 51 faux positifs de l'explorateur et 2 manques de l'environnement. Aucune action n'est impossible, et les refus de sécurité restent en place. Julien a vu la liste le 2026-11-16 et choisi de retirer le champ « Sujet » de l'essai PDA (D14).

| Défaut | Gravité | Ce que l'utilisateur voit | Point |
|---|---|---|---|
| D01 | gênant | Les boutons désactivés ont l'air actifs : aucun style commun pour `:disabled` et `[aria-disabled]` | 56.4 |
| D02 | gênant | Sur l'appareil, le lien de diff d'un fichier est proposé alors que la lecture du code est coupée (403 `code_coupe`) | 56.6 |
| D03 | gênant | Sur téléphone, le bouton fixe du menu recouvre « Envoyer une demande d'essai » et « Éteindre le mode host » | 56.5 |
| D04, D05 | cosmétique | Panneau PDA : « Sujet » et « PDA : confirmations hors du tailnet » collés à leur voisin | 56.5 |
| D06 | gênant | L'adresse du relais est figée sans dire qu'il faut couper le PDA | 56.4 |
| D07 | gênant | Serveurs, création et configuration : « Enregistrer » désactivé sans dire ce qui manque | 56.4 |
| D08 | gênant | Discussion d'un serveur sur téléphone : le panneau garde 360 px, et le bandeau s'écrit une lettre par ligne | 56.5 |
| D09 | cosmétique | Après la création d'une carte, « Exécutée » et « Parti. » ensemble | 56.6 |
| D10 | gênant | L'en-tête du Board dit « Lecture seule » alors que la création de carte écrit | 56.6 |
| D11 | gênant | Mémoire swarph : « Recharger » inerte avant « Lister », sans le dire | 56.4 |
| D12 | gênant | PDA, enregistrement : le nom est obligatoire sans que l'écran le dise | 56.4 |
| D13 | cosmétique | Des éléments interactifs sans `data-node` | 56.7 |
| D14 | gênant | Le champ « Sujet » de l'essai PDA est vérifié puis ignoré : il est retiré | 56.6 |

### 56.4 à 56.7 Les correctifs

Chacun respecte D342 : un e2e qui clique, le cas réel qui active le bouton, le cas d'erreur, et la revue des captures.
- _Révision 56.4._ Trois passes : le correctif, puis deux retouches de la cell de gestion après la revue des captures. La raison du PDA disparaît une fois le nom rempli, et la garde `!erreur` est rétablie dans Serveurs. Ensuite, les captures ne se prennent que sur demande, avec `AID_E2E_CAPTURES`. Gate 4 165, gate:e2e 143, e2e ciblés 7/7 trois fois ; après la seconde retouche, 9/9 deux fois, multi-mesh compris.

### 56.4 Les boutons désactivés (D01, D06, D07, D11, D12)

Un style commun pour `.bouton:disabled` et `[aria-disabled="true"]` : contraste plus faible, curseur `not-allowed`, et le primaire qui ne reste pas vert. Chaque bouton désactivé de D06, D07, D11 et D12 dit pourquoi, par un texte visible lié au champ ou au bouton (`aria-describedby`). Un `title` seul ne suffit pas sur téléphone. Les e2e montrent chaque bouton désactivé avec sa raison, puis actif dans le cas réel, puis cliqué, avec son effet.

### 56.5 Le téléphone et la mise en page (D03, D04, D05, D08)

Le bouton du menu ne recouvre plus aucune action, même après défilement. Le panneau PDA range ses libellés et ses champs. La discussion d'un serveur passe en une colonne sous 720 px. Les e2e cliquent les actions recouvertes en 390 × 844, après défilement.
- _Révision 56.5._ Une passe. 22 captures relues par la cell de gestion. Deux constats restent hors de ce point, pour l'audit final du 56.7 : sur téléphone, le tableau de l'Accueil déborde (la colonne Agent est coupée), et le champ du relais désactivé reste gris clair dans le thème sombre. Codex signale aussi la barre d'options du compositeur, tassée sur téléphone. Gate 4 165, gate:e2e 146, e2e du téléphone et de la mise en page 13/13 trois fois.

### 56.6 Les textes et les liens (D02, D09, D10, D14)

Sur l'appareil, la liste des fichiers dit que la lecture du code est coupée et ne propose pas le lien. La création de carte n'affiche qu'un statut final. L'en-tête du Board distingue la lecture et les écritures sous confirmation. Le champ « Sujet » de l'essai PDA est retiré de l'écran et de la route. Le Board ne demande plus les commits d'une carte non reliée.
- _Révision 56.6._ Deux passes. Dans la première, l'environnement d'audit remplissait encore le champ retiré. `audit-essai` dépassait son délai, et son daemon et son relais restaient en vie sur leurs ports, ce qui faisait échouer `board-aid` (EADDRINUSE) puis l'audit suivant (« relais injoignable »). La reprise corrige l'audit. Le nettoyage de l'audit quand il échoue est confié au 56.7. Gate 4 169, gate:e2e 147, specs touchées 29/29 trois fois. Le diff du daemon (livraison de l'appareil, route d'essai) part à la revue du lab avant la PR.

### 56.7 L'explorateur et les `data-node` (D13)

L'explorateur remplit les champs, accepte les confirmations dans un daemon jetable, remet les préférences entre deux écrans et ignore les 404 voulus. Chaque élément interactif reçoit un `data-node` stable. L'audit complet est relancé : la liste qui reste devient la liste de départ du garde.
- _Révision 56.7._ Trois passes de Codex. Les deux premières ont été coupées par la limite d'une heure du lanceur, pendant l'audit. La cell de gestion a lancé elle-même l'audit complet, qui dure 1,2 h.
  - Le nettoyage de l'audit arrête tout, même après un échec. Le daemon et le relais s'arrêtent en dernier, et les ports libres en sont la preuve. Le home temporaire est supprimé. Un PID n'est tué que s'il appartient au daemon de l'audit. Un e2e fait échouer la préparation exprès, puis vérifie que les ports et les dossiers sont libérés.
  - L'explorateur remplit les champs, choisit une autre option dans les select et quitte un filtre puis y revient. Il note « annulé » quand un dialogue est refusé. Il sépare « cible disparue » et « clic impossible » de « sans effet ». Il remet la fixture à neuf quand l'appareil ou le host est coupé. Il renouvelle l'essai PDA, que D210 fait expirer au redémarrage, et il ignore le 404 voulu des commits du Board.
  - 96 `data-node` sont ajoutés dans 22 fichiers d'écran, sans autre changement. La cell de gestion l'a vérifié en retirant les `data-node` des deux versions et en repassant Prettier.
  - L'audit, avant → après (68 vues au lieu de 72, car les routes inconnues sont vérifiées pendant la préparation) : erreur 16 → 13, sans effet 84 → 2, désactivé 46 → 34, refus 0, cible disparue 14, annulé 6, aucun écran non chargé.
    - Les 13 erreurs sont des 502 du serveur de test, qui n'a pas de transport distant.
    - Les 14 cibles disparues sont des appareils et des confirmations récentes, retirés par la remise à neuf.
    - Les 2 « sans effet » sont un select à une seule option.
  - `e2e/audit/inventaire.json` (321 identifiants) et `e2e/audit/non-couverts.json` (272 exceptions, chacune motivée) sont la liste de départ du 56.g.
  - La revue des 68 captures confirme les deux constats de la cell de gestion : le tableau de l'Accueil déborde sur téléphone, et le relais désactivé est trop pâle dans le thème sombre. Elle trouve aussi des défauts nouveaux sur 45 captures. Les plus visibles :
    - du texte écrit à la verticale et des libellés qui se chevauchent dans la barre de saisie d'une discussion, sur téléphone ;
    - les tableaux du board qui se chevauchent sur téléphone ;
    - des boutons et des champs sans style, blancs ou gris clair, sur le fond sombre ;
    - des liens bleus par défaut dans toute l'app de l'appareil ;
    - une zone de Machines sans mise en page ;
    - des badges et des boutons coupés en plein mot ;
    - des libellés techniques bruts.
    L'audit ne voit aucun de ces défauts, parce qu'il ne regarde que le comportement. Ils sont confiés au 56.8, et leur détection automatique au 56.g.
  - Résultats : gate 4 176, gate:e2e 149, `audit-essai` trois fois de suite en moins de deux minutes.

### 56.8 Le détecteur visuel, les éléments natifs et les débordements (D346)

- Le module `e2e/visuel.ts` de D346, et son branchement dans l'explorateur, avec la classe `visuel`.
- **Les éléments natifs sans style.** Un style de base commun, dans les trois apps (Mac, appareil, PDA), pour `button`, `input`, `select`, `textarea`, les cases à cocher et les liens, aux couleurs du thème, en clair comme en sombre. Écrans concernés : `/swarph` (« Écrire au mesh (à blanc) », la ligne de la demande d'avis, « Relire les demandes au mesh »), Boîte de réception (« Répondre (à blanc) »), carte du board (« Écrire une note (à blanc) »), `/swarph/federation` (le champ Requête), `/swarph/memoire` (la liste Filtre), le PDA (« Actualiser », le champ du numéro), Réglages et Machines (les cases), et tous les liens de l'app de l'appareil. Le champ du relais désactivé doit rester lisible dans le thème sombre.
- **Les débordements sur téléphone.**
  - La barre d'outils sous le champ de saisie d'une discussion : « claude · » s'écrit une lettre par ligne, et les libellés se chevauchent.
  - Les tableaux « Graphe d'étapes » et « Obligations » de la carte du board : les colonnes se chevauchent, et les mots sont coupés en plein milieu.
  - Le tableau de l'Accueil, dont la colonne Agent est coupée.
  - Le tableau « Combinaisons disponibles » de Machines.
  - « Reprendre » dans Serveurs.
  - Le badge « Injoignable » de la barre de gauche.
  - Un mot n'est jamais coupé en son milieu. Un tableau trop large défile dans son conteneur, ou passe en lignes empilées.
- **Le libellé collé** « peer-agéré par le proxy » de la barre de gauche.
- **Les tests (D342).** Pour chaque écran corrigé, un e2e l'affiche aux deux formats et appelle le détecteur : aucune trouvaille sur les éléments corrigés. Il clique aussi les boutons concernés. Un test unitaire du détecteur, sur des pages synthétiques : un bouton natif, un lien bleu, un texte pâle, un débordement, un mot écrit une lettre par ligne, un chevauchement, chacun détecté. Une page propre ne donne rien.
- _Révision 56.8._ Une passe de Codex, avec une limite de trois heures. Le détecteur est en place, essayé sur 15 cas synthétiques dans le vrai navigateur. Un socle `natifs.css` en `:where()` sert aux trois apps. Les tableaux défilent dans leur cadre, pour garder leurs colonnes. Sur la barre du compositeur, les règles de retour à la ligne ne s'appliquent que sous 720 px, pour que Remote garde sa place sur bureau. `e2e/visuel-ecrans.spec.ts` passe les 22 écrans aux deux formats et clique leurs boutons, avec le PDA réel. Sur les 44 vues de ces écrans, l'explorateur trouve 131 défauts `visuel` avant le correctif et 2 après. Les deux restants sont confiés au 56.9 : le chemin d'un projet et la clé publique, coupés sur téléphone. La cell de gestion a relu le diff et les captures aux deux formats. Gate 4 176, gate:e2e 168.

### 56.9 La mise en page de Machines, les textes bruts et les petits écarts

- **Machines** : le cadre « Appareils PDA » (marges, colonnes, « Révoquer » qui déborde), les dates ISO brutes, la liste des confirmations (dix « Paramètres signés » sans espacement), le cadre « Mac local · ici ».
- **Les textes bruts** : « (agents.transport: pty) » dans Livraison ; l'erreur shell brute dans la carte d'un serveur de la barre de gauche ; « active » non traduit ; les valeurs connues du board (`not-taken`, `withdrawn`, `requested`, `unstaffable`), affichées en français. Le texte libre venu du mesh reste tel quel, mais il passe proprement à la ligne.
- **Les petits écarts** :
  - le tableau de `/swarph/cells` : en-têtes, séparateurs, tiret pour une valeur vide ;
  - la taille des cases et le vide dans la configuration d'un serveur ;
  - l'alignement du bandeau « BLOQUÉ » ;
  - la largeur de la barre de gauche sur la page d'un sujet ;
  - la section « Contrôles » vide ;
  - « Bloqué : aucune PR ouverte. » centré ;
  - l'onglet actif des sous-onglets swarph.
  - sur téléphone, le chemin d'un projet dans Réglages et la clé publique du daemon dans Machines, qui se coupent en plein mot (les deux trouvailles laissées par le 56.8) ;
  - « Confirmer » et « Refuser » du PDA, de même style : l'action principale doit se distinguer.
- **Les tests (D342)**, comme au 56.8.
- _Révision 56.9._ Une passe de Codex, plus une retouche de la cell de gestion après la revue des captures. Codex traduisait aussi les noms d'étape du board (« idée », « avant construction »), alors que la colonne Étape, la chronologie et « Déplacer » les gardent tels quels. Seuls les états et statuts sont traduits, par `libellesBoard.ts`. Le `gate:e2e` complet a aussi trouvé deux régressions que les e2e ciblés de Codex ne voyaient pas, corrigées par la cell : la largeur de 240 px de la barre sur la page d'un sujet écrasait le rail réduit, et `cleanup.spec.ts` attendait encore « active ». Une valeur inconnue reste telle quelle. Le détecteur gagne deux règles étroites, chacune testée par un cas synthétique : un bloc `code` de pleine largeur peut couper une chaîne technique sans espace, et une ellipse ne compte plus comme un chevauchement, puisque le texte masqué ne recouvre rien. La carte d'un serveur dans la barre de gauche dit « Connexion impossible » et renvoie au diagnostic, au lieu de l'erreur shell. Sur les 22 vues des écrans corrigés, l'explorateur trouve 3 défauts `visuel` avant le correctif et 0 après. `e2e/visuel-56-9.spec.ts` passe le détecteur sur les pages entières. Gate 4 187, gate:e2e 174.

### 56.g Le garde (D345)

Il vient après les correctifs, pour que la liste de départ soit courte. Le garde de couverture de D345 s'y ajoute. Le détecteur visuel y est aussi branché dans la CI : `gate:e2e` échoue sur toute trouvaille hors exceptions, dans les écrans que les e2e affichent. Julien a dit oui le 16 novembre : « ok pour brancher le détecteur en CI ». Avant le branchement, un cas connu à traiter : sur le rail réduit de la barre de gauche, la pastille de compte posée sur le coin d'une case dépasse sa boîte de 4 px, ce qui est voulu, et le détecteur la signale comme un débordement.

- _Révision 56.g._ Deux passes de Codex. La première s'est arrêtée sur un trou dans la liste de départ : `serveur-config.annuler` n'était ni cliqué ni dans les exceptions. La cell a décidé un vrai e2e (modifier, Annuler, rien d'enregistré) plutôt qu'une exception.
  - **La fixture commune** `e2e/test.ts` : les 49 specs l'importent. Elle surcharge `browser.newContext`, pour couvrir aussi les contextes créés à la main. Elle relève chaque clic, avec l'id le plus proche et celui de l'élément interactif, puis appelle le détecteur sur chaque page de l'app avant sa fermeture. Une trouvaille fait échouer le test au teardown, une fois le daemon arrêté. `AID_VISUEL_RELEVE=1` passe en mode relevé seul, pour mesurer.
  - **`npm run couverture:ui`** tourne à la fin de `gate:e2e`. Il échoue sur un id jamais cliqué, sur une exception devenue cliquée (le cliquet), sur une exception sans raison et sur une exception absente de l'inventaire. Un test vitest le couvre sur des fichiers synthétiques.
  - **L'inventaire** gagne 5 ids, tous cliqués : les deux boutons des artefacts, la justification d'un avis mesh, et le champ et le bouton « Aller » du sélecteur de dossier. Les exceptions passent de 272 à 240, recalculées depuis le relevé réel.
  - **Le détecteur dans le gate** a trouvé 9 familles. 7 vrais défauts sont corrigés : « Demande close », le placeholder du relais, la commande d'inscription au mesh, l'avertissement d'index, le compositeur dans une colonne étroite (requête de conteneur), le nom d'artefact et « Aller ». 2 faux positifs sont réglés dans le détecteur : la coupure à un tiret, et le texte d'un `th` ou d'un `summary` composé. S'y ajoutent deux règles étroites : la pastille du rail, et le défilement natif d'un champ texte. Chaque règle a son cas synthétique, et le tableau des avis mesh défile dans son cadre.
  - **L'audit complet de contrôle** (1 h 12) ne trouve aucune trouvaille visuelle et aucun écran non chargé. En le comparant à l'inventaire, la cell a trouvé un trou plus ancien : l'inventaire du 56.7 avait omis trois écrans que son propre audit voyait (Nouveau sujet, le sujet hors compositeur et Livraison). Ces 98 ids sont ajoutés, normalisés comme les autres, et l'inventaire passe à 424. 19 sont déjà cliqués par un e2e. Les 79 autres entrent dans les exceptions avec cette raison, qui passent donc à 319. Les 5 ids ajoutés à la main ne sont pas vus par l'audit, parce qu'ils sont dans des états qu'il n'atteint pas, mais ils sont cliqués par les e2e.
  - Restent hors de ce point : le panneau Fichiers, très étroit en 1280 × 800, et les dates ISO brutes du tableau des avis mesh.
  - Gate 4 189, gate:e2e 182, avec le détecteur bloquant et la couverture verte.

## 4. Pièges

- **L'explorateur clique tout.** Il ne tourne que contre un daemon isolé, avec les faux de l'e2e. Jamais contre le daemon de Julien, jamais avec le vrai claude, codex, gh, tailscale ni swarph.
- **Les ports.** Ceux de l'e2e (4871 à 4873, 4891 à 4893), via `AID_E2E_PORT`. L'explorateur ne tourne pas en même temps qu'un `gate:e2e`.
- **Les captures de revue (D342, règle 4).** `AID_E2E_CAPTURES=<dossier>` active les captures avant un commit d’interface ; sans cette variable, le helper ne crée aucun dossier et ne modifie pas la taille de la page.
- **Le rapport et les captures** restent sous `$TMPDIR`. Les données sont synthétiques, mais rien n'est commité, sauf l'inventaire.
- **Aucun vrai nom** de cell, de dépôt ni d'hôte dans les fixtures (garde des noms neutres, 49 et 54).

## 5. Fini quand

- 56.2 à 56.g sont mergés, avec la CI verte et le oui de Julien.
- La liste `non-couverts.json` ne contient que des éléments justifiés.
