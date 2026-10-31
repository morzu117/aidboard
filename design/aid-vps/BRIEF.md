# AID — Brief d'intégration : refonte conversation, barre gauche, accueil

Public : l'intégrateur (humain ou agent). Les features et la logique métier sont rappelées à part dans le prompt ; ce document dit **ce que chaque écran, bloc, bouton et règle doit faire visuellement et en comportement**.

Date : 2026-10-26. Maquettes : canvas « AID — refonte conversation » (artboards `Main`, `Sidebar`, `Nav`, `HomeA`). Sources lisibles dans `sources/`.

## 0. Comment lire ce dossier

| Fichier | Rôle |
|---|---|
| `BRIEF.md` | Ce document : règles globales, tokens, composants, écrans, états. |
| `tokens.json` / `tokens.css` | Valeurs de design (couleurs, typo, rayons, espacements). Source de vérité des valeurs. |
| `sources/*.dc.html` | Maquettes. HTML + styles inline, lisibles telles quelles. Les `{{...}}` sont des trous de données, les `<sc-for>` des boucles, les `<sc-if>` des conditions. |
| `sources/canvas.json` | Position et taille de chaque artboard. |

Règle d'or : **ne pas copier le markup des maquettes** (styles inline, données factices). Recréer chaque élément avec les composants du dépôt, en lisant les valeurs dans les tokens. Les maquettes servent à lire la structure, les proportions et les états.

Légende utilisée plus bas :
- **Spécifié** : décidé avec le client, à implémenter.
- **Illustratif** : donnée ou libellé inventé pour la maquette. Le comportement réel vient du produit (voir le prompt de features).
- **À confirmer** : proposition de ma part, non validée.

## 1. Les trois changements demandés

1. **Conversation native** : le terminal embarqué dans une page web est remplacé par un vrai espace de conversation (comme les apps desktop agentiques). Disposition sur écran large : **1/4 barre gauche · 2/4 conversation · 1/4 panneau contextuel (onglets)**. Objectif : pas de scroll vertical de page, et plus de problèmes de resize, refresh ou reprise de session liés au terminal.
2. **Barre gauche réorganisable, présente partout**, avec les mêmes fonctions que la barre d'une boîte mail : vues avec compteurs, groupes colorés repliables, glisser-déposer, renommage, mode réduit.
3. **Nouvelle page d'accueil** : piste retenue = **A, « file de tri »**. Les pistes B (tableau par état) et C (reprendre + projets) sont écartées ; elles restent dans le canvas pour mémoire et ne sont pas à implémenter.

## 2. Règles globales (spécifiées)

### 2.1 Structure et scroll
- Structure verticale : barre du haut (56 px, fixe) + corps (hauteur restante). **La page elle-même ne défile jamais.** Chaque colonne gère son propre défilement interne.
- Écran Conversation à 1440 px : colonnes 360 / 720 / 360 px (25 % / 50 % / 25 %). Écran Accueil : barre gauche 280 px, contenu fluide.
- Dans la colonne centrale, **seul le fil de messages défile**. L'en-tête du sujet, les onglets d'agents et la zone de saisie restent visibles en permanence.
- Les largeurs en % doivent rester prioritaires sur les px des maquettes : le ratio 1/4–2/4–1/4 est la règle, les px ne sont que le rendu à 1440.
- Conception faite uniquement pour **≥ 1280 px**. Comportement en dessous : **à confirmer** (proposition : barre gauche en mode réduit sous 1280, panneau contextuel en tiroir sous 1024, colonne centrale minimum 560 px).

### 2.2 Persistance entre pages
La barre gauche est **le même composant sur toutes les pages** (Accueil, Boîte de réception, Consignes, Réglages, Conversation). Son état est conservé d'une page à l'autre : sujet sélectionné, groupes repliés, mode réduit, ordre et noms.

### 2.3 Langue et ton
Interface en français. Libellés courts, verbes d'action à l'infinitif sur les boutons (« Pousser », « Reprendre »). Temps relatifs (« il y a 18 min », « 10 j »).

