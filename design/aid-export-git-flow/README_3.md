# AID · page Sujet (version actuelle) · références d’implémentation (écrans 3.1 à 3.6)

Six fichiers HTML statiques, destinés à être lus par un programme. Ils suivent les mêmes règles que les exports 1.x et 2.x : un fichier par écran, 16 cadres (4 états × 4 tailles) et 1 cadre de survol, soit 102 cadres au total. Le style est celui de la version actuelle de l’app : logo AID, vert `#62D699`, barre latérale des sujets et panneau Mémoire.

| Fichier | Écran | Contenu |
|---|---|---|
| `html/aid-3-1-agents.html` | 3.1 Onglet Agents | terminal de l’agent (onglets, Arrêter, + Agent) et panneau Mémoire (Plan, Passation dev, Revue, Rétro) |
| `html/aid-3-2-git.html` | 3.2 Onglet Git | « où en es-tu », graphe des branches, liste des commits, détail du commit sélectionné |
| `html/aid-3-3-changer-de-branche.html` | 3.3 Changer de branche | sélecteur ancré sous la puce de branche, avec confirmation avant le changement |
| `html/aid-3-4-fichiers.html` | 3.4 Onglet Fichiers | explorateur du worktree avec statut git, visionneuse Markdown et sommaire |
| `html/aid-3-5-source.html` | 3.5 Fichier en source | même vue, fichier de code avec numéros de ligne |
| `html/aid-3-6-hors-branche.html` | 3.6 Worktree hors de la branche du sujet | bandeau de dérive, HEAD détachée (état empty) |
| `html/assets/aid-logo.png` | logo | à garder tel quel, référencé par `barre.logo` |

## Conventions (identiques aux exports 1.x et 2.x)

- **Cadre** : la racine porte `data-screen`, `data-state` (default, empty, loading, error, hover) et `data-viewport` (phone 390, tablet 834, desktop 1440, wide 1920). La hauteur suit le contenu. Le cadre `hover` fait 480 px et porte `data-viewport="desktop"`.
- **`data-node`** : `écran.zone.élément[.champ]`, l’écran s’écrit avec un tiret (`3-2.historique.commit-2.ref-1`). Chaque `data-node` est unique dans son cadre et identique sur les quatre tailles d’un même état : ce qui n’a pas la place est masqué en CSS, jamais retiré.
- **`data-bind`** : champ fourni par le daemon. **`data-action`** : intention déclenchée par un élément interactif. Les attributs complémentaires `data-hash`, `data-chemin`, `data-valeur`, `data-agent` et `data-ancre` portent le paramètre de l’action.
- **`data-layer="overlay"`** : l’infobulle des cadres hover, et le sélecteur de branche de 3.3. Le cadre 3.3 montre le sélecteur à sa place, sous l’en-tête. À l’implémentation, c’est une couche flottante ancrée sous `entete.branche` (environ 8 px plus bas, alignée à gauche, largeur 460 px maximum), qui se superpose à l’onglet courant.
- **Boutons désactivés** : l’attribut `disabled` porte la règle (« Pousser » quand rien n’est en avance). Une branche extraite ailleurs porte `aria-disabled="true"`.
- **Styles** : aucun attribut `style`, toutes les couleurs sont dans `:root`, Inter est la seule police, et les tailles se distinguent par `[data-viewport="…"]`.
- **Police du terminal** : la règle d’export impose Inter partout, y compris pour le terminal et le code. Dans l’app réelle, xterm.js et les blocs de code peuvent garder leur police monospace (comme sur la capture de la version actuelle).

## Tokens de couleur (`:root`)

- `--doc-bg: #050608`
- `--bg: #0D0F12`
- `--surface-1: #121418`
- `--surface-2: #15171C`
- `--surface-3: #1D2127`
- `--surface-4: #24292F`
- `--surface-term: #0A0C0E`
- `--line: #23282F`
- `--line-2: #2E343C`
- `--line-3: #1A1D22`
- `--text: #E6E8EB`
- `--text-fort: #F1F3F5`
- `--text-2: #D7DBE0`
- `--text-3: #C3C8CF`
- `--muted: #9CA3AE`
- `--faint: #6B7280`
- `--numero-ligne: #4B525C`
- `--acc: #62D699`
- `--acc-clair: #8BE6B5`
- `--acc-ink: #0D1A12`
- `--acc-soft: rgba(98, 214, 153, 0.14)`
- `--acc-trait: rgba(98, 214, 153, 0.55)`
- `--bleu: #6BA0F8`
- `--bleu-clair: #8DB6FA`
- `--bleu-bg: #18212E`
- `--bleu-soft: rgba(107, 160, 248, 0.16)`
- `--bleu-trait: rgba(107, 160, 248, 0.55)`
- `--violet: #C4A7FF`
- `--violet-soft: rgba(196, 167, 255, 0.14)`
- `--orange: #F2A93B`
- `--orange-soft: rgba(242, 169, 59, 0.12)`
- `--orange-line: #5A4520`
- `--ambre: #F2C27A`
- `--ambre-soft: rgba(242, 194, 122, 0.14)`
- `--rouge: #FF8A8A`
- `--rouge-soft: rgba(255, 107, 107, 0.14)`
- `--rouge-line: #4A2A2D`
- `--surface-erreur: #1C1416`
- `--point-inactif: #5A616C`
- `--point-daemon: #6EC08E`
- `--claude: #E8875B`
- `--ombre: rgba(0, 0, 0, 0.55)`
- `--squelette: #1D2127`
- `--squelette-2: #24292F`
- `--voie-0: #6BA0F8`
- `--voie-1: #62D699`
- `--voie-2: #C4A7FF`

## Graphe git (3.2, 3.6) : comment le reconstruire

Chaque ligne de commit mesure 32 px de haut. Elle contient un SVG de 72 × 32 (`viewBox="0 0 72 32"`) avec des tracés `path` et un nœud `circle`. Les coordonnées viennent de cet algorithme, à refaire côté client à partir de `git log --graph` ou des parents :

1. Chaque commit a une voie (`lane`) : 0 pour main (bleu `--voie-0`), 1 pour la branche du sujet (vert `--voie-1`), 2 pour les autres branches (violet `--voie-2`). Le centre de la voie est à x = 14 + voie × 18 ; le nœud est à y = 16.
2. Pour chaque arête commit → parent (le parent invisible est remplacé par son premier ancêtre visible) :
   - **même voie** : un trait vertical, du milieu au bas de la ligne du commit, sur toute la hauteur des lignes intermédiaires, puis du haut au milieu de la ligne du parent ;
   - **second parent d’une fusion** : une courbe `C` dans la ligne du commit, de son nœud vers le bas de la voie du parent, puis un trait vertical jusqu’au parent (couleur de la voie du parent) ;
   - **départ de branche** : un trait vertical sur la voie du commit jusqu’à la ligne au-dessus du parent, puis une courbe dans la ligne du parent, du haut de la voie vers le nœud du parent (couleur de la voie du commit).
3. Nœuds : HEAD a un anneau de rayon 8 (`.anneau`). Les modifications non commitées forment un nœud creux en pointillés (`.noeud--wip`) relié à HEAD par un trait pointillé.
4. Les commits absents de HEAD (non atteignables depuis HEAD) prennent `.commit--absent` (opacité 0,55).

## Visionneuse Markdown (3.4)

`visionneuse.document` reçoit le Markdown brut (`data-bind="fichier.contenu"`). Le rendu attendu est montré bloc par bloc (`data-type` = h1, h2, h3, paragraphe, liste, tableau, code, citation) :