### 2.4 Accessibilité
- Vrais éléments `button`, `a`, `input`, jamais de `div` cliquable.
- Tout bouton icône ou glyphe seul a un `aria-label` (étoile de marquage, ···, ‹, +, ↑).
- Focus clavier visible partout. Le fil de conversation est focalisable (voir 5.3).
- Contraste : texte courant ≥ 4,5:1. Le gris `muted` (#8d94a0) sur fond sombre passe ; ne pas l'assombrir. Ne jamais porter une information par la couleur seule (le statut est aussi donné par le libellé ou la position).
- Le glisser-déposer a **toujours une alternative clavier** : menu ··· → « Déplacer vers… ».

### 2.5 Identité visuelle
Thème sombre unique, accent vert menthe, code et identifiants en police mono. Valeurs dans `tokens.json`. Pas d'emoji dans l'interface ; les glyphes ★ ☆ ▾ ▸ ✓ ‹ › sont des caractères typographiques.

## 3. Tokens (résumé, voir `tokens.json`)

| Rôle | Valeur |
|---|---|
| Fond page | `#0b0c0e` |
| Fond panneau (barre gauche, panneau droit, cartes) | `#0e1013` |
| Surface (composer) | `#111317` |
| Surface 2 (boutons secondaires, chips) | `#16191e` |
| Surface 3 (bulle utilisateur, survol) | `#1a1e24` |
| Sélection (ligne active) | `#1f252d` |
| Bordure | `#23272e` ; forte `#2d323a` |
| Texte | `#e6e8eb` ; secondaire `#c4c9d2` ; discret `#8d94a0` ; très discret `#5b616c` |
| Accent (menthe) | `#5de0a1`, texte dessus `#06251a`, bordure douce `#2f5a47` |
| Ambre (à décider) | `#f2b84b`, texte dessus `#2a1d00`, bordure `#5a4514`, fond `#1a150a` |
| Bleu (en cours, branche main) | `#6ea8ff`, fond chip actif `#1a2740` / texte `#8fb8ff` |
| Violet (autres branches) | `#a78bfa` |
| Rose / Turquoise / Orange | `#f07ab0` / `#4fd1d9` / `#f59e6b` (couleurs de groupes) |
| Rouge (erreur) | `#f26d6d` (non utilisé dans les maquettes, prévu pour « Erreur ») |
| Police UI | Inter 400 / 500 / 600 |
| Police mono | JetBrains Mono 400 / 500 |
| Tailles | corps 14 · secondaire 13 · méta 12 · libellés capitales 11–12 (espacement 1–1,2 px) · titre sujet 24 · titre accueil 26 |
| Rayons | 6 (petits boutons, chips) · 8 (boutons, lignes) · 10–12 (cartes, menus) · 14 (bulles, composer) · 999 (pilules) |

## 4. Bibliothèque de composants

Chaque composant ci-dessous existe déjà dans les maquettes ; la colonne « Variantes / états » liste ce qu'il faut prévoir en plus du cas dessiné.

| Composant | Description | Variantes / états |
|---|---|---|
| **Button** | Bouton texte, hauteur ~34, rayon 8. | `primary` (fond menthe, texte `#06251a`, 600) · `secondary` (surface 2, bordure) · `ghost` (transparent, bordure, texte discret). États : hover, focus, disabled, loading. |
| **IconButton** | Carré 26–36 px, rayon 6–8. | Toujours `aria-label`. États comme Button. |
| **Chip / Pill** | Étiquette arrondie. | `status` (ex. « active » bleu), `mono` (branche, base : police mono, surface 2), `filter` (actif : fond surface 3 + bordure forte). |
| **Counter** | Pastille de compteur. | `neutral` (texte discret) · `urgent` (ambre, plein, texte `#2a1d00`, 600). |
| **StatusDot** | Pastille 8 px. | Une couleur par statut (voir 6.1). |
| **LabelSquare** | Carré 10 px arrondi 3, couleur du groupe. | 8 couleurs de palette de groupes. |
| **Tabs** | Onglets avec soulignement 2 px menthe sur l'actif. | Débordement : menu « … » (voir 5.3). |
| **Input / Textarea** | Champ sombre, bordure, rayon 6–14. | Focus : bordure menthe. Erreur : bordure rouge + message. |
| **Card** | Panneau `#0e1013`, bordure, rayon 12–14. | `warning` (ambre, voir DecisionCard). |
| **NavView** | Ligne de vue intelligente : pastille carrée, libellé, compteur, rayon pilule, hauteur 34. | actif (fond sélection, texte blanc, 600) · urgent (compteur ambre, libellé 600). |
| **NavGroup** | Ligne de groupe : chevron, carré couleur, nom, compteur, hauteur 32. | replié / déplié · édition (poignée + ···) · renommage (input). |
| **NavSubject** | Ligne de sujet, indentée 22 px, hauteur 34 : StatusDot, nom, badge, temps. | normal · sélectionné (fond sélection) · édition · renommage · glissé (ombre + bordure menthe). |
| **ContextMenu** | Menu flottant rayon 10, ombre portée. | Entrées : Renommer, Couleur (pastilles), Déplacer vers…, Épingler en haut, Masquer, Archiver (séparé, discret). |
| **Message (utilisateur)** | Bulle alignée à droite, rayon 14 14 4 14, max 80 %. | marquée (bordure ambre) · avec étoile. |
| **Message (agent)** | Étiquette agent (mono menthe) + heure, puis texte pleine largeur (max 92 %). | en cours de rédaction (curseur ou points). |
| **ToolCallGroup** | Carte mono : en-tête « N commandes » + bouton détail, une ligne par commande. | replié (condensé) · déplié (sortie complète par commande). Ligne : ✓ succès · spinner en cours · ✗ erreur (rouge). |
| **DecisionCard** | Carte ambre : puce, référence de décision, titre, actions. | en attente · résolue (grisée, issue affichée). |
| **MarkRail** | Rail vertical de traits, un par question. | trait normal (12 px) · marqué (18 px, ambre) · actif (26 px, menthe) · actif+marqué (menthe + liseré ambre). |
| **MarkMenu** | Liste déroulante des questions de la discussion. | ligne : étoile, texte tronqué, heure ; ligne active surlignée. |
| **Composer** | Zone de saisie : textarea, barre d'outils (mode, modèle, pièce jointe), bouton envoyer. | vide (envoyer désactivé) · saisie · agent occupé (voir 5.3). |
| **CommitRow** | Pastille (couleur de branche), message tronqué, auteur · date, hash mono. | normal · sélectionné · atténué (commit absent de ta branche). |
| **TableRow** | Ligne de table de sujets, hauteur 54. | normal · survol · sélectionné · décision en attente. |
| **EventRow** | Heure mono, nom d'événement mono, lieu. | — |

## 5. Écrans : ce que fait chaque élément

### 5.1 Barre du haut (partout)

| Élément | Attendu |
|---|---|
| Logo `›:AID` | Lien vers l'Accueil. |
| Accueil · Boîte de réception · Consignes · **Serveurs** · Réglages | Navigation principale (« Serveurs » ajouté, voir section 11). L'entrée courante est en texte blanc, les autres en discret. Boîte de réception : afficher le nombre d'éléments en attente quand > 0 (à confirmer ; la barre gauche porte déjà « À décider »). |
| Pilule « hors mesh depuis N h » | État du mesh : durée depuis la dernière connexion. Absente quand le mesh est en ligne. Info seule, non cliquable en v1. |
| « daemon local » + point | Point vert : daemon joignable. Gris ou rouge : injoignable. Info seule. |
| Recherche `⌘K` | Ouvre la palette « Rechercher ou lancer une action » (sujets, actions, commandes). Le raccourci `⌘K` / `Ctrl+K` est global. |
| Bouton « Nouveau sujet » | Ouvre le flux de création de sujet. **Point d'entrée dupliqué** avec la barre gauche : ne garder visuellement que celui de la barre gauche (recommandation, à confirmer). |

### 5.2 Barre gauche (composant `Nav`)

Largeur : 360 px dans l'écran Conversation (1/4), 280 px ailleurs. Colonnes verticales : bouton, zone défilante, pied.

| Élément | Attendu |
|---|---|
| **Nouveau sujet** (bouton principal en haut) | Ouvre le flux de création (projet, branche, agent, mode standard ou swairm). |
| **Vues** : Tous les sujets · À décider · Agent libre · Sans agent · Épinglés · Archivés | Clic : ouvre l'Accueil filtré sur cette vue et la met en surbrillance. Compteurs : *Tous* = sujets ouverts ; *À décider* = décisions qui attendent l'utilisateur (compteur ambre, libellé en gras quand > 0) ; *Agent libre* = sujets avec un agent libre ; *Sans agent* = sujets sans agent ; *Épinglés* = sujets épinglés ; *Archivés* : pas de compteur. |
| **Serveurs** (section, sous les vues) | Titre « SERVEURS » : clic ouvre l'écran Serveurs (11.1). Bouton **+** : ouvre l'ajout d'un serveur (11.2). Une ligne par serveur : icône serveur (trait vert = connecté, gris = injoignable, ambre = reconnexion), nom affiché, latence. Clic : ouvre la discussion du serveur (11.3). Section toujours visible, même sans serveur (texte « Aucun serveur » + bouton +). |
| **Groupes** (titre) | Libellé fixe. |
| Bouton **Modifier / Terminer** | Bascule le mode édition (poignées, menus ···). Devient menthe pleine « Terminer » en édition. |
| Bouton **+** (nouveau groupe) | Crée un groupe vide en renommage immédiat (champ actif, placeholder « Nom du groupe »). |
| **Groupe** : chevron, carré de couleur, nom, compteur | Clic sur la ligne : replie ou déplie. L'état replié est persisté. Le compteur = nombre de sujets du groupe. |
| **Sujet** : point, nom, badge « 1 », temps | Clic : ouvre la conversation du sujet. Point = statut (6.1). Badge ambre = nombre de décisions en attente sur ce sujet. Temps = dernière activité. Nom tronqué avec ellipse ; le nom complet est en `title`. Le nom de branche réel reste accessible au survol. |
| **Pied** : point + « daemon local · mesh hors ligne », bouton `‹` | Statut synthétique. `‹` réduit la barre en rail (5.2.3). |

#### 5.2.1 Mode édition (spécifié)
- **Poignée** (⋮⋮) à gauche de chaque groupe et sujet : glisser pour réordonner.
- **Menu ···** à droite de chaque ligne : Renommer · Couleur (groupes) · Déplacer vers… · Épingler en haut · Masquer de la barre · Archiver.
- **Glisser-déposer** : un sujet peut changer de groupe ; un groupe peut changer de rang. Pendant le glissé, la ligne est surélevée (ombre, bordure menthe) et un **repère de dépôt** (trait menthe 2 px avec une pastille au début) indique la destination. Déposer hors zone annule.
- **Renommer** : double-clic sur un nom (ou menu). Champ de saisie à bordure menthe. `Entrée` valide, `Échap` annule. Pour un sujet, afficher sous le champ « branche inchangée : <nom de branche> ».
- **Nouveau groupe** : bouton pointillé « + Nouveau groupe » en fin de liste en mode édition (maquette Sidebar).

#### 5.2.2 Règles de données (à implémenter)
- **Renommer ne change que le nom affiché.** Jamais la branche Git, ni l'identité du sujet.
- **Groupement par défaut** : un groupe par projet, avec les sujets du projet. Un nouveau projet apparaît automatiquement en bas. L'utilisateur peut ensuite créer ses propres groupes et y déplacer des sujets ; le projet d'origine reste une propriété du sujet.
- Modèle suggéré : `group {id, name, color, order, collapsed, hidden}` et `placement {subjectId, groupId, order, pinned, archived, displayName?}`.
- Persistance : réglages utilisateur côté application (**pas** dans le dépôt Git). Écrire à chaque changement, relire au chargement de chaque page.
- Épingler : le sujet remonte dans la vue « Épinglés » (et reste dans son groupe). Masquer : disparaît de la barre mais reste dans « Tous les sujets ». Archiver : sort de « Tous » et va dans « Archivés ».

#### 5.2.3 Mode réduit (rail) — maquette dessinée, non interactive
Largeur 72 px. De haut en bas : bouton `+` (nouveau sujet), les trois vues principales sous forme de carrés colorés avec compteur (badge ambre sur « À décider »), séparateur, un carré coloré avec 2 lettres par groupe, bouton `›` en bas pour redéployer. Au survol : infobulle avec le nom. Les badges restent visibles. Clic sur un carré de groupe : popover listant ses sujets (**à confirmer**). L'état est persisté.

### 5.3 Conversation

#### En-tête du sujet
| Élément | Attendu |
|---|---|
| Fil `projet / sujet` | Rappel du projet ; clic sur le projet : Accueil filtré sur ce projet. |
| Titre (24 px) | Nom affiché du sujet. Renommable en ligne comme dans la barre gauche. |
| Chips `active`, `branche`, `base origin/main` | Statut du sujet, branche courante, base de comparaison (mono). Le chemin du worktree, présent dans l'ancienne interface, doit rester accessible (copie via le menu ···). |
| **Ouvrir dans l'éditeur** | Ouvre le worktree du sujet dans l'éditeur configuré. |
| **···** | Menu du sujet : Renommer, Épingler, Archiver, Copier le chemin du worktree (liste **à confirmer**). |

#### Onglets d'agents
Une entrée par agent du sujet (swairm-cell, claude, codex, cursor…) avec son état (« libre », « au travail », « arrêté »). Entrée active : soulignement menthe. **+ Agent** : ajoute un agent au sujet (choix du type). À droite : **Repères ▾** (5.3.2), **Tout déplier / Tout replier** (5.3.1) et **Arrêter** (arrête la session de l'agent actif ; demander confirmation).

#### 5.3.1 Fil de messages (affichage condensé + détail)
- Un **tour** = question de l'utilisateur, réponse de l'agent (intro, groupe de commandes, texte de conclusion), éventuellement une carte de décision.
- **Affichage par défaut : condensé.** Le groupe de commandes montre une ligne par commande (statut ✓ / spinner / ✗, commande en mono, résultat court à droite).
- **Détail dépliable** : le bouton « Voir le détail » du groupe affiche, sous chaque ligne, la sortie complète de la commande (bloc mono, retours à la ligne conservés). **Recommandation** : hauteur maximale ~240 px avec défilement interne. Le bouton devient « Replier le détail ».
- **Tout déplier / Tout replier** : agit sur tous les tours.
- **Étoile** à gauche de chaque question : marque ou démarque la question (voir 5.3.2). Question marquée : bordure ambre, étoile pleine ambre.
- **Pendant qu'un agent travaille** : le tour courant se met à jour en place. Défilement automatique vers le bas **uniquement si l'utilisateur est déjà en bas** ; sinon afficher une pilule « Nouveau message ↓ » (à confirmer).
- **Carte de décision** (ambre) : référence `projet#decision/N`, titre, boutons. Premier bouton = action principale (menthe). **Les libellés des boutons des maquettes (« Relancer le plan », « Réviser le plan », « Laisser garé ») sont illustratifs** : afficher les options réelles de la décision. Une fois résolue : carte grisée, issue affichée, boutons retirés.

#### 5.3.2 Repères de discussion (spécifié)
But : revenir à une question précédente sans scroller.
- **Rail de repères** (30 px, à droite du fil) : un trait par question, répartis verticalement. Clic : défile jusqu'à la question. Infobulle = texte de la question.
- **Indicateur de position** : le trait de la question actuellement en haut du fil est vert et allongé (26 px). Il suit le défilement. Calcul : la dernière question dont le haut est au-dessus de `scrollTop + 40 px`.
- Un trait **marqué** est ambre et plus long (18 px). Actif et marqué : vert avec liseré ambre.
- Bouton **Repères · N/M ▾** : ouvre la liste de toutes les questions (étoile, texte tronqué, heure), ligne active surlignée. Clic : défile jusqu'à la question et ferme le menu.
- Les marques sont **enregistrées avec la conversation** (par sujet).
- **Raccourcis**, actifs quand le fil a le focus : `j` question suivante · `k` question précédente · `m` marquer ou démarquer la question courante · `e` déplier ou replier le détail de la question courante. Pas de raccourci global ; ils ne doivent pas se déclencher dans la zone de saisie. Le rappel est affiché en bas du menu Repères.
- Défilement vers une question : `scrollTo` avec `behavior: smooth` (respecter `prefers-reduced-motion`), décalage de 16 px sous le haut.

#### Zone de saisie (Composer)
| Élément | Attendu |
|---|---|
| Textarea | 2 lignes minimum, grandit jusqu'à ~8 lignes puis défile. Placeholder « Écris à <agent>… (/ commandes · @ fichier) ». `Entrée` envoie, `Maj+Entrée` retour à la ligne (**à confirmer**). `/` ouvre les commandes, `@` ouvre la sélection de fichier. |
| Chip **mode** (« auto mode ») | Sélecteur du mode d'exécution de l'agent. Valeurs réelles fournies par le produit. |
| Chip **modèle** (« Sonnet 5.5 · high ») | Sélecteur de modèle et niveau d'effort. |
| Bouton trombone | Joindre un fichier ou une image. |
| Bouton **↑** (envoyer) | Désactivé tant que le champ est vide. Quand l'agent est occupé : le message est mis en file ou le bouton devient « Arrêter » (**à confirmer**). |
| Position | Toujours visible, sous le fil, hors zone de défilement. |

#### 5.3.3 Panneau contextuel (colonne de droite, 1/4)
Onglets dans la maquette : **Plan · Git · Fichiers · Revue · Rétro**. L'ancienne interface avait aussi **Passation dev** : **à ajouter** (six onglets ; au-delà de la largeur, déborder dans un menu « … »). Contenu de chaque onglet défile en interne.

| Onglet | Attendu |
|---|---|
| **Plan** | Affiche le plan du sujet. Vide : « Plan pas encore écrit » + bouton « Demander un plan à l'agent ». |
| **Git** | Ligne d'état (pilule « À jour avec origin » ou en avance / en retard), boutons **Synchroniser** (secondaire) et **Pousser** (menthe, actif seulement s'il y a des commits à pousser). Filtres : *Toutes · Sujet et main · Sujet seul*. Liste de commits : pastille (bleu = main, violet = autres branches, vert = ta branche), message (ellipse), `auteur · date`, hash mono. Clic sur un commit : détail à la place de la liste, avec retour. **À conserver de l'ancienne interface** (raccourcie dans la maquette) : champ de recherche (message, auteur, hash), bouton « Voir la base », bouton « Fetch », commits atténués quand ils sont absents de la branche, légende des couleurs. |
| **Fichiers** | Arborescence du worktree. Si l'index est absent : mention « Index absent : lecture directe du worktree ». Contenu de la maquette illustratif. |
| **Revue**, **Rétro**, **Passation dev** | Documents de mémoire du sujet. Vide : « Pas encore écrite ». |

### 5.4 Accueil (piste A, « file de tri »)

Barre gauche 280 px à gauche. Contenu : colonne principale fluide + **fil d'activité 280 px**.

| Élément | Attendu |
|---|---|
| Date + titre « 1 chose attend ta réponse » | Titre dynamique : « N chose(s) attend(ent) ta réponse » ou « Rien n'attend ta réponse ». |
| **Bandeau de décision** (ambre) | Une carte par décision en attente (empilées, 3 maximum puis lien vers la Boîte de réception). Contenu : titre de la décision, projet · branche · référence · âge. Actions : primaire (menthe, **libellé illustratif**) et « Ouvrir le sujet ». |
| **Table « Tous les sujets » + compteur** | Reflète la vue choisie dans la barre gauche. |
| Champ « Filtrer les sujets… » | Filtre texte instantané sur nom, projet, étape. |
| Menu « Tri : activité récente ▾ » | Tri par activité récente (défaut), nom, projet. Les sujets à décider restent en tête quelle que soit la sélection (**à confirmer**). |
| **Colonnes** | *Sujet* (point de statut, nom affiché, étape en mono) · *Projet* · *Agent* (nom · état) · *Activité* (temps relatif, aligné à droite) · *Action*. |
| Ligne entière | Clic : ouvre la conversation du sujet. |
| **Bouton d'action de ligne** | « Trancher » (menthe) quand une décision attend ; « Reprendre » quand un agent existe ; « Lancer » quand il n'y a aucun agent (lance un agent puis ouvre la conversation). |
| **Fil « Activité récente »** | Derniers événements du journal : heure (mono), nom d'événement (mono), agent · projet. Clic : ouvre le sujet. **Recommandation** : masquer les événements purement techniques (`lease_acquired`, `lease_released`) et garder ceux qui ont un sens pour l'utilisateur (`decision_opened`, `branch_pushed`, changements d'état). Contenu de la maquette = extrait réel du journal. |
| **Carte d'état** (daemon / mesh) | Rappel de l'état du daemon et du mesh. |
| **Colonne « Index »** | Retirée de la table pour faire de la place. L'état d'index (à jour / indisponible) doit rester consultable (indicateur discret sous le nom du sujet ou infobulle) : **à confirmer**. |
| États vides | Aucun sujet : message + bouton « Nouveau sujet ». Filtre sans résultat : « Aucun sujet ne correspond ». |

## 6. États et correspondances

### 6.1 Statut d'un sujet (point de couleur)
L'ancienne interface définit cinq états ; la couleur du point doit les refléter.

| État | Couleur | Libellé |
|---|---|---|
| Attend une réponse | ambre `#f2b84b` | « À décider » |
| Erreur | rouge `#f26d6d` | « Erreur » |
| À relire | turquoise `#4fd1d9` | « À relire » |
| En cours | bleu `#6ea8ff` | « En cours » |
| En pause / arrêté | gris `#5b616c` | « En pause » |

**Attention** : dans les maquettes les points menthe et bleu des sujets (ex. `feat/restart-dev` en menthe) sont **illustratifs**. Le sujet sélectionné se signale par le **fond de ligne**, pas par la couleur du point.

### 6.2 État d'un agent
« libre », « au travail », « arrêté », « aucun agent ». Affiché en texte (Accueil, onglets d'agents) ; ne pas le coder uniquement par une couleur.

### 6.3 Index de code
« à jour » / « indisponible » (visible dans l'ancienne interface). Voir la remarque sur l'Accueil.

## 7. Ce qui est illustratif dans les maquettes

Ne pas recopier : les trois échanges du fil (questions, réponses, sorties de commandes), les boutons de la carte de décision, les noms de groupes de la maquette Sidebar (« Produit », « Orchestration », « Pagination des formats », « Redémarrage dev », « Lieutenants »), l'arborescence de l'onglet Fichiers, les points menthe/bleu des sujets, les temps relatifs. Sont réels : les noms de projets, de branches et d'étapes (`feat/restart-dev`, `swairm-cli-interact`…), la décision `morzu117/Orgasso#decision/1`, les hashes et messages de commits du panneau Git, les événements du journal.

## 8. Hors périmètre

- Accueils B et C.
- Boîte de réception, Consignes, Réglages : seule la barre gauche (et l'entrée « Serveurs » du haut) y est reprise ; leurs contenus ne sont pas redessinés ici.
- Responsive en dessous de 1280 px et mobile.
- Thème clair.

## 9. Questions ouvertes

1. Un seul « Nouveau sujet » (barre gauche) ou aussi dans la barre du haut ?
2. Où afficher l'état d'index maintenant que la colonne est retirée ?
3. Passation dev : sixième onglet ou menu « … » ?
4. Comportement du composer quand l'agent est occupé : file d'attente ou arrêt ?
5. Clic sur un groupe du rail réduit : popover de sujets ?
6. Responsive sous 1280 px : proposition en 2.1 à valider.

## 10. Correspondance fichiers (voir aussi 11)

| Artboard | Fichier | Contenu |
|---|---|---|
| Conversation | `sources/Main.dc.html` | Écran complet, interactif (onglets du panneau droit, détail, marques, repères, raccourcis). |
| Barre gauche (3 états) | `sources/Sidebar.dc.html` | Lecture, édition avec menu contextuel, rail réduit, liste des fonctions. |
| Composant barre gauche | `sources/Nav.dc.html` | Composant partagé (props `active`, `edit`) ; repli de groupe et mode édition interactifs. |
| Accueil retenu | `sources/HomeA.dc.html` | Piste A. |
| Pour mémoire | `sources/HomeB.dc.html`, `HomeC.dc.html` | Écartées. |
| Serveurs : liste | `sources/Servers.dc.html` | Section 11.1. |
| Serveurs : configuration | `sources/ServerConfig.dc.html` | Section 11.2. |
| Serveurs : discussion | `sources/ServerChat.dc.html` | Section 11.3, interactif (détail, étoiles, rail). |

## 11. Serveurs distants (VPS)

Nouveau périmètre : piloter des agents sur une ou plusieurs machines distantes (aujourd'hui un VPS OVH, demain peut-être plusieurs) depuis AID. Trois écrans : liste, configuration, discussion. Artboards : `Servers`, `ServerConfig`, `ServerChat`.

### 11.0 Principe de connexion (spécifié)
- L'utilisateur se connecte aujourd'hui avec une **commande définie dans son bash, nommée `vps`**. AID doit donc pouvoir enregistrer un serveur par **commande locale** : le daemon local exécute la commande sur la machine de l'utilisateur ; elle ouvre un shell distant.
- Trois modes de connexion dans la configuration : **Commande locale** (retenu, valeur `vps`), **Hôte SSH** (hôte, port, utilisateur, chemin de clé, saut éventuel) et **Alias SSH** (nom d'un hôte du fichier SSH de l'utilisateur). Seul le premier est dessiné ; les deux autres suivent le même cadre.
- **Point d'attention** : une fonction ou un alias défini dans le profil bash n'existe pas dans un shell non interactif. D'où la case « Charger mon profil shell avant de lancer la commande » (activée par défaut) : le daemon doit lancer la commande via un shell qui charge le profil.
- AID **ne stocke ni mot de passe ni clé privée.** Tout passe par le daemon local ; l'application web ne parle jamais directement au serveur.
- Un serveur n'a de sens que si le daemon local tourne. Si le daemon est hors ligne, l'état du serveur est « injoignable » avec la cause (« daemon local hors ligne »).

### 11.1 Écran Serveurs (liste)
| Élément | Attendu |
|---|---|
| Titre, sous-titre, bouton **Ajouter un serveur** (menthe) | Ouvre l'écran de configuration en mode création. |
| **Carte serveur** | Icône, nom affiché, pastille d'état (**Connecté / Connexion… / Injoignable / Erreur**), mode et valeur de connexion en mono. Boutons : **Configurer** (ouvre 11.2), **Ouvrir la discussion** (ouvre 11.3, menthe), **···** (Tester la connexion, Reconnecter, Supprimer). Une carte par serveur, empilées. |
| 4 indicateurs de la carte | **Latence** (mesurée à l'ouverture et rafraîchie périodiquement) · **Agents détectés** (liste) · **Répertoire de travail** · **Session persistante** (Active / Inactive). Valeurs de la maquette illustratives. |
| **Discussions sur <serveur>** | Table des discussions rattachées à ce serveur : nom, agent · état, activité, bouton **Reprendre**. Clic sur la ligne : ouvre la discussion. |
| **Carte pointillée « Ajouter un autre serveur »** | Même action que le bouton du haut. Reste visible tant qu'il y a moins de N serveurs (pas de limite fixée). |
| État vide (aucun serveur) | Une seule carte pointillée centrée avec explication et bouton **Ajouter un serveur**. |

### 11.2 Écran Configuration d'un serveur
En-tête fixe : fil `Serveurs / <nom>`, titre, **Annuler** (retour sans enregistrer, confirmation si modifié) et **Enregistrer** (menthe ; désactivé tant que rien n'a changé ou si un champ est invalide). Le corps défile seul. Deux colonnes : formulaire (fluide) et colonne de test (340 px).

| Bloc | Champs et comportement |
|---|---|
| **Identité** | *Nom affiché* (obligatoire, unique) · *Groupe dans la barre gauche* (par défaut « Serveurs ») · *Couleur* (palette de groupes). |
| **Connexion** | Sélecteur segmenté de mode (boutons `aria-pressed`). Mode Commande locale : champ mono *Commande de connexion* (obligatoire), texte d'aide, case *Charger mon profil shell…* (cochée par défaut). Changer le mode remplace les champs ; les valeurs saisies sont conservées en mémoire pour le retour. |
| **Environnement distant** | *Répertoire de travail* (défaut `~`) · *Shell distant* (défaut `bash`) · case *Garder la session vivante sur le serveur* (cochée par défaut, voir ci-dessous) · liste **Agents sur le serveur** : une ligne par agent connu (claude, codex, cursor) avec ✓ « détecté » ou – « non détecté ». La détection est faite par le test de connexion. |
| **Permissions** | *Mode d'exécution par défaut* (valeurs réelles fournies par le produit) · case *Toujours confirmer les commandes sudo et destructives* (cochée par défaut ; **s'applique même en mode automatique**) · **Dossiers autorisés** (tags mono, `+ Ajouter`). |
| **Supprimer ce serveur** | Zone séparée, bouton rouge contour. Demande confirmation. Retire le serveur d'AID uniquement ; ne touche pas aux fichiers distants ni aux discussions déjà enregistrées (elles passent en lecture seule, **à confirmer**). |
| **Test de connexion** (colonne droite) | Bouton **Tester**. Étapes séquentielles, chacune avec ✓ / spinner / ✗ : commande trouvée · shell distant ouvert (durée) · répertoire de travail accessible · agents détectés · session persistante disponible. Conclusion en bas : « Connecté » (vert) ou le message d'erreur de l'étape en échec, avec la sortie brute dépliable. Le test est lancé automatiquement à l'enregistrement. |
| **Aperçu dans la barre gauche** | Reflète en direct le nom, la couleur et l'icône. Texte rappelant les états de l'icône. |

**Session persistante (spécifié)** : la discussion et les commandes en cours doivent survivre à une coupure réseau, un refresh et la fermeture de l'application, et reprendre à la reconnexion. Cela suppose que l'agent et son shell tournent **côté serveur dans une session détachable** (type multiplexeur de terminal). Si la case est décochée, une coupure termine la session.

### 11.3 Écran Discussion sur un serveur
Même composition que la conversation du sujet (section 5.3) **sans panneau de droite** : barre gauche (360 px) + colonne de discussion pleine largeur restante. Le contenu du fil et le composer sont centrés dans une colonne de **820 px maximum** pour garder une longueur de ligne lisible.

Différences avec la conversation d'un sujet :
| Élément | Attendu |
|---|---|
| Fil | `Serveurs / <nom>` + nom de la discussion. |
| Bouton **Configurer** | Ouvre 11.2. |
| Bouton **Panneau** | Affiche ou masque le panneau latéral de droite (360 px, voir 11.3.1). Quand il est ouvert, la disposition est identique à celle de la conversation d'un sujet (1/4 · 2/4 · 1/4). Dans la maquette il est ouvert par défaut ; l'état ouvert ou fermé est mémorisé par serveur. |
| Chips d'en-tête | **Connecté · latence** (vert ; ambre « Reconnexion… » ; gris « Injoignable »), nom du serveur (mono), répertoire courant (mono), « session persistante ». |
| Onglets d'agents | Mêmes règles qu'en 5.3 ; seuls les agents détectés sur ce serveur sont proposés par **+ Agent**. |
| Étiquette d'un tour | Chaque message d'agent affiche deux étiquettes mono : l'agent (menthe) et le serveur. |
| Groupe de commandes | Libellé « N commandes sur <serveur> » ; condensé et détail dépliable comme en 5.3.1. |
| **Ligne de reprise** | Séparateur centré avec pastille ambre : « Connexion perdue à HH:MM · reprise après N s · session retrouvée ». Affichée à chaque coupure suivie d'une reprise. Si la reprise échoue : « Session introuvable sur le serveur », avec bouton **Reconnecter**. |
| **Carte de confirmation** (ambre) | Pour toute commande soumise à confirmation : titre « Confirmation requise · <serveur> », commande exacte en mono, boutons **Autoriser** (menthe), **Refuser**, **Toujours autoriser sur ce serveur** (discret ; enregistre la règle dans les permissions du serveur et reste révocable depuis 11.2). Même composant que la carte de décision (DecisionCard). |
| Composer | Placeholder « Écris à <agent> sur <serveur>… ». Sélecteur de mode initialisé avec le mode par défaut du serveur. `@` désigne un fichier **distant**. |
| Repères, étoiles, raccourcis | Identiques à 5.3.2 (rail, menu Repères, `j` `k` `m` `e`). |
| Serveur injoignable | Bandeau ambre ou rouge au-dessus du composer, composer désactivé, bouton **Reconnecter**. Non dessiné ; à décliner avec les mêmes composants. |

#### 11.3.1 Panneau Fichiers / Git du serveur (spécifié)
**Faisabilité** : possible sans accès supplémentaire. Le daemon dispose déjà d'un shell sur le serveur ; l'explorateur et l'arbre Git sont obtenus par des commandes exécutées sur ce shell (lister un dossier, `git status`, `git log`). Conditions : `git` installé sur le serveur pour l'onglet Git ; chaque ouverture de dossier coûte un aller-retour réseau.

Structure : en-tête avec onglets **Fichiers** et **Git** et bouton ×, puis une barre de chemin `serveur:dossier` (mono) avec « il y a N s » (âge des données) et **↻ Actualiser**. Le contenu défile seul.

| Onglet | Attendu |
|---|---|
| **Fichiers** | Arborescence du dossier de travail. Dossiers repliés par défaut, **chargés au dépliage** (jamais tout l'arbre d'un coup). Une ligne : chevron ▸ / ▾ pour un dossier, · pour un fichier, nom en mono, badge d'état Git à droite (`M` modifié en ambre, `?` non suivi en turquoise). Clic sur un fichier : **aperçu en lecture seule** (texte tronqué à une taille maximale, binaires non affichés). Les dossiers lourds (`node_modules`, `.git`) sont grisés et ne se déplient pas par défaut. Les fichiers sensibles (`.env`, clés) sont **masqués** et signalés par « masqué » ; leur contenu n'est jamais lu pour l'aperçu. Pied de panneau : légende des badges. |
| **Git** | Mêmes composants que 5.3.3. Ligne d'état : branche (mono), nombre de fichiers modifiés, position par rapport à `origin`. Boutons **Synchroniser**, **Pousser** (menthe, actif seulement s'il y a des commits à pousser) et **Fetch**. Filtres *Toutes · Branche seule*. Liste de commits (pastille bleue = branche principale, violette = autres, message tronqué, `auteur · date`, hash mono). Clic sur un commit : détail avec retour. **Pousser** et **Synchroniser** passent par la carte de confirmation (11.3) puisqu'ils modifient le dépôt distant. |
| **Dossier non Git** | L'onglet Git affiche « Ce dossier n'est pas un dépôt Git » et propose de choisir un dépôt parmi ceux détectés dans les dossiers autorisés. |
| **Actualisation** | À l'ouverture du panneau, au retour de la connexion, après chaque commande exécutée par l'agent, et sur demande (↻). Pas de rafraîchissement continu. |
| **Serveur injoignable** | Le panneau garde les dernières données avec « il y a N min » en ambre et désactive ↻, Pousser, Synchroniser. |
| **Périmètre** | Lecture seule dans la v1 : pas d'édition ni de suppression de fichiers depuis le panneau. Les modifications passent par l'agent. Le panneau ne lit que les **dossiers autorisés** de la configuration (11.2). |

### 11.4 Composants ajoutés
| Composant | Description | Variantes / états |
|---|---|---|
| **ServerIcon** | Deux rectangles empilés avec deux points, trait de 2 px. | couleur du trait = état (vert, gris, ambre). |
| **NavServer** | Ligne de serveur dans la barre gauche, même gabarit que NavSubject : icône, nom, latence. | sélectionné · injoignable · reconnexion. |
| **ServerCard** | Carte large : en-tête (icône 44 px, nom, état, mode de connexion), actions, grille de 4 indicateurs. | par état de connexion. |
| **StatusPill** | Pilule à contour : point + libellé. | Connecté (vert) · Reconnexion (ambre) · Injoignable (gris) · Erreur (rouge). |
| **SegmentedControl** | Boutons groupés dans un fond surface ; actif = fond sélection. | `aria-pressed` sur chaque bouton. |
| **FormField** | Libellé 12 px discret au-dessus d'un champ ; aide en 12–13 px sous le champ. | focus (bordure menthe) · erreur (bordure rouge + message). |
| **Checkbox** | Case native, teinte menthe, libellé et aide dessous. | — |
| **TestSteps** | Liste de contrôles ✓ / spinner / ✗ avec durée à droite. | en cours · réussi · échec avec détail. |
| **SystemLine** | Séparateur horizontal avec pastille et texte centré. | reprise (ambre) · échec de reprise (rouge). |
| **FileTreeRow** | Ligne d'arborescence, hauteur 30, indentation 20 px par niveau : chevron, nom mono, badge d'état à droite. | dossier replié / déplié · sélectionné · grisé · masqué. |
| **ConfirmCard** | Variante de DecisionCard avec bloc de commande mono. | en attente · autorisée · refusée. |

### 11.5 Données illustratives de cette section
Latence « 12 ms », « 412 ms », agents « claude · codex », répertoire `~`, dossiers `~` et `/srv`, discussions « maintenance-nginx » et « mise-a-jour-systeme », tout le contenu du fil (502, nginx, backend, journal, commandes, heures). Seuls sont réels : le nom `vps-ovh` (nom d'affichage proposé) et la commande de connexion `vps`.

### 11.6 Questions ouvertes (serveurs)
1. ~~Panneau Fichiers / Git du serveur~~ : décidé, voir 11.3.1. Reste à confirmer : taille maximale de l'aperçu de fichier, et liste des dossiers masqués par défaut.
2. L'agent tourne-t-il sur le serveur (installé là-bas) ou sur la machine locale avec des commandes envoyées au serveur ? Le brief suppose la première option (agents détectés sur le serveur).
3. Une discussion de serveur apparaît-elle aussi sur l'Accueil ? Proposition : oui, dans la table, avec une colonne ou une étiquette « Serveur ».
4. Les discussions d'un serveur supprimé : lecture seule ou suppression ?
5. Quel mode de connexion supplémentaire est utile dès la v1 (Hôte SSH, Alias SSH) ?