- Les cases à cocher `- [x]` sont barrées et grisées.
- Le code en ligne, le gras et les liens sont stylés.
- Les blocs de code ont une barre avec la langue et un bouton Copier.
- Le sommaire reprend les titres de niveau 2 (`data-ancre`). Il est masqué sur téléphone et tablette.

## États empty et error

| Écran | empty | Second cas d’erreur (en plus du daemon injoignable) |
|---|---|---|
| 3.1 | aucun agent lancé | session claude perdue (code 137) |
| 3.2 | aucun commit depuis la base | dépôt verrouillé (.git/index.lock) |
| 3.3 | aucune branche ne correspond au filtre | git switch refusé (modifications locales écrasées) |
| 3.4 | aucun fichier modifié (filtre « Modifiés ») | fichier supprimé ou renommé pendant la lecture |
| 3.5 | fichier vide | fichier binaire ou trop gros |
| 3.6 | HEAD détachée | branche du sujet supprimée en local |

## Vocabulaire `data-action` (57)

actions.menu, agent.ajouter, agent.arreter, agent.journal, agent.lancer, agent.mentionner-fichier, agent.reprendre, branche.annuler, branche.changer, branche.changer-avec-stash, branche.choisir, branche.creer, branche.creer-ici, branche.filtrer, branche.ouvrir-selecteur, branche.recreer, branche.revenir, daemon.reconnecter, diff.ouvrir, diff.ouvrir-fichier, editeur.ouvrir, editeur.ouvrir-fichier, fichier.copier-chemin, fichier.reveler, fichiers.basculer, fichiers.filtrer, fichiers.ouvrir, fichiers.portee, fichiers.rafraichir, fichiers.replier, git.copier-hash, git.extraire, git.fetch, git.filtrer, git.portee, git.pousser, git.rafraichir, git.selectionner, git.voir-base, md.copier-code, memoire.onglet, nav.accueil, nav.boite, nav.consignes, nav.reglages, onglet.agents, onglet.fichiers, onglet.git, palette.ouvrir, sujet.creer, sujet.ouvrir, sujet.rattacher-branche, terminal.onglet, terminal.saisir, topic.sync, visionneuse.ancre, visionneuse.mode

## Vocabulaire `data-bind` (57)

action.commande, agent.absent, agent.debut, agent.envoi, agent.mention, agent.role, agent.statut, agent.type, branche.ancienne, branche.avance_retard, branche.cible, branche.dernier_push, branche.lien, branche.meta, branche.nom, branche.raison, branche.worktree, commit.auteur, commit.corps, commit.dans_head, commit.date, commit.hash, commit.message, commit.parents, commit.ref, commit.resume, daemon.etat, erreur.cause, fichier.ajouts, fichier.chemin, fichier.contenu, fichier.dernier_commit, fichier.etat, fichier.ligne, fichier.nettoyage, fichier.nom, fichier.portee, fichier.statut, fichier.suppressions, fichiers.modifies, fichiers.total, git.situation, git.stat, index.etat, memoire.texte, pty.taille, sujet.base, sujet.branche, sujet.etat, sujet.head, sujet.recalcul, sujet.slug, sujet.statut, sujet.titre, sujet.worktree, terminal.ligne, workspace.nom

## Cadres produits (102)

| # | Écran | État | Taille | Largeur |
|---|---|---|---|---|
| 1 | 3.1 Sujet · onglet Agents | default | phone | 390 px |
| 2 | 3.1 Sujet · onglet Agents | default | tablet | 834 px |
| 3 | 3.1 Sujet · onglet Agents | default | desktop | 1440 px |
| 4 | 3.1 Sujet · onglet Agents | default | wide | 1920 px |
| 5 | 3.1 Sujet · onglet Agents | empty | phone | 390 px |
| 6 | 3.1 Sujet · onglet Agents | empty | tablet | 834 px |
| 7 | 3.1 Sujet · onglet Agents | empty | desktop | 1440 px |
| 8 | 3.1 Sujet · onglet Agents | empty | wide | 1920 px |
| 9 | 3.1 Sujet · onglet Agents | loading | phone | 390 px |
| 10 | 3.1 Sujet · onglet Agents | loading | tablet | 834 px |
| 11 | 3.1 Sujet · onglet Agents | loading | desktop | 1440 px |
| 12 | 3.1 Sujet · onglet Agents | loading | wide | 1920 px |
| 13 | 3.1 Sujet · onglet Agents | error | phone | 390 px |
| 14 | 3.1 Sujet · onglet Agents | error | tablet | 834 px |
| 15 | 3.1 Sujet · onglet Agents | error | desktop | 1440 px |
| 16 | 3.1 Sujet · onglet Agents | error | wide | 1920 px |
| 17 | 3.1 Sujet · onglet Agents | hover | desktop (cadre réduit) | 480 px |
| 18 | 3.2 Sujet · onglet Git | default | phone | 390 px |
| 19 | 3.2 Sujet · onglet Git | default | tablet | 834 px |
| 20 | 3.2 Sujet · onglet Git | default | desktop | 1440 px |
| 21 | 3.2 Sujet · onglet Git | default | wide | 1920 px |
| 22 | 3.2 Sujet · onglet Git | empty | phone | 390 px |
| 23 | 3.2 Sujet · onglet Git | empty | tablet | 834 px |
| 24 | 3.2 Sujet · onglet Git | empty | desktop | 1440 px |
| 25 | 3.2 Sujet · onglet Git | empty | wide | 1920 px |
| 26 | 3.2 Sujet · onglet Git | loading | phone | 390 px |
| 27 | 3.2 Sujet · onglet Git | loading | tablet | 834 px |
| 28 | 3.2 Sujet · onglet Git | loading | desktop | 1440 px |
| 29 | 3.2 Sujet · onglet Git | loading | wide | 1920 px |
| 30 | 3.2 Sujet · onglet Git | error | phone | 390 px |
| 31 | 3.2 Sujet · onglet Git | error | tablet | 834 px |
| 32 | 3.2 Sujet · onglet Git | error | desktop | 1440 px |
| 33 | 3.2 Sujet · onglet Git | error | wide | 1920 px |
| 34 | 3.2 Sujet · onglet Git | hover | desktop (cadre réduit) | 480 px |
| 35 | 3.3 Changer de branche | default | phone | 390 px |
| 36 | 3.3 Changer de branche | default | tablet | 834 px |
| 37 | 3.3 Changer de branche | default | desktop | 1440 px |
| 38 | 3.3 Changer de branche | default | wide | 1920 px |
| 39 | 3.3 Changer de branche | empty | phone | 390 px |
| 40 | 3.3 Changer de branche | empty | tablet | 834 px |
| 41 | 3.3 Changer de branche | empty | desktop | 1440 px |
| 42 | 3.3 Changer de branche | empty | wide | 1920 px |
| 43 | 3.3 Changer de branche | loading | phone | 390 px |
| 44 | 3.3 Changer de branche | loading | tablet | 834 px |
| 45 | 3.3 Changer de branche | loading | desktop | 1440 px |
| 46 | 3.3 Changer de branche | loading | wide | 1920 px |
| 47 | 3.3 Changer de branche | error | phone | 390 px |
| 48 | 3.3 Changer de branche | error | tablet | 834 px |
| 49 | 3.3 Changer de branche | error | desktop | 1440 px |
| 50 | 3.3 Changer de branche | error | wide | 1920 px |
| 51 | 3.3 Changer de branche | hover | desktop (cadre réduit) | 480 px |
| 52 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | default | phone | 390 px |
| 53 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | default | tablet | 834 px |
| 54 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | default | desktop | 1440 px |
| 55 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | default | wide | 1920 px |
| 56 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | empty | phone | 390 px |
| 57 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | empty | tablet | 834 px |
| 58 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | empty | desktop | 1440 px |
| 59 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | empty | wide | 1920 px |
| 60 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | loading | phone | 390 px |
| 61 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | loading | tablet | 834 px |
| 62 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | loading | desktop | 1440 px |
| 63 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | loading | wide | 1920 px |
| 64 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | error | phone | 390 px |
| 65 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | error | tablet | 834 px |
| 66 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | error | desktop | 1440 px |
| 67 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | error | wide | 1920 px |
| 68 | 3.4 Sujet · onglet Fichiers (aperçu Markdown) | hover | desktop (cadre réduit) | 480 px |
| 69 | 3.5 Sujet · fichier en source | default | phone | 390 px |
| 70 | 3.5 Sujet · fichier en source | default | tablet | 834 px |
| 71 | 3.5 Sujet · fichier en source | default | desktop | 1440 px |
| 72 | 3.5 Sujet · fichier en source | default | wide | 1920 px |
| 73 | 3.5 Sujet · fichier en source | empty | phone | 390 px |
| 74 | 3.5 Sujet · fichier en source | empty | tablet | 834 px |
| 75 | 3.5 Sujet · fichier en source | empty | desktop | 1440 px |
| 76 | 3.5 Sujet · fichier en source | empty | wide | 1920 px |
| 77 | 3.5 Sujet · fichier en source | loading | phone | 390 px |
| 78 | 3.5 Sujet · fichier en source | loading | tablet | 834 px |
| 79 | 3.5 Sujet · fichier en source | loading | desktop | 1440 px |
| 80 | 3.5 Sujet · fichier en source | loading | wide | 1920 px |
| 81 | 3.5 Sujet · fichier en source | error | phone | 390 px |
| 82 | 3.5 Sujet · fichier en source | error | tablet | 834 px |
| 83 | 3.5 Sujet · fichier en source | error | desktop | 1440 px |
| 84 | 3.5 Sujet · fichier en source | error | wide | 1920 px |
| 85 | 3.5 Sujet · fichier en source | hover | desktop (cadre réduit) | 480 px |
| 86 | 3.6 Sujet · worktree hors de la branche du sujet | default | phone | 390 px |
| 87 | 3.6 Sujet · worktree hors de la branche du sujet | default | tablet | 834 px |
| 88 | 3.6 Sujet · worktree hors de la branche du sujet | default | desktop | 1440 px |
| 89 | 3.6 Sujet · worktree hors de la branche du sujet | default | wide | 1920 px |
| 90 | 3.6 Sujet · worktree hors de la branche du sujet | empty | phone | 390 px |
| 91 | 3.6 Sujet · worktree hors de la branche du sujet | empty | tablet | 834 px |
| 92 | 3.6 Sujet · worktree hors de la branche du sujet | empty | desktop | 1440 px |
| 93 | 3.6 Sujet · worktree hors de la branche du sujet | empty | wide | 1920 px |
| 94 | 3.6 Sujet · worktree hors de la branche du sujet | loading | phone | 390 px |
| 95 | 3.6 Sujet · worktree hors de la branche du sujet | loading | tablet | 834 px |
| 96 | 3.6 Sujet · worktree hors de la branche du sujet | loading | desktop | 1440 px |
| 97 | 3.6 Sujet · worktree hors de la branche du sujet | loading | wide | 1920 px |
| 98 | 3.6 Sujet · worktree hors de la branche du sujet | error | phone | 390 px |
| 99 | 3.6 Sujet · worktree hors de la branche du sujet | error | tablet | 834 px |
| 100 | 3.6 Sujet · worktree hors de la branche du sujet | error | desktop | 1440 px |
| 101 | 3.6 Sujet · worktree hors de la branche du sujet | error | wide | 1920 px |
| 102 | 3.6 Sujet · worktree hors de la branche du sujet | hover | desktop (cadre réduit) | 480 px |
